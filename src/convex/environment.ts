import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireOwnedProject, requireUserId } from "./lib/auth";
import {
  DEFAULT_REFERENCE_BOARD,
  boardStateFor,
  buildStateFor,
  environmentStatus,
  freertosStatus,
  resolveLlmStatus,
  resolveRunnerStatus,
  zephyrStatusUnavailable,
  type EnvironmentStatus,
  type LlmStatus,
  type ProjectEnvironmentStatus,
  type RtosStatus,
  type RunnerStatus,
} from "../lib/core/environmentStatus";

/**
 * Environment control plane — the read side.
 *
 * Nothing here probes anything: a Convex function cannot spawn `west`/`cmake`.
 * This module only *normalizes* two real sources through the shared core model:
 *
 *   1. the server environment (`process.env`), resolved by `resolveLlmConfig` /
 *      `resolveRunnerConfig` — secrets are never read back out;
 *   2. the last real probe persisted by `environmentActions.ts`, which talks to
 *      the build runner (`GET /health`, `GET /doctor`) and stores only
 *      non-secret evidence.
 *
 * A stored answer is only reused while it still describes the configuration it
 * probed (`environmentStatus.resolve*Status` enforces that), so a stale
 * CONNECTED can never be displayed after the configuration changed.
 */

/** Persisted Zephyr evidence: the status plus the runner that produced it. */
export interface ZephyrRecord {
  runnerUrl: string | null;
  status: RtosStatus;
}

function readJson<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as T;
  } catch {
    return null;
  }
}

function isRtosStatus(value: unknown): value is RtosStatus {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (record.rtos === "zephyr" || record.rtos === "freertos") &&
    typeof record.state === "string" &&
    typeof record.buildCapability === "string" &&
    Array.isArray(record.checks) &&
    Array.isArray(record.diagnostics)
  );
}

async function latestChecks(ctx: QueryCtx, userId: Id<"users">) {
  const rows = await ctx.db
    .query("environmentChecks")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .order("desc")
    .take(1);
  return rows[0] ?? null;
}

/**
 * Zephyr evidence is only valid for the runner that produced it. If the runner
 * changed, the answer degrades to UNKNOWN/NOT_AVAILABLE with an explicit reason
 * instead of showing a toolchain that may not exist any more.
 */
function zephyrFromStored(
  raw: string | undefined,
  currentRunnerUrl: string | null,
  board: string,
): RtosStatus {
  const record = readJson<ZephyrRecord>(raw);
  if (!record || !isRtosStatus(record.status)) {
    return zephyrStatusUnavailable(
      "Diagnostics have never been run for this account, so Zephyr availability is unknown. Open Environment and run diagnostics.",
      board,
    );
  }
  if ((record.runnerUrl ?? null) !== currentRunnerUrl) {
    return zephyrStatusUnavailable(
      `The build runner changed since the last diagnostics run (${
        record.runnerUrl ?? "none"
      } → ${currentRunnerUrl ?? "none"}), so the previous toolchain evidence is void. Re-run diagnostics.`,
      board,
    );
  }
  return record.status;
}

/** Full environment status for the signed-in account. Reactive. */
export const status = query({
  args: {},
  handler: async (ctx): Promise<EnvironmentStatus> => {
    const userId = await requireUserId(ctx);
    const row = await latestChecks(ctx, userId);

    const llm = resolveLlmStatus(process.env, readJson<Partial<LlmStatus>>(row?.llm));
    const runner = resolveRunnerStatus(process.env, readJson<Partial<RunnerStatus>>(row?.runner));
    const zephyr = zephyrFromStored(row?.zephyr, runner.url, DEFAULT_REFERENCE_BOARD);
    const freertos = freertosStatus(readJson<Partial<RtosStatus>>(row?.freertos));

    const checkedAt = Math.max(
      row?.llmCheckedAt ?? 0,
      row?.runnerCheckedAt ?? 0,
      row?.diagnosticsAt ?? 0,
    );

    return environmentStatus({
      llm,
      runner,
      zephyr,
      freertos,
      checkedAt: checkedAt > 0 ? checkedAt : null,
    });
  },
});

/**
 * Environment status *of one project*: AI, build capability, RTOS and board.
 * Uses the same taxonomy as everything else (`CapabilityState`,
 * `ConnectionState`, `RunnerState`) — no parallel status model.
 */
export const projectEnvironment = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<ProjectEnvironmentStatus> => {
    const userId = await requireUserId(ctx);
    const project = await requireOwnedProject(ctx, args.projectId, userId);
    const row = await latestChecks(ctx, userId);

    const llm = resolveLlmStatus(process.env, readJson<Partial<LlmStatus>>(row?.llm));
    const runner = resolveRunnerStatus(process.env, readJson<Partial<RunnerStatus>>(row?.runner));
    const board = project.board ?? null;
    const zephyr = zephyrFromStored(row?.zephyr, runner.url, board ?? DEFAULT_REFERENCE_BOARD);
    const rtosStatus =
      project.rtos === "zephyr" ? zephyr : freertosStatus(readJson<Partial<RtosStatus>>(row?.freertos));

    const build = buildStateFor(runner, rtosStatus);
    const boardState = boardStateFor(board, zephyr);

    const recent = await ctx.db
      .query("runs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(20);
    const lastRun = recent.find((run) => run.type === "build") ?? null;

    return {
      projectId: args.projectId,
      ai: {
        state: llm.state,
        provider: llm.provider,
        model: llm.model,
        message: llm.message,
      },
      build: {
        state: build.state,
        runner: runner.state,
        message: build.message,
        lastBuild: lastRun
          ? {
              verification: lastRun.verification ?? "NOT_AVAILABLE",
              verdict: lastRun.verdict ?? "UNKNOWN",
              exitCode: lastRun.exitCode ?? null,
              reason: lastRun.reason ?? null,
              attempt: lastRun.attempt ?? null,
            }
          : null,
      },
      rtos: {
        rtos: project.rtos,
        state: rtosStatus.state,
        message: rtosStatus.message,
      },
      board: {
        board,
        state: boardState.state,
        message: boardState.message,
      },
    };
  },
});

/**
 * Persists probe evidence. Only called by `environmentActions.ts`, and only with
 * payloads built from the shared core model — never with a credential.
 */
export const saveChecks = internalMutation({
  args: {
    userId: v.id("users"),
    llm: v.optional(v.string()),
    runner: v.optional(v.string()),
    zephyr: v.optional(v.string()),
    freertos: v.optional(v.string()),
    llmCheckedAt: v.optional(v.number()),
    runnerCheckedAt: v.optional(v.number()),
    diagnosticsAt: v.optional(v.number()),
  },
  handler: async (ctx: MutationCtx, args): Promise<null> => {
    const existing = await ctx.db
      .query("environmentChecks")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(1);

    const patch = { ...args, checkedAt: Date.now() };
    if (existing[0]) {
      await ctx.db.patch(existing[0]._id, patch);
    } else {
      await ctx.db.insert("environmentChecks", patch);
    }
    return null;
  },
});
