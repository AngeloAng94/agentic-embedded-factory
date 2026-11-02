/**
 * Phase 6c orchestrator: the complete, measured cycle.
 *
 *   serial start → build → memory_map_check → flash gate → flash → observation
 *   → acceptance criteria → RunRecord/report
 *
 * It uses the same native primitives and gates as the MCP server:
 * `runBuild`, `checkMemoryMap`, `McpRunState.canFlash`, `runFlash`,
 * `SerialCaptureSession`, `runTargetTest` and the validated patch path from
 * `runAgentTurn`. The hardware-facing functions are injectable only for tests;
 * the production defaults are those shared functions.
 *
 * Repair has two rings:
 *   1. `agent/deterministicRepair.ts`, always through `applyBlockEdits`;
 *   2. `runAgentTurn`, with the real compiler/linker error and known issues.
 */
import path from "node:path";
import {
  DEFAULT_RUN_FLASH_BUDGET,
  DEFAULT_RUN_TIME_BUDGET_MS,
  profileCriteria,
  type ProductProfile,
} from "../core/profile";
import {
  deriveStatus,
  capSimulationLevel,
  levelRank,
  type Evidence,
} from "../core/verificationLevels";
import { finalizeRunRecord, runRecordReason, type RunChange } from "../core/runRecord";
import { realResult, notAvailable as buildNotAvailable } from "../core/buildStatus";
import type { BuildResult, Verdict } from "../core/types";
import type { ExecResult } from "../tools/exec";
import type { ToolOutcome } from "../core/toolResult";
import { notAvailable } from "../core/toolResult";
import { findElfArtifact, runBuild } from "../tools/build";
import { checkMemoryMap, type MemoryMapReport } from "../tools/memoryMap";
import { McpRunState } from "../tools/mcp/runState";
import { runFlash } from "../tools/flash";
import {
  createSerialBackend,
  SerialCaptureSession,
  type SerialBackend,
  type SerialCaptureResult,
  type SerialCaptureStatus,
} from "../tools/serialCapture";
import { runTargetTest } from "../tools/targetTest";
import type { KbDocument } from "../core/knowledge";
import { createModelRuntimeFromProfile, type ModelRuntime } from "./modelRuntime";
import { runAgentTurn, type TurnFile, type TurnWrite } from "./turn";
import {
  deterministicRepair,
  matchKnownIssues,
  parseCompilerDiagnostics,
  type KnownIssue,
} from "./deterministicRepair";
import {
  criterionOutcomesFromRecord,
  formatRunReport,
  type CriterionOutcome,
} from "./runReport";
import type { RepairRunRecorded } from "./repairLoop";

export interface OrchestratorProject {
  name: string;
  rtos: string;
  board?: string | null;
  mcu?: string | null;
  description?: string | null;
}

export interface BuildOutcome {
  result: BuildResult;
  artifactPath: string | null;
}

export interface BuildToolInput {
  files: readonly TurnFile[];
  cwd: string;
  attempt: number;
  /** Remaining total time budget, passed to the process timeout. */
  timeoutMs: number;
}

export interface OrchestratorTools {
  build(input: BuildToolInput): Promise<BuildOutcome> | BuildOutcome;
  memoryMap(input: { artifactPath: string }): Promise<ToolOutcome<MemoryMapReport>> | ToolOutcome<MemoryMapReport>;
  flash(input: {
    artifactPath: string;
    cwd: string;
    timeoutMs: number;
  }): Promise<ToolOutcome<ExecResult>> | ToolOutcome<ExecResult>;
  targetTest(): Promise<ToolOutcome<{ passed: boolean }>> | ToolOutcome<{ passed: boolean }>;
}

export interface OrchestratorPorts {
  applyWrites?(input: {
    writes: TurnWrite[];
    attempt: number;
    summary: string;
  }): Promise<TurnFile[]> | TurnFile[];
  recordRun?(run: RepairRunRecorded): Promise<void> | void;
  say?(content: string, meta?: unknown): Promise<void> | void;
}

export interface OrchestratorRequest {
  profile: ProductProfile;
  project: OrchestratorProject;
  files: TurnFile[];
  userMessage: string;
  /** Directory where the real build/flash commands run. Defaults to cwd. */
  projectDir?: string;
  knowledge?: KbDocument[];
  anchors?: string[];
  /** Test/runtime override; production selects the provider from the profile. */
  modelRuntime?: ModelRuntime;
  /** Environment for provider/serial selection in tests. */
  env?: Record<string, string | undefined>;
  /** Exact-text known issues to put in the model context. */
  knownIssues?: KnownIssue[];
  branch?: string | null;
  runId?: string;
  maxAttempts?: number;
  /** Test seam: a short observation window after flash, before serial stop. */
  observationWaitMs?: number;
  /** Test-only injected toolchain; omitted defaults use the shared tools. */
  tools?: Partial<OrchestratorTools>;
  serialSession?: SerialCaptureSession;
  /** Explicit test/demo simulation: evidence is SIMULATED and capped. */
  simulated?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export type OrchestratorCode =
  | "SUCCESS"
  | "NO_CRITERIA"
  | "OBSERVATION_INCOMPLETE"
  | "CRITERIA_FAILED"
  | "BUILD_FAILED"
  | "BUILD_NOT_AVAILABLE"
  | "NO_ARTIFACT"
  | "MEMORY_MAP_FAILED"
  | "FLASH_GATE_REFUSED"
  | "FLASH_FAILED"
  | "FLASH_BUDGET_EXCEEDED"
  | "TIME_BUDGET_EXCEEDED"
  | "REPAIR_LIMIT_REACHED"
  | "MODEL_FAILED"
  | "INTERNAL_ERROR";

export interface OrchestratorResult {
  ok: boolean;
  code: OrchestratorCode;
  reason: string;
  runRecord: RepairRunRecorded;
  report: string;
  criterionOutcomes: CriterionOutcome[];
  files: TurnFile[];
  build: BuildResult | null;
  artifact: string | null;
  serial: SerialCaptureResult | null;
  serialStatus: SerialCaptureStatus;
  attempts: number;
  flashes: number;
}

function cloneFiles(files: readonly TurnFile[]): TurnFile[] {
  return files.map((file) => ({ ...file }));
}

function mergeWrites(files: readonly TurnFile[], writes: readonly TurnWrite[]): TurnFile[] {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  for (const write of writes) byPath.set(write.path, write.content);
  return [...byPath.entries()].map(([filePath, content]) => ({ path: filePath, content }));
}

function writeForBlock(block: {
  path: string;
  block: string;
  content: string;
  previousContent: string;
}): TurnWrite {
  return {
    path: block.path,
    content: block.content,
    previousContent: block.previousContent,
    patch: null,
    kind: "block-edit",
    block: block.block,
  };
}

function changeKey(change: RunChange): string {
  return `${change.kind}:${change.path}:${change.block ?? ""}`;
}

function memEvidence(
  verification: Evidence["verification"],
  verdict: Verdict,
  at: number,
  actorId: string,
  tool: string,
  detail: string,
  criterion: string | null = null,
): Evidence {
  return {
    level: "compiled",
    verification,
    verdict,
    at,
    actor: "tool",
    actorId,
    tool,
    detail,
    criterion,
  };
}

function execToBuild(
  exec: ExecResult,
  attempt: number,
  artifactPath: string | null,
  cwd: string,
): BuildResult {
  const relative = artifactPath ? path.relative(cwd, artifactPath).split(path.sep).join("/") : null;
  const result =
    exec.exitCode === null
      ? (() => {
          const unavailable = buildNotAvailable(
            exec.timedOut ? "build timed out" : "build process did not return an exit code",
            exec.display,
          );
          unavailable.attempt = attempt;
          return unavailable;
        })()
      : realResult({
          command: exec.display,
          exitCode: exec.exitCode,
          durationMs: exec.durationMs,
          stdout: exec.stdout,
          stderr: exec.stderr,
          artifacts: relative ? [relative] : [],
          attempt,
        });
  result.attempt = attempt;
  return result;
}

function defaultTools(profile: ProductProfile): OrchestratorTools {
  return {
    build: async (input) => {
      try {
        const built = runBuild(profile, {
          cwd: input.cwd,
          timeoutMs: Math.max(1_000, input.timeoutMs),
        });
        if (!built.ok) {
          const result = buildNotAvailable(built.reason, null);
          result.attempt = input.attempt;
          return { result, artifactPath: null };
        }
        const artifact = findElfArtifact(input.cwd);
        const result = execToBuild(built.value, input.attempt, artifact, input.cwd);
        return { result, artifactPath: result.verdict === "SUCCESS" ? artifact : null };
      } catch (error) {
        const result = buildNotAvailable(
          `build could not be started: ${error instanceof Error ? error.message : String(error)}`,
          null,
        );
        result.attempt = input.attempt;
        return { result, artifactPath: null };
      }
    },
    memoryMap: ({ artifactPath }) => checkMemoryMap(profile, { artifactPath }),
    flash: ({ artifactPath, cwd, timeoutMs }) =>
      runFlash(profile, artifactPath, { cwd, timeoutMs: Math.max(1_000, timeoutMs) }),
    targetTest: () => runTargetTest(null),
  };
}

function defaultSerialSession(profile: ProductProfile, projectDir: string): SerialCaptureSession {
  const backend = createSerialBackend(profile, { cwd: projectDir });
  if (backend.ok) return new SerialCaptureSession(backend.value);
  const unavailable: SerialBackend = {
    simulated: false,
    start: () => backend,
  };
  return new SerialCaptureSession(unavailable);
}

function knownIssuesContext(
  errorText: string,
  knownIssues: readonly KnownIssue[] | undefined,
): string {
  const matches = matchKnownIssues(errorText, knownIssues);
  if (matches.length === 0) return "";
  return matches
    .map((issue) => `Known issue matching exact error "${issue.error}":\n${issue.hint}`)
    .join("\n\n");
}

/**
 * Runs the Phase 6c cycle. It stops at the first unproven step and still emits
 * a complete RunRecord: a missing tool never becomes a success.
 */
export async function runOrchestrator(
  request: OrchestratorRequest,
  ports: OrchestratorPorts = {},
): Promise<OrchestratorResult> {
  const profile = request.profile;
  const projectDir = path.resolve(request.projectDir ?? process.cwd());
  const now = request.now ?? Date.now;
  const log = request.log ?? (() => {});
  const startedAt = now();
  const budget = profile.budget ?? {
    tempo_totale_ms: DEFAULT_RUN_TIME_BUDGET_MS,
    flash_max: DEFAULT_RUN_FLASH_BUDGET,
  };
  const maxAttempts = Math.min(Math.max(request.maxAttempts ?? profile.tentativi_max, 1), 10);
  const anchors = request.anchors ?? [...profile.ancore];
  const criteria = profileCriteria(profile);
  const simulated = request.simulated ?? false;
  const tools = defaultTools(profile);
  if (request.tools?.build) tools.build = request.tools.build;
  if (request.tools?.memoryMap) tools.memoryMap = request.tools.memoryMap;
  if (request.tools?.flash) tools.flash = request.tools.flash;
  if (request.tools?.targetTest) tools.targetTest = request.tools.targetTest;
  const serial =
    request.serialSession ?? defaultSerialSession(profile, projectDir);

  let files = cloneFiles(request.files);
  const changes = new Map<string, RunChange>();
  const evidence: Evidence[] = [];
  let build: BuildResult | null = null;
  let artifact: string | null = null;
  let attempts = 0;
  let flashes = 0;
  let serialResult: SerialCaptureResult | null = null;
  let serialVerification: "REAL" | "SIMULATED" = "REAL";
  let serialReason: string | null = null;
  let serialStarted = serial.running;
  let stopReason = "";
  let code: OrchestratorCode = "REPAIR_LIMIT_REACHED";
  let modelText: string | null = null;
  let modelRuntime: ModelRuntime | null = request.modelRuntime ?? null;
  let buildSucceeded = false;
  let mapReport: MemoryMapReport | null = null;
  let memoryMapFailure: Evidence | null = null;
  let flashSucceeded = false;

  const timeExceeded = () => now() - startedAt > budget.tempo_totale_ms;
  const remainingMs = () => Math.max(1_000, budget.tempo_totale_ms - (now() - startedAt));
  const budgetReason = () =>
    `time budget exceeded: the run used more than ${budget.tempo_totale_ms} ms`;

  const addChange = (change: RunChange) => {
    changes.set(changeKey(change), change);
  };

  const addWrittenEvidence = (detail: string) => {
    evidence.push({
      level: "written",
      verification: simulated ? "SIMULATED" : "REAL",
      verdict: "SUCCESS",
      at: now(),
      actor: "tool",
      actorId: "orchestrator/applyWrites",
      tool: "applyWrites",
      detail,
      criterion: null,
    });
  };

  const applyWrites = async (
    writes: TurnWrite[],
    attempt: number,
    summary: string,
  ): Promise<TurnFile[]> => {
    const next = ports.applyWrites
      ? await ports.applyWrites({ writes, attempt, summary })
      : mergeWrites(files, writes);
    for (const write of writes) {
      addChange({
        path: write.path,
        kind: write.kind,
        block: write.block,
      });
    }
    addWrittenEvidence(`attempt ${attempt}: ${writes.length} file(s) written`);
    return next;
  };

  const getRuntime = (): ModelRuntime | null => {
    if (modelRuntime) return modelRuntime;
    const selected = createModelRuntimeFromProfile(profile, { env: request.env });
    if (!selected.ok) {
      stopReason = `model runtime unavailable: ${selected.message}`;
      code = "MODEL_FAILED";
      return null;
    }
    modelRuntime = selected.runtime;
    return modelRuntime;
  };

  try {
    if (!serialStarted) {
      const started = serial.start();
      if (!started.ok) {
        serialReason = `serial capture unavailable: ${started.reason}`;
        log(`[orchestrator] ${serialReason}`);
      } else {
        serialStarted = true;
        serialVerification = started.verification;
      }
    } else {
      serialVerification = serial.getStatus().verification;
    }

    const attemptedDiagnostics = new Set<string>();
    const attemptedSymbols: string[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (timeExceeded()) {
        stopReason = budgetReason();
        code = "TIME_BUDGET_EXCEEDED";
        break;
      }
      attempts = attempt;

      let built: BuildOutcome;
      try {
        built = await tools.build({
          files,
          cwd: projectDir,
          attempt,
          timeoutMs: remainingMs(),
        });
      } catch (error) {
        built = {
          result: (() => {
            const result = buildNotAvailable(
              `build could not be started: ${error instanceof Error ? error.message : String(error)}`,
            );
            result.attempt = attempt;
            return result;
          })(),
          artifactPath: null,
        };
      }

      build = { ...built.result, attempt };
      artifact = built.artifactPath ? path.resolve(projectDir, built.artifactPath) : null;
      if (build.verification === "REAL" && build.verdict === "SUCCESS" && artifact) {
        buildSucceeded = true;
        break;
      }

      if (build.verification !== "REAL") {
        stopReason = `build is ${build.verification}: ${build.reason ?? "no real compiler result"}`;
        code = "BUILD_NOT_AVAILABLE";
        break;
      }

      if (build.verdict === "SUCCESS" && !artifact) {
        build = { ...build, verdict: "UNKNOWN", reason: "the build succeeded but produced no ELF artifact" };
        stopReason = build.reason!;
        code = "NO_ARTIFACT";
        break;
      }

      const errorText = `${build.stderr}\n${build.stdout}`;
      const diagnostics = parseCompilerDiagnostics(build.stderr, build.stdout);
      const diagnostic = diagnostics[0] ?? null;
      let parserReason: string | null = null;

      if (diagnostic) {
        const key = `${diagnostic.kind}:${diagnostic.name ?? diagnostic.raw}`;
        if (!attemptedDiagnostics.has(key)) {
          attemptedDiagnostics.add(key);
          const fix = deterministicRepair({
            files,
            anchors,
            diagnostics,
            attemptedSymbols,
          });
          if (fix.applied) {
            log(`[orchestrator] deterministic repair: ${fix.reason}`);
            files = await applyWrites(
              fix.appliedBlocks.map(writeForBlock),
              attempt,
              fix.reason,
            );
            if (fix.kind === "undefined-symbol" && fix.diagnostic?.name) {
              attemptedSymbols.push(fix.diagnostic.name);
            }
            modelText = fix.reason;
            continue;
          }
          parserReason = fix.reason;
          log(`[orchestrator] deterministic repair refused: ${fix.reason}`);
        } else {
          parserReason = "the deterministic repair for this error was already attempted";
        }
      } else {
        parserReason = "no recognized compiler/linker error for a deterministic repair";
      }

      if (attempt >= maxAttempts) {
        stopReason = `repair limit reached after ${attempt} build attempt(s)`;
        code = "REPAIR_LIMIT_REACHED";
        break;
      }
      if (timeExceeded()) {
        stopReason = budgetReason();
        code = "TIME_BUDGET_EXCEEDED";
        break;
      }

      const runtime = getRuntime();
      if (!runtime) break;

      const known = knownIssuesContext(errorText, request.knownIssues);
      const repairContext = [parserReason, known].filter((entry): entry is string => Boolean(entry)).join("\n\n");
      const turn = await runAgentTurn({
        projectName: request.project.name,
        rtos: request.project.rtos,
        board: request.project.board ?? null,
        mcu: request.project.mcu ?? null,
        userMessage: request.userMessage,
        files,
        knowledge: request.knowledge ?? [],
        anchors,
        buildResult: build,
        attempt: attempt + 1,
        env: request.env,
        modelRuntime: runtime,
        repairContext,
      });
      if (!turn.ok) {
        stopReason = `${turn.code}: ${turn.message}`;
        code = "MODEL_FAILED";
        break;
      }
      modelText = turn.summary;
      if (turn.writes.length === 0) {
        stopReason = "the model returned no validated patch to rebuild";
        code = "MODEL_FAILED";
        break;
      }
      files = await applyWrites(turn.writes, attempt, turn.summary);
    }

    if (!buildSucceeded) {
      if (!stopReason) {
        stopReason = `repair limit reached after ${attempts} build attempt(s)`;
        code = "REPAIR_LIMIT_REACHED";
      }
      // The final failed build is evidence; previous failed attempts are not
      // recorded, so a successful repair cannot leave a stale FAILURE behind.
      if (build) {
        evidence.push(
          memEvidence(
            simulated ? "SIMULATED" : build.verification,
            build.verdict,
            now(),
            build.toolchain ?? "build",
            "build",
            build.reason ?? build.command ?? "build failed",
          ),
        );
      }
    } else {
      evidence.push(
        memEvidence(
          simulated ? "SIMULATED" : "REAL",
          "SUCCESS",
          now(),
          build?.toolchain ?? "build",
          "build",
          build?.command ?? "build succeeded",
        ),
      );
    }

    if (buildSucceeded && artifact && criteria.length > 0) {
      if (timeExceeded()) {
        stopReason = budgetReason();
        code = "TIME_BUDGET_EXCEEDED";
      } else {
        let checked: ToolOutcome<MemoryMapReport>;
        try {
          checked = await tools.memoryMap({ artifactPath: artifact });
        } catch (error) {
          checked = notAvailable(
            `memory_map_check could not run: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!checked.ok) {
          mapReport = null;
          memoryMapFailure = memEvidence(
            simulated ? "SIMULATED" : "NOT_AVAILABLE",
            "UNKNOWN",
            now(),
            "orchestrator/memory_map",
            "memory_map_check",
            checked.reason,
          );
          stopReason = `memory_map_check failed: ${checked.reason}`;
          code = "MEMORY_MAP_FAILED";
        } else {
          mapReport = checked.value;
          if (mapReport.verdict !== "SUCCESS") {
            memoryMapFailure = memEvidence(
              simulated ? "SIMULATED" : "REAL",
              "FAILURE",
              now(),
              "orchestrator/memory_map",
              "memory_map_check",
              `memory map verdict ${mapReport.verdict}`,
            );
            stopReason = `memory_map_check verdict ${mapReport.verdict}`;
            code = "MEMORY_MAP_FAILED";
          }
        }

        if (mapReport && mapReport.verdict === "SUCCESS") {
          const gate = new McpRunState(profile);
          gate.recordMemoryMap(mapReport);
          const flashGate = gate.canFlash(artifact);
          if (!flashGate.ok) {
            memoryMapFailure = memEvidence(
              simulated ? "SIMULATED" : "NOT_AVAILABLE",
              "UNKNOWN",
              now(),
              "orchestrator/flash-gate",
              "flash",
              flashGate.reason,
            );
            stopReason = flashGate.reason;
            code = "FLASH_GATE_REFUSED";
          } else if (flashes >= budget.flash_max) {
            stopReason = `flash budget exceeded: maximum ${budget.flash_max} flash operation(s) per run`;
            code = "FLASH_BUDGET_EXCEEDED";
          } else if (timeExceeded()) {
            stopReason = budgetReason();
            code = "TIME_BUDGET_EXCEEDED";
          } else {
            flashes += 1;
            {
              let flashed: ToolOutcome<ExecResult>;
              try {
                flashed = await tools.flash({
                  artifactPath: flashGate.flashPath,
                  cwd: projectDir,
                  timeoutMs: remainingMs(),
                });
              } catch (error) {
                flashed = notAvailable(
                  `flash could not run: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
              if (!flashed.ok) {
                evidence.push({
                  level: "flashed",
                  verification: simulated ? "SIMULATED" : "NOT_AVAILABLE",
                  verdict: "UNKNOWN",
                  at: now(),
                  actor: "tool",
                  actorId: "orchestrator/flash",
                  tool: "flash",
                  detail: flashed.reason,
                  criterion: null,
                });
                stopReason = `flash failed: ${flashed.reason}`;
                code = "FLASH_FAILED";
              } else if (flashed.value.exitCode !== 0) {
                evidence.push({
                  level: "flashed",
                  verification: simulated ? "SIMULATED" : "REAL",
                  verdict: "FAILURE",
                  at: now(),
                  actor: "tool",
                  actorId: "orchestrator/flash",
                  tool: "flash",
                  detail: `flash exit ${flashed.value.exitCode ?? "unknown"}`,
                  criterion: null,
                });
                stopReason = `flash exited with ${flashed.value.exitCode ?? "unknown"}`;
                code = "FLASH_FAILED";
              } else {
                flashSucceeded = true;
                if (serialStarted) serial.noteFlash();
                evidence.push({
                  level: "flashed",
                  verification: simulated ? "SIMULATED" : "REAL",
                  verdict: "SUCCESS",
                  at: now(),
                  actor: "tool",
                  actorId: "orchestrator/flash",
                  tool: "flash",
                  detail: `flash succeeded for sha256 ${flashGate.sha256}`,
                  criterion: null,
                });
              }
            }
          }
        }
      }
    }

    // Observation is meaningful only after a successful flash. Stop the capture
    // that was started before the build/flash, then evaluate the real text.
    if (flashSucceeded) {
      if (request.observationWaitMs && request.observationWaitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, request.observationWaitMs));
      }
      if (serial.running) {
        const stopped = await serial.stop();
        if (stopped.ok) {
          serialResult = stopped.value;
          serialVerification = stopped.verification;
        } else {
          serialReason = `serial capture could not be stopped: ${stopped.reason}`;
        }
      }

      const captureComplete = serialResult?.complete === true;
      const captureDetail = captureComplete
        ? "serial capture complete"
        : serialReason ??
          serialResult?.reason ??
          "serial capture was not started before flash, so it is incomplete";

      for (let index = 0; index < profile.criteri.length; index += 1) {
        const criterion = profile.criteri[index]!;
        const id = criteria[index]!.id;
        if ("seriale_contiene" in criterion || "log_non_contiene" in criterion) {
          if (!serialResult || !serialResult.complete) {
            evidence.push({
              level: "observed",
              verification: simulated ? "SIMULATED" : "NOT_AVAILABLE",
              verdict: "UNKNOWN",
              at: now(),
              actor: "tool",
              actorId: "orchestrator/serial",
              tool: "serial_capture",
              detail: `${captureDetail}; criterion not evaluated`,
              criterion: id,
            });
            continue;
          }
          const captured = serialResult;
          const matches =
            "seriale_contiene" in criterion
              ? captured.text.includes(criterion.seriale_contiene)
              : !criterion.log_non_contiene.some((forbidden) => captured.text.includes(forbidden));
          evidence.push({
            level: "observed",
            verification: simulated ? "SIMULATED" : serialVerification,
            verdict: matches ? "SUCCESS" : "FAILURE",
            at: now(),
            actor: "tool",
            actorId: "orchestrator/serial",
            tool: "serial_capture",
            detail:
              "seriale_contiene" in criterion
                ? `serial contains ${JSON.stringify(criterion.seriale_contiene)}: ${matches}`
                : `serial avoids ${criterion.log_non_contiene.map((item) => JSON.stringify(item)).join(", ")}: ${matches}`,
            criterion: id,
          });
          continue;
        }

        let tested: ToolOutcome<{ passed: boolean }>;
        try {
          tested = await tools.targetTest();
        } catch (error) {
          tested = notAvailable(
            `on-target test could not run: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!tested.ok) {
          evidence.push({
            level: "observed",
            verification: simulated ? "SIMULATED" : "NOT_AVAILABLE",
            verdict: "UNKNOWN",
            at: now(),
            actor: "tool",
            actorId: "orchestrator/target-test",
            tool: "target_test",
            detail: `${tested.reason}; criterion not evaluated`,
            criterion: id,
          });
          continue;
        }
        evidence.push({
          level: "observed",
          verification: simulated ? "SIMULATED" : tested.verification,
          verdict: tested.value.passed ? "SUCCESS" : "FAILURE",
          at: now(),
          actor: "tool",
          actorId: "orchestrator/target-test",
          tool: "target_test",
          detail: tested.value.passed ? "on-target test passed" : "on-target test failed",
          criterion: id,
        });
      }
    }
  } catch (error) {
    stopReason = `orchestrator error: ${error instanceof Error ? error.message : String(error)}`;
    code = "INTERNAL_ERROR";
  } finally {
    if (serial.running) {
      const stopped = await serial.stop();
      if (stopped.ok) {
        serialResult = stopped.value;
        serialVerification = stopped.verification;
      } else if (!serialReason) {
        serialReason = `serial capture could not be stopped: ${stopped.reason}`;
      }
    }
  }

  if (memoryMapFailure && !evidence.includes(memoryMapFailure)) {
    evidence.push(memoryMapFailure);
  }

  // Observation and the tools around it also consume the total budget.
  if (!stopReason && timeExceeded()) {
    stopReason = budgetReason();
    code = "TIME_BUDGET_EXCEEDED";
  }

  // Without acceptance criteria there is nothing to observe: stop at the
  // compiled artifact instead of flashing hardware for an unverifiable run.
  if (!stopReason && buildSucceeded && criteria.length === 0) {
    stopReason = "the profile declares no acceptance criteria; no flash or observation was attempted";
    code = "NO_CRITERIA";
  }

  const derived = finalizeRunRecord({
    id: request.runId ?? `run-${startedAt}`,
    createdAt: startedAt,
    profile: request.profile.prodotto,
    request: request.userMessage,
    branch: request.branch ?? null,
    criteria,
    evidence,
    changes: [...changes.values()],
    modelText,
  });
  const simulatedLevel = capSimulationLevel(derived.level, simulated);
  const level =
    criteria.length === 0 && simulatedLevel !== null && levelRank(simulatedLevel) > levelRank("compiled")
      ? "compiled"
      : simulatedLevel;
  const status = deriveStatus(derived.record.evidence, level);

  // Build evidence was pushed before the map check, so a map failure follows it.
  if (buildSucceeded && flashSucceeded && !stopReason) {
    const observed = evidence.filter((entry) => entry.level === "observed");
    if (criteria.length === 0) {
      stopReason = "the profile declares no acceptance criteria; the verdict remains UNKNOWN";
      code = "NO_CRITERIA";
    } else if (observed.some((entry) => entry.verdict === "FAILURE")) {
      const failed = observed.filter((entry) => entry.verdict === "FAILURE").map((entry) => entry.criterion);
      stopReason = `acceptance criteria failed: ${failed.join(", ")}`;
      code = "CRITERIA_FAILED";
    } else {
      const outcomes = criterionOutcomesFromRecord(
        finalizeRunRecord({
          id: request.runId ?? `run-${startedAt}`,
          createdAt: startedAt,
          profile: request.profile.prodotto,
          request: request.userMessage,
          branch: request.branch ?? null,
          criteria,
          evidence,
          changes: [...changes.values()],
          modelText,
        }).record,
      );
      if (outcomes.every((outcome) => outcome.status === "PASS") && level === "observed") {
        code = "SUCCESS";
        stopReason = "";
      } else {
        stopReason = `${
          serialResult?.reason ??
          serialReason ??
          "a criterion has no REAL observed evidence"
        }; observed was not reached`;
        code = "OBSERVATION_INCOMPLETE";
      }
    }
  }

  if (!stopReason) {
    if (code === "SUCCESS") stopReason = "all acceptance criteria passed on real evidence";
    else if (code === "FLASH_BUDGET_EXCEEDED") stopReason = "flash budget exceeded";
    else stopReason = "the run stopped before a verified result";
  }

  const baseReason = runRecordReason(derived.record, level, status);
  const reason =
    stopReason && baseReason !== stopReason ? `${baseReason} ${stopReason}` : baseReason;
  const runRecord: RepairRunRecorded = {
    record: derived.record,
    level,
    status,
    simulated,
    reason,
  };
  const report = formatRunReport(derived.record, level, status, reason);
  const criterionOutcomes = criterionOutcomesFromRecord(derived.record);
  await ports.recordRun?.(runRecord);
  await ports.say?.(report, { code, level, status });

  return {
    ok: code === "SUCCESS",
    code,
    reason,
    runRecord,
    report,
    criterionOutcomes,
    files,
    build,
    artifact,
    serial: serialResult,
    serialStatus: serial.getStatus(),
    attempts,
    flashes,
  };
}
