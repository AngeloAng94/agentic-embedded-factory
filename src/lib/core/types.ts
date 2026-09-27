/**
 * Shared types for the embedded software factory core.
 *
 * These types are the single source of truth for the honesty model
 * (REAL / SIMULATED / NOT_AVAILABLE / FAILED) used by the web app, the
 * Convex backend, the local runner and the tests.
 */

export type Rtos = "freertos" | "zephyr";

/** How a result was obtained. Never claim REAL unless a real process ran. */
export type Verification = "REAL" | "SIMULATED" | "NOT_AVAILABLE";

/** What the result was. UNKNOWN is only valid when nothing really ran. */
export type Verdict = "SUCCESS" | "FAILURE" | "UNKNOWN";

export interface BuildResult {
  verification: Verification;
  verdict: Verdict;
  /** Exact command line that was executed (null when nothing ran). */
  command: string | null;
  /** Toolchain / executable resolution info, e.g. "west 1.2.0". */
  toolchain: string | null;
  exitCode: number | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  artifacts: string[];
  /** Why the result is not REAL (missing toolchain, no runner, ...). */
  reason: string | null;
  /** 1-based repair-loop attempt number. */
  attempt: number;
}

export interface ProjectFileLike {
  path: string;
  content: string;
}

export interface ProjectLike {
  name: string;
  rtos: Rtos;
  board?: string | null;
  mcu?: string | null;
  description?: string | null;
}

export function emptyBuildResult(
  verification: Verification,
  reason: string,
): BuildResult {
  return {
    verification,
    verdict: "UNKNOWN",
    command: null,
    toolchain: null,
    exitCode: null,
    durationMs: null,
    stdout: "",
    stderr: "",
    artifacts: [],
    reason,
    attempt: 1,
  };
}
