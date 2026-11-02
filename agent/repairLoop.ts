/**
 * The repair loop, with no Convex and no database in sight.
 *
 * It is the exact cycle that used to live inside `src/convex/agent.ts`, lifted
 * out unchanged in behaviour:
 *
 *   prompt → validated patch → real build → real compiler error → patch → build
 *   (max 3 attempts, then the run fails and nothing is claimed)
 *
 * Everything that touches persistence goes through `RepairLoopPorts`. The loop
 * itself never decides that a project is "verified": it records what a tool
 * reported, and the adapter stores that record. `verification`/`verdict` come
 * from the build result, never from the model's prose.
 */
import {
  MAX_REPAIR_ATTEMPTS,
  buildEvidenceSummary,
  formatBuildReport,
} from "../core/buildStatus";
import {
  dispatchBuild,
  notAvailableFromDispatch,
  resolveRunnerConfig,
} from "../core/buildDispatch";
import {
  finalizeRunRecord,
  runRecordReason,
  type DerivedRunRecord,
  type RunChange,
  type RunCriterion,
} from "../core/runRecord";
import { capSimulationLevel, deriveStatus, type Evidence } from "../core/verificationLevels";
import type { KbDocument } from "../core/knowledge";
import { formatSafetyReport } from "../core/safety";
import type { BuildResult } from "../core/types";
import type { ModelRuntime } from "./modelRuntime";
import { runAgentTurn, type TurnFile, type TurnOutcome, type TurnWrite } from "./turn";

/** Same budget the Convex action used: one job must not hang forever. */
export const DEFAULT_TIME_BUDGET_MS = 8 * 60 * 1000;

/** Evidence the loop asks the caller to persist. One entry per attempt/tool. */
export type RepairRunRecord =
  | { type: "retrieval"; summary: string; log: string }
  | { type: "safety"; verdict: "SUCCESS" | "FAILURE"; summary: string; log: string }
  | {
      type: "build";
      attempt: number;
      build: BuildResult;
      summary: string;
      patchSummary: string;
    };

/**
 * Persistence boundary. `applyWrites` must be all-or-nothing (the turn already
 * validated every write) and must return the project files as they are after
 * the write, because the next attempt sees exactly those bytes.
 */
export interface RepairRunRecorded extends DerivedRunRecord {
  /** True only when this run was explicitly simulated. */
  simulated: boolean;
  /**
   * Why the derived status is what it is. Computed from the record, never
   * accepted from the model; the future report uses this instead of prose.
   */
  reason: string;
}

export interface RepairLoopPorts {
  applyWrites(input: {
    writes: TurnWrite[];
    attempt: number;
    summary: string;
  }): Promise<TurnFile[]> | TurnFile[];
  record(run: RepairRunRecord): Promise<void> | void;
  /**
   * Final, validated record. It carries no stored level/verdict: both are
   * derived from the evidence accumulated during this loop.
   */
  recordRun?(run: RepairRunRecorded): Promise<void> | void;
  /**
   * Persist project/version state from a recording build only. The adapter must
   * derive it from `build.verification`/`build.verdict` (see
   * `isVerifiedSuccess`), never from the model text.
   */
  onBuildRecorded?(input: { attempt: number; build: BuildResult }): Promise<void> | void;
  /** Human-visible transcript. Never used to derive state. */
  say?(content: string, meta?: unknown): Promise<void> | void;
}

export interface RepairLoopRequest {
  project: {
    name: string;
    rtos: string;
    board?: string | null;
    mcu?: string | null;
    description?: string | null;
  };
  files: TurnFile[];
  userMessage: string;
  /** Static knowledge base documents (empty is valid: nothing is invented). */
  knowledge?: KbDocument[];
  /** Editable block names from the product profile. */
  anchors?: string[];
  /** Last real build evidence, used to start with context instead of guessing. */
  previousBuild?: BuildResult | null;
  maxAttempts?: number;
  timeBudgetMs?: number;
  env?: Record<string, string | undefined>;
  now?: () => number;
  log?: (line: string) => void;
  /** Product profile name and criteria, written into the run record. */
  profile?: string;
  /** Empty/absent is a real state: no criterion can reach `observed`. */
  criteria?: RunCriterion[];
  branch?: string | null;
  runId?: string;
  /** Selected from the profile by the orchestrator; absent uses llmClient. */
  modelRuntime?: ModelRuntime;
  /** Explicit demo/test simulation: evidence stays SIMULATED and level is capped. */
  simulated?: boolean;
}

export type RepairLoopStatus =
  | "ANSWER_ONLY"
  | "CHANGES_APPLIED"
  | "SUCCESS"
  | "BUILD_NOT_AVAILABLE";

export type RepairLoopFailureCode =
  | Extract<TurnOutcome, { ok: false }>["code"]
  | "REPAIR_LIMIT_REACHED"
  | "TIME_BUDGET_EXHAUSTED";

export type RepairLoopOutcome =
  | {
      ok: true;
      status: RepairLoopStatus;
      attempts: number;
      message: string;
      build: BuildResult | null;
      knowledge: string;
      applied?: string;
      files: TurnFile[];
    }
  | {
      ok: false;
      code: RepairLoopFailureCode;
      message: string;
      attempts: number;
      build: BuildResult | null;
      detail?: { path: string; code: string; reason: string }[];
      knowledge: string;
      files: TurnFile[];
    };

export type RepairLoopResult = RepairLoopOutcome & { runRecord: RepairRunRecorded };

interface RunAccumulator {
  startedAt: number | null;
  simulated: boolean;
  changes: Map<string, RunChange>;
  evidence: Evidence[];
  modelText: string | null;
}

function appliedSummaryFor(writes: TurnWrite[]): string {
  if (writes.length === 0) return "no file change";
  return `${writes.length} file(s) written (${writes.map((write) => write.path).join(", ")})`;
}

export async function runRepairLoop(
  request: RepairLoopRequest,
  ports: RepairLoopPorts,
): Promise<RepairLoopResult> {
  const accumulator: RunAccumulator = {
    startedAt: null,
    simulated: request.simulated ?? false,
    changes: new Map(),
    evidence: [],
    modelText: null,
  };
  const outcome = await runRepairLoopInternal(request, ports, accumulator);
  const startedAt = accumulator.startedAt ?? Date.now();
  if (outcome.build) {
    accumulator.evidence.push({
      level: "compiled",
      verification: accumulator.simulated ? "SIMULATED" : outcome.build.verification,
      verdict: outcome.build.verdict,
      at: startedAt,
      actor: "tool",
      actorId: outcome.build.toolchain ?? "build",
      tool: "build",
      detail: `${outcome.build.command ?? "build"} exit ${outcome.build.exitCode ?? "n/a"}`,
      criterion: null,
    });
  }
  const criteria = request.criteria?.map((criterion) => ({ ...criterion })) ?? [];
  const derived = finalizeRunRecord({
    id: request.runId ?? `run-${startedAt}`,
    createdAt: startedAt,
    profile: request.profile ?? request.project.name,
    request: request.userMessage,
    branch: request.branch ?? null,
    criteria,
    evidence: accumulator.evidence.map((entry) => ({ ...entry })),
    changes: [...accumulator.changes.values()].map((change) => ({ ...change })),
    modelText: accumulator.modelText,
  });
  const level = capSimulationLevel(derived.level, accumulator.simulated);
  const status = deriveStatus(derived.record.evidence, level);
  const runRecord: RepairRunRecorded = {
    record: derived.record,
    level,
    status,
    simulated: accumulator.simulated,
    reason: runRecordReason(derived.record, level, status),
  };
  await ports.recordRun?.(runRecord);
  return { ...outcome, runRecord };
}

async function runRepairLoopInternal(
  request: RepairLoopRequest,
  ports: RepairLoopPorts,
  accumulator: RunAccumulator,
): Promise<RepairLoopOutcome> {
  const env = request.env ?? process.env;
  const now = request.now ?? (() => Date.now());
  const log = request.log ?? (() => {});
  const startedAt = now();
  accumulator.startedAt ??= startedAt;
  const timeBudgetMs = request.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const maxAttempts = Math.min(Math.max(request.maxAttempts ?? MAX_REPAIR_ATTEMPTS, 1), 4);

  let files = request.files;
  let buildResult: BuildResult | null = null;
  let appliedSummary = "no file change";
  let knowledge = "";
  let attempt = 1;

  for (; attempt <= maxAttempts; attempt += 1) {
    if (now() - startedAt > timeBudgetMs) {
      const message = `## BUILD FAILED — REPAIR LIMIT REACHED\n\nThe time budget was exhausted after ${
        attempt - 1
      } attempt(s).`;
      await ports.say?.(message, { error: "TIME_BUDGET_EXHAUSTED", build: buildResult });
      return {
        ok: false,
        code: "TIME_BUDGET_EXHAUSTED",
        message,
        attempts: attempt - 1,
        build: buildResult,
        knowledge,
        files,
      };
    }

    const turn = await runAgentTurn({
      projectName: request.project.name,
      rtos: request.project.rtos,
      board: request.project.board ?? null,
      mcu: request.project.mcu ?? null,
      userMessage: request.userMessage,
      files,
      knowledge: request.knowledge ?? [],
      anchors: request.anchors ?? [],
      // Attempt 1 may reuse the last real build; later attempts use what this
      // loop just measured.
      buildResult: attempt > 1 ? buildResult : (request.previousBuild ?? null),
      attempt,
      env,
      modelRuntime: request.modelRuntime,
    });

    knowledge = turn.retrieval.log;
    const retrieval = turn.retrieval;
    await ports.record({
      type: "retrieval",
      log: retrieval.log,
      summary: `${retrieval.docs.length} fragment(s) injected (${retrieval.usedTokens}/${retrieval.budgetTokens} tokens)`,
    });

    if (!turn.ok) {
      await ports.say?.(turn.message, { error: turn.code, llmLog: log });
      return {
        ok: false,
        code: turn.code,
        message: turn.message,
        attempts: attempt,
        build: buildResult,
        detail: turn.detail,
        knowledge,
        files,
      };
    }

    accumulator.modelText = turn.summary;
    const hasWrites = turn.writes.length > 0;

    if (!hasWrites && !turn.requestBuild) {
      const message = turn.summary || "No change requested.";
      await ports.say?.(message, { answerOnly: true, kbLog: knowledge });
      return {
        ok: true,
        status: "ANSWER_ONLY",
        attempts: attempt,
        message,
        build: null,
        knowledge,
        files,
      };
    }

    if (hasWrites) {
      // All-or-nothing: the turn rejected the whole plan if one write was bad.
      files = await ports.applyWrites({
        writes: turn.writes,
        attempt,
        summary: turn.summary,
      });
      appliedSummary = appliedSummaryFor(turn.writes);
      for (const write of turn.writes) {
        const change: RunChange = {
          path: write.path,
          kind: write.kind,
          block: write.block,
        };
        accumulator.changes.set(`${change.kind}:${change.path}:${change.block ?? ""}`, change);
      }
      accumulator.evidence.push({
        level: "written",
        verification: accumulator.simulated ? "SIMULATED" : "REAL",
        verdict: "SUCCESS",
        at: startedAt,
        actor: "tool",
        actorId: "agent/applyWrites",
        tool: "applyWrites",
        detail: `attempt ${attempt}: ${appliedSummary}`,
        criterion: null,
      });

      const safety = turn.safety;
      await ports.record({
        type: "safety",
        verdict: safety.summary.fail > 0 ? "FAILURE" : "SUCCESS",
        log: formatSafetyReport(safety),
        summary: `${safety.summary.pass} PASS / ${safety.summary.warning} WARNING / ${safety.summary.fail} FAIL (${safety.engine})`,
      });
    }

    if (!turn.requestBuild) {
      await ports.say?.(`${turn.summary}\n\n_${appliedSummary}. No build requested._`, {
        applied: appliedSummary,
      });
      return {
        ok: true,
        status: "CHANGES_APPLIED",
        attempts: attempt,
        message: turn.summary,
        build: null,
        knowledge,
        applied: appliedSummary,
        files,
      };
    }

    // ---- real build ------------------------------------------------------
    const runner = resolveRunnerConfig(env);
    const dispatch = await dispatchBuild(
      runner,
      {
        projectName: request.project.name,
        rtos: request.project.rtos,
        board: request.project.board ?? null,
        files,
        attempt,
      },
      { log },
    );

    if (!dispatch.ok) {
      const build = notAvailableFromDispatch(dispatch.code, dispatch.message, attempt);
      await ports.record({
        type: "build",
        attempt,
        build,
        summary: `${build.verification} · ${build.verdict}`,
        patchSummary: appliedSummary,
      });
      await ports.onBuildRecorded?.({ attempt, build });

      const message = `**Build NOT AVAILABLE — \`${dispatch.code}\`**\n\n${dispatch.message}\n\nThe changes are saved but **not verified**: no compiler was invoked.\n${appliedSummary}`;
      await ports.say?.(message, { code: dispatch.code, build });
      return {
        ok: true,
        status: "BUILD_NOT_AVAILABLE",
        attempts: attempt,
        message,
        build,
        knowledge,
        applied: appliedSummary,
        files,
      };
    }

    buildResult = dispatch.result;
    await ports.record({
      type: "build",
      attempt,
      build: dispatch.result,
      summary: buildEvidenceSummary(dispatch.result),
      patchSummary: appliedSummary,
    });
    await ports.onBuildRecorded?.({ attempt, build: dispatch.result });

    if (dispatch.result.verdict === "SUCCESS") {
      const message = `## BUILD SUCCESS (real toolchain)\n\n${formatBuildReport(
        dispatch.result,
      )}\n\n### Change\n\n${turn.summary}\n\n${appliedSummary}`;
      await ports.say?.(message, { build: dispatch.result, llm: turn.llm });
      return {
        ok: true,
        status: "SUCCESS",
        attempts: attempt,
        message,
        build: dispatch.result,
        knowledge,
        applied: appliedSummary,
        files,
      };
    }

    log(
      `[repair] attempt ${attempt} failed with exit code ${dispatch.result.exitCode}; feeding compiler output to the model`,
    );
  }

  const usedAttempts = Math.min(attempt - 1, maxAttempts);
  const failureMessage = `## BUILD FAILED — REPAIR LIMIT REACHED\n\n${
    buildResult ? formatBuildReport(buildResult) : "No build result was produced."
  }\n\nThe project is left unverified. Attempts used: ${usedAttempts}/${maxAttempts}.`;

  await ports.say?.(failureMessage, {
    error: "REPAIR_LIMIT_REACHED",
    build: buildResult,
  });

  return {
    ok: false,
    code: "REPAIR_LIMIT_REACHED",
    message: failureMessage,
    attempts: usedAttempts,
    build: buildResult,
    knowledge,
    files,
  };
}
