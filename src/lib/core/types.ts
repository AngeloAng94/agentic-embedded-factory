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

/** Artifact format detected from the file magic bytes, not from its name. */
export type ArtifactFormat = "elf" | "bin" | "hex" | "uf2" | "map" | "text" | "other";

/** ELF header fields read directly from the file (no external tool needed). */
export interface ElfHeader {
  class: string | null;
  endianness: string | null;
  type: string | null;
  machine: string | null;
  entry: string | null;
  /** Human readable architecture, e.g. "ARM" for a Cortex-M image. */
  architecture: string | null;
}

/**
 * Validated metadata for one generated artifact: it really exists on disk and
 * its bytes were really read. A path alone is never enough evidence.
 */
export interface ArtifactInfo {
  /** Project-relative path, always with forward slashes. */
  path: string;
  bytes: number;
  sha256: string;
  format: ArtifactFormat;
  /** Present only when the file really is an ELF image. */
  elf: ElfHeader | null;
}

/** FLASH/RAM usage extracted from the real build output or the `size` tool. */
export interface MemoryUsage {
  flashUsed: number | null;
  flashTotal: number | null;
  ramUsed: number | null;
  ramTotal: number | null;
  /** text/data/bss from the binutils `size` output, when available. */
  sections: { text: number; data: number; bss: number } | null;
  /** Raw linker report lines, kept verbatim as evidence. */
  report: string | null;
}

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
  /** Project-relative artifact paths (kept for backwards compatibility). */
  artifacts: string[];
  /** Real, on-disk validation of every artifact (size, hash, format, ELF). */
  artifactDetails: ArtifactInfo[];
  /** Flash/RAM usage reported by the real toolchain, when it is available. */
  memory: MemoryUsage | null;
  /** RTOS and board this result belongs to: the board profile of the build. */
  rtos: string | null;
  board: string | null;
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
    artifactDetails: [],
    memory: null,
    rtos: null,
    board: null,
    reason,
    attempt: 1,
  };
}
