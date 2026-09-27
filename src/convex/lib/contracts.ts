import type { BuildResult, Verdict, Verification } from "../../lib/core/types";

/**
 * Explicit contracts shared by the agent action and its internal helpers.
 *
 * These annotations are deliberate: they break the type inference cycle that
 * `_generated/api` creates between a node action and the internal functions it
 * calls.
 */

/** Evidence of the last build, with legacy (pre-honesty) rows flagged. */
export interface LastBuildEvidence {
  verification: Verification | null;
  verdict: Verdict | null;
  command: string | null;
  toolchain: string | null;
  exitCode: number | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  artifacts: string[];
  reason: string | null;
  attempt: number;
  /** True when the row comes from the old simulated build engine. */
  legacy: boolean;
}

export interface ProjectContextPayload {
  project: {
    name: string;
    rtos: "freertos" | "zephyr";
    board: string | null;
    mcu: string | null;
    description: string | null;
    status: string;
    lastVerdict: Verdict | null;
    lastVerification: Verification | null;
  };
  files: { path: string; content: string }[];
  lastBuild: LastBuildEvidence | null;
}

export function toBuildResult(evidence: LastBuildEvidence): BuildResult | null {
  if (!evidence.verification) return null;
  return {
    verification: evidence.verification,
    verdict: evidence.verdict ?? "UNKNOWN",
    command: evidence.command,
    toolchain: evidence.toolchain,
    exitCode: evidence.exitCode,
    durationMs: evidence.durationMs,
    stdout: evidence.stdout,
    stderr: evidence.stderr,
    artifacts: evidence.artifacts,
    reason: evidence.reason,
    attempt: evidence.attempt,
  };
}

export interface ApplyPlanOutcome {
  applied: { path: string; version: number; kind: "create" | "patch" }[];
  failed: { path: string; code: string; reason: string }[];
  rejected: { path: string; reason: string }[];
  unchanged: string[];
}

export type LlmErrorCode =
  | "LLM_NOT_CONFIGURED"
  | "LLM_UNREACHABLE"
  | "LLM_TIMEOUT"
  | "LLM_HTTP_ERROR"
  | "LLM_EMPTY_RESPONSE";

export type AgentCycleResult =
  | {
      ok: true;
      status: "ANSWER_ONLY" | "CHANGES_APPLIED";
      attempts: number;
      message: string;
      build: BuildResult | null;
      knowledge: string;
      applied?: string;
    }
  | {
      ok: true;
      status: "SUCCESS" | "BUILD_NOT_AVAILABLE";
      attempts: number;
      message: string;
      build: BuildResult;
      knowledge: string;
      applied: string;
    }
  | {
      ok: false;
      code: LlmErrorCode | "LLM_BAD_RESPONSE" | "PLAN_EMPTY";
      message: string;
      attempts?: number;
    }
  | {
      ok: false;
      code: "PATCH_FAILED";
      message: string;
      detail: { path: string; code: string; reason: string }[];
      attempts: number;
    }
  | {
      ok: false;
      code: "TIME_BUDGET_EXHAUSTED" | "REPAIR_LIMIT_REACHED";
      message: string;
      attempts: number;
      build: BuildResult | null;
    };

export type RunBuildActionResult =
  | { ok: true; code: "BUILD_DISPATCHED"; build: BuildResult }
  | {
      ok: false;
      code:
        | "RUNNER_NOT_CONFIGURED"
        | "RUNNER_UNREACHABLE"
        | "RUNNER_TIMEOUT"
        | "RUNNER_HTTP_ERROR"
        | "RUNNER_BAD_RESPONSE";
      message: string;
      build: BuildResult;
    };

export interface GitInitActionResult {
  ok: boolean;
  code:
    | "GIT_OK"
    | "GIT_FAILED"
    | "RUNNER_NOT_CONFIGURED"
    | "RUNNER_UNREACHABLE"
    | "RUNNER_HTTP_ERROR";
  message: string;
  steps?: { command: string; exitCode: number }[];
}
