import type { ArtifactInfo, BuildResult, MemoryUsage, Verdict, Verification } from "./types";
import { emptyBuildResult } from "./types";

/**
 * Honesty helpers for build results.
 *
 * Rules enforced here:
 *  - `PASS`/`SUCCESS` may only be reported when verification === "REAL" and a
 *    process actually terminated with exit code 0.
 *  - A simulated run is always labelled `SIMULATED — no compiler invoked`.
 *  - A missing toolchain is `NOT_AVAILABLE`, never a success.
 */

export const MAX_REPAIR_ATTEMPTS = 3;

export function notAvailable(reason: string, command: string | null = null): BuildResult {
  const result = emptyBuildResult("NOT_AVAILABLE", reason);
  result.command = command;
  return result;
}

export function simulated(reason: string): BuildResult {
  const result = emptyBuildResult("SIMULATED", reason);
  result.verdict = "UNKNOWN";
  return result;
}

export function realResult(input: {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  artifacts?: string[];
  artifactDetails?: ArtifactInfo[];
  memory?: MemoryUsage | null;
  rtos?: string | null;
  board?: string | null;
  attempt?: number;
  toolchain?: string | null;
}): BuildResult {
  return {
    verification: "REAL",
    verdict: input.exitCode === 0 ? "SUCCESS" : "FAILURE",
    command: input.command,
    toolchain: input.toolchain ?? null,
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    stdout: input.stdout,
    stderr: input.stderr,
    artifacts: input.artifacts ?? [],
    artifactDetails: input.artifactDetails ?? [],
    memory: input.memory ?? null,
    rtos: input.rtos ?? null,
    board: input.board ?? null,
    reason: null,
    attempt: input.attempt ?? 1,
  };
}

/** The only definition of "verified" used across the product. */
export function isVerifiedSuccess(result: BuildResult): boolean {
  return result.verification === "REAL" && result.verdict === "SUCCESS";
}

export function verificationLabel(verification: Verification): string {
  switch (verification) {
    case "REAL":
      return "REAL";
    case "SIMULATED":
      return "SIMULATED — no compiler invoked";
    case "NOT_AVAILABLE":
      return "NOT AVAILABLE";
    default: {
      const exhaustive: never = verification;
      return exhaustive;
    }
  }
}

export function verdictLabel(verdict: Verdict): string {
  switch (verdict) {
    case "SUCCESS":
      return "SUCCESS";
    case "FAILURE":
      return "FAILURE";
    case "UNKNOWN":
      return "UNKNOWN";
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

export function statusBadge(result: BuildResult): string {
  return `${verificationLabel(result.verification)} · ${verdictLabel(result.verdict)}`;
}

/** Machine readable single-line status, safe for logs and tests. */
export function buildHeadline(result: BuildResult): string {
  const parts = [
    `verification=${result.verification}`,
    `verdict=${result.verdict}`,
    `exit=${result.exitCode === null ? "n/a" : result.exitCode}`,
  ];
  if (result.command) parts.push(`command=${result.command}`);
  return parts.join(" ");
}

export function formatBuildReport(result: BuildResult): string {
  const lines: string[] = [];
  lines.push("BUILD");
  lines.push("─────");
  lines.push(`Command: ${result.command ?? "(none)"}`);
  lines.push(
    `Exit code: ${result.exitCode === null ? "n/a" : String(result.exitCode)}`,
  );
  lines.push(
    `Duration: ${result.durationMs === null ? "n/a" : `${(result.durationMs / 1000).toFixed(1)}s`}`,
  );
  if (result.toolchain) lines.push(`Toolchain: ${result.toolchain}`);
  if (result.rtos) lines.push(`RTOS: ${result.rtos}`);
  if (result.board) lines.push(`Board: ${result.board}`);
  lines.push(`Attempt: ${result.attempt}/${MAX_REPAIR_ATTEMPTS}`);
  lines.push("");
  lines.push("stdout:");
  lines.push(result.stdout.trim() === "" ? "(empty)" : result.stdout.trimEnd());
  lines.push("");
  lines.push(formatMemoryUsage(result.memory));
  lines.push("");
  lines.push("stderr:");
  lines.push(result.stderr.trim() === "" ? "(empty)" : result.stderr.trimEnd());
  lines.push("");
  if (result.artifacts.length > 0) {
    lines.push("Artifacts:");
    for (const artifact of result.artifacts) {
      const detail = result.artifactDetails.find((entry) => entry.path === artifact);
      lines.push(detail ? `- ${formatArtifact(detail)}` : `- ${artifact}`);
    }
    lines.push("");
  }
  if (result.reason) {
    lines.push(`Reason: ${result.reason}`);
    lines.push("");
  }
  lines.push(`Status: ${statusBadge(result)}`);
  return lines.join("\n");
}

/** Human readable one-line artifact evidence: path, size, format, hash, arch. */
export function formatArtifact(info: ArtifactInfo): string {
  const parts = [info.path, `${info.bytes} B`, info.format.toUpperCase(), `sha256:${info.sha256.slice(0, 12)}`];
  if (info.elf?.architecture) parts.push(info.elf.architecture);
  if (info.elf?.class) parts.push(info.elf.class);
  return parts.join(" · ");
}

/** FLASH/RAM usage block, or an explicit note when nothing was reported. */
export function formatMemoryUsage(memory: MemoryUsage | null): string {
  if (!memory) return "Memory: not reported by the toolchain";
  const bytes = (value: number | null) => (value === null ? "n/a" : `${value} B`);
  const lines = [
    "Memory:",
    `  FLASH: ${bytes(memory.flashUsed)} used${memory.flashTotal === null ? "" : ` / ${bytes(memory.flashTotal)}`}`,
    `  RAM:   ${bytes(memory.ramUsed)} used${memory.ramTotal === null ? "" : ` / ${bytes(memory.ramTotal)}`}`,
  ];
  if (memory.sections) {
    lines.push(
      `  sections: text ${memory.sections.text} B, data ${memory.sections.data} B, bss ${memory.sections.bss} B`,
    );
  }
  if (memory.report) {
    lines.push("  linker report:");
    for (const raw of memory.report.split("\n")) lines.push(`    ${raw}`);
  }
  return lines.join("\n");
}

/**
 * Project status must never become `ready` without a real, successful build.
 */
export function projectStatusFor(
  result: BuildResult,
): "verified" | "unverified" | "failed" {
  if (isVerifiedSuccess(result)) return "verified";
  if (result.verification === "REAL" && result.verdict === "FAILURE")
    return "failed";
  return "unverified";
}

export const BUILD_STATUS_HONESTY_NOTE =
  "REAL requires an executed process; SIMULATED and NOT_AVAILABLE never count as verification.";
