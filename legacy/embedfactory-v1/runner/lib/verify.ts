/**
 * End-to-end Zephyr verification (`bun runner/index.ts verify`).
 *
 * It exercises the real vertical slice on this machine:
 *
 *   reference project → west build → REAL FAILURE (real GCC/linker stderr)
 *   → repair (LLM when configured, otherwise the deterministic patch)
 *   → west build → REAL SUCCESS → artifact validation → ZIP export
 *
 * The repair *loop* itself lives in the product (Convex `agent.ts` for the web
 * app, `runner/lib/turn.ts` for local turns); this harness does not reimplement
 * it. It drives the same `runProjectBuild` engine and the same validated patch
 * primitives, and it reports honestly: when the Zephyr toolchain is missing it
 * returns `SKIPPED — Zephyr toolchain unavailable` instead of a fake success.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyUnifiedDiff, formatUnifiedDiff } from "../../src/lib/core/diff";
import { isPathAllowed } from "../../src/lib/core/pathSafety";
import { buildProjectArchive, type ExportManifest } from "../../src/lib/core/projectExport";
import { resolveLlmConfig } from "../../src/lib/core/llmClient";
import { runProjectBuild, runCommand, resolveExecutable } from "../../src/lib/core/buildEngine";
import { formatArtifact, formatMemoryUsage } from "../../src/lib/core/buildStatus";
import {
  DEFAULT_REFERENCE_BOARD,
  formatDoctorReport,
  runDoctor,
  type DoctorReport,
} from "../../src/lib/core/toolchainDoctor";
import type { ArtifactInfo, BuildResult, MemoryUsage } from "../../src/lib/core/types";
import { runAgentTurn, type TurnFile } from "./turn";

export const REFERENCE_PROJECT_DIR = "samples/zephyr-blink";
export const SKIP_MESSAGE = "SKIPPED — Zephyr toolchain unavailable";

/** The intentional defect: a Zephyr function that does not exist. */
export const BROKEN_MAIN_C = `/*
 * EmbedFactory reference firmware — INTENTIONAL DEFECT for the verify run.
 *
 * gpio_pin_configure_led0_blink() is not a Zephyr API: it is neither declared
 * nor defined anywhere, so the real toolchain must reject this file (implicit
 * declaration at compile time and an undefined reference at link time).
 */
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>

int main(void)
{
\tprintk("EmbedFactory reference firmware starting\\n");

\t/* Wrong Zephyr API: this symbol does not exist. */
\tgpio_pin_configure_led0_blink();

\twhile (1) {
\t\tk_sleep(K_SECONDS(1));
\t}

\treturn 0;
}
`;

export type RepairSource = "llm" | "deterministic" | "none";

export interface VerifyReport {
  ok: boolean;
  skipped: boolean;
  skipReason: string | null;
  board: string;
  doctor: DoctorReport;
  workspace: string | null;
  workdir: string | null;
  attempt1: BuildResult | null;
  errorExcerpt: string | null;
  diagnosis: string | null;
  repairSource: RepairSource;
  repairNote: string | null;
  patch: string | null;
  attempt2: BuildResult | null;
  artifacts: ArtifactInfo[];
  memory: MemoryUsage | null;
  exportManifest: ExportManifest | null;
  archivePath: string | null;
  steps: string[];
}

export interface VerifyOptions {
  board?: string;
  repoRoot?: string;
  keep?: boolean;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

/** Reads the reference project from the repository. */
export function loadReferenceProject(repoRoot: string): TurnFile[] {
  const root = path.join(repoRoot, REFERENCE_PROJECT_DIR);
  const wanted = ["CMakeLists.txt", "prj.conf", "src/main.c"];
  const files: TurnFile[] = [];
  for (const relative of wanted) {
    const full = path.join(root, relative);
    files.push({ path: relative, content: readFileSync(full, "utf8") });
  }
  return files;
}

function writeProjectFiles(dir: string, files: TurnFile[]): void {
  for (const file of files) {
    if (!isPathAllowed(file.path)) throw new Error(`refusing to write unsafe path: ${file.path}`);
    const target = path.resolve(path.join(dir, file.path));
    if (!target.startsWith(path.resolve(dir) + path.sep)) {
      throw new Error(`refusing to write outside the workdir: ${file.path}`);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
}

function replaceFile(files: TurnFile[], relativePath: string, content: string): TurnFile[] {
  return files.map((file) => (file.path === relativePath ? { ...file, content } : file));
}

/** Pulls the real compiler/linker error lines out of the captured stderr. */
export function extractCompilerErrors(stderr: string, stdout = ""): string | null {
  const interesting: string[] = [];
  for (const line of `${stderr}\n${stdout}`.split("\n")) {
    if (/error:|Error:|undefined reference|undefined symbol|fatal error/i.test(line)) {
      interesting.push(line.replace(/\s+$/, ""));
    }
  }
  if (interesting.length === 0) return null;
  return interesting.slice(0, 12).join("\n");
}

async function workspaceTopdir(
  zephyrBase: string | null,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  const west = resolveExecutable("west");
  if (west) {
    const outcome = await runCommand(
      { program: west, args: ["topdir"], display: "west topdir" },
      { cwd: process.cwd(), timeoutMs: 20_000 },
    );
    if (outcome.ok && outcome.exitCode === 0) {
      const line = outcome.stdout
        .split("\n")
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0);
      if (line && statSyncSafeIsDir(line)) return line;
    }
  }
  if (zephyrBase) {
    const parent = path.dirname(zephyrBase);
    if (statSyncSafeIsDir(parent)) return parent;
  }
  void env;
  return null;
}

function statSyncSafeIsDir(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export async function runZephyrVerification(options: VerifyOptions = {}): Promise<VerifyReport> {
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? path.resolve(import.meta.dir, "../..");
  const board = options.board ?? env.EMBEDFACTORY_BOARD?.trim() ?? DEFAULT_REFERENCE_BOARD;
  const steps: string[] = [];

  const doctor = await runDoctor(env, { board, cwd: repoRoot });
  steps.push(`doctor: ${doctor.environment} (board ${doctor.board})`);

  const report: VerifyReport = {
    ok: false,
    skipped: false,
    skipReason: null,
    board,
    doctor,
    workspace: null,
    workdir: null,
    attempt1: null,
    errorExcerpt: null,
    diagnosis: null,
    repairSource: "none",
    repairNote: null,
    patch: null,
    attempt2: null,
    artifacts: [],
    memory: null,
    exportManifest: null,
    archivePath: null,
    steps,
  };

  if (!doctor.ready) {
    report.skipped = true;
    report.skipReason = SKIP_MESSAGE;
    report.repairNote = `missing: ${doctor.missing.join(", ")}`;
    steps.push(SKIP_MESSAGE);
    return report;
  }

  const topdir = await workspaceTopdir(doctor.zephyrBase, env);
  report.workspace = topdir;
  if (!topdir) {
    report.skipReason = "no west workspace found (`west topdir` failed)";
    report.repairNote = report.skipReason;
    return report;
  }
  steps.push(`west workspace: ${topdir}`);

  const goodFiles = loadReferenceProject(repoRoot);
  const brokenFiles = replaceFile(goodFiles, "src/main.c", BROKEN_MAIN_C);
  const buildEnv: Record<string, string> = {};
  if (doctor.zephyrBase) buildEnv.ZEPHYR_BASE = doctor.zephyrBase;

  // `west build` requires the build directory to live inside the workspace.
  const workdir = mkdtempSync(path.join(topdir, "embedfactory-verify-"));
  report.workdir = workdir;

  try {
    // ---- attempt 1: the real toolchain must reject the broken source -------
    writeProjectFiles(workdir, brokenFiles);
    const attempt1 = await runProjectBuild({
      dir: workdir,
      rtos: "zephyr",
      board,
      attempt: 1,
      timeoutMs: options.timeoutMs,
      env: buildEnv,
    });
    report.attempt1 = attempt1;
    report.errorExcerpt = extractCompilerErrors(attempt1.stderr, attempt1.stdout);
    steps.push(
      `attempt 1: ${attempt1.verification} / ${attempt1.verdict} (exit ${attempt1.exitCode ?? "n/a"})`,
    );

    if (attempt1.verification !== "REAL" || attempt1.verdict !== "FAILURE") {
      report.repairNote = `expected a REAL FAILURE from the broken source, got ${attempt1.verification}/${attempt1.verdict}`;
      return report;
    }

    // ---- repair -----------------------------------------------------------
    const goodMain = goodFiles.find((file) => file.path === "src/main.c")!.content;
    const deterministicPatch = formatUnifiedDiff("src/main.c", BROKEN_MAIN_C, goodMain);

    let repairedFiles: TurnFile[] = goodFiles;
    const llmConfig = resolveLlmConfig(env);
    if (llmConfig.ok) {
      const outcome = await runAgentTurn({
        projectName: "embedfactory_reference",
        rtos: "zephyr",
        board,
        userMessage:
          "The build failed. Fix src/main.c so it compiles: the reference firmware must only use portable Zephyr APIs.",
        files: brokenFiles,
        buildResult: attempt1,
        attempt: 2,
        env,
      });
      const write = outcome.ok ? outcome.writes.find((entry) => entry.path === "src/main.c") : undefined;
      if (outcome.ok && write) {
        repairedFiles = replaceFile(brokenFiles, "src/main.c", write.content);
        report.repairSource = "llm";
        report.patch = write.patch ?? deterministicPatch;
        report.diagnosis = outcome.summary;
        report.repairNote = `LLM (${outcome.llm.model}) patched src/main.c`;
      } else {
        report.repairNote = outcome.ok
          ? "LLM answered without patching src/main.c — using the deterministic patch"
          : `LLM repair unavailable (${outcome.code}) — using the deterministic patch`;
      }
    } else {
      report.repairNote = `no LLM configured (${llmConfig.code}) — using the deterministic patch`;
    }

    if (report.repairSource === "none") {
      const applied = applyUnifiedDiff(BROKEN_MAIN_C, deterministicPatch);
      if (!applied.ok) {
        report.repairNote = `deterministic patch did not apply: ${applied.reason}`;
        return report;
      }
      if (applied.content !== goodMain) {
        report.repairNote = "deterministic patch produced unexpected content";
        return report;
      }
      repairedFiles = replaceFile(brokenFiles, "src/main.c", applied.content);
      report.repairSource = "deterministic";
      report.patch = deterministicPatch;
      report.diagnosis =
        "src/main.c calls gpio_pin_configure_led0_blink(), a Zephyr API that does not exist. Remove the call.";
    }

    steps.push(`repair: ${report.repairSource}`);

    // ---- attempt 2: rebuild the repaired project ---------------------------
    writeProjectFiles(workdir, repairedFiles);
    const attempt2 = await runProjectBuild({
      dir: workdir,
      rtos: "zephyr",
      board,
      attempt: 2,
      timeoutMs: options.timeoutMs,
      env: buildEnv,
    });
    report.attempt2 = attempt2;
    report.artifacts = attempt2.artifactDetails;
    report.memory = attempt2.memory;
    steps.push(
      `attempt 2: ${attempt2.verification} / ${attempt2.verdict} (exit ${attempt2.exitCode ?? "n/a"})`,
    );

    if (attempt2.verification !== "REAL" || attempt2.verdict !== "SUCCESS") {
      report.repairNote = `rebuild did not succeed: ${attempt2.verification}/${attempt2.verdict}`;
      return report;
    }

    // ---- export ----------------------------------------------------------
    const { bytes, manifest } = buildProjectArchive(
      {
        name: "embedfactory_reference",
        rtos: "zephyr",
        board,
        mcu: null,
        description: "EmbedFactory reference firmware",
      },
      repairedFiles.map((file) => ({ path: file.path, content: file.content })),
      {
        verification: `${attempt2.verification} · ${attempt2.verdict}`,
        verdict: attempt2.verdict,
        toolchain: attempt2.toolchain,
      },
    );
    report.exportManifest = manifest;
    const archivePath = path.join(workdir, "embedfactory-export.zip");
    writeFileSync(archivePath, bytes);
    report.archivePath = archivePath;
    steps.push(`export: ${archivePath} (${bytes.byteLength} bytes)`);
    report.ok = true;
    return report;
  } finally {
    if (!options.keep) rmSync(workdir, { recursive: true, force: true });
  }
}

export function formatVerifyReport(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push("EmbedFactory — real Zephyr verification");
  lines.push("════════════════════════════════════════");
  lines.push("");
  lines.push(formatDoctorReport(report.doctor));
  lines.push("");

  if (report.skipped || report.skipReason) {
    lines.push(`Result: ${report.skipReason}`);
    for (const step of report.steps) lines.push(`  · ${step}`);
    return lines.join("\n");
  }

  lines.push(`Board: ${report.board}`);
  if (report.workspace) lines.push(`West workspace: ${report.workspace}`);
  lines.push(`Command: ${report.attempt1?.command ?? "(none)"}`);
  lines.push("");

  lines.push("Attempt 1 — REAL BUILD");
  lines.push(`  ${report.attempt1?.verification} / ${report.attempt1?.verdict} · exit ${report.attempt1?.exitCode ?? "n/a"}`);
  if (report.errorExcerpt) {
    lines.push("  Compiler:");
    for (const line of report.errorExcerpt.split("\n")) lines.push(`    ${line}`);
  }
  lines.push(`  Agent diagnosis: ${report.repairSource === "llm" ? "LLM" : "deterministic"}`);
  if (report.diagnosis) lines.push(`    ${report.diagnosis}`);
  if (report.repairNote) lines.push(`  Note: ${report.repairNote}`);
  if (report.patch) {
    lines.push("  Patch:");
    for (const line of report.patch.split("\n")) lines.push(`    ${line}`);
  }
  lines.push("");

  lines.push("Attempt 2 — REAL BUILD");
  lines.push(`  ${report.attempt2?.verification} / ${report.attempt2?.verdict} · exit ${report.attempt2?.exitCode ?? "n/a"}`);
  lines.push(`  Toolchain: ${report.attempt2?.toolchain ?? "unknown"}`);
  lines.push("");
  lines.push(formatMemoryUsage(report.memory));
  lines.push("");
  if (report.artifacts.length > 0) {
    lines.push("Artifacts (validated on disk):");
    for (const info of report.artifacts) lines.push(`  - ${formatArtifact(info)}`);
    lines.push("");
  }
  if (report.exportManifest) {
    const profile = report.exportManifest.boardProfile;
    lines.push(
      `Manifest board profile: rtos=${profile.rtos} board=${profile.board ?? "null"} toolchain=${
        profile.toolchain ?? "null"
      } verification=${profile.verification} verdict=${profile.verdict}`,
    );
  }
  if (report.archivePath) lines.push(`ZIP export: ${report.archivePath}`);
  lines.push("");
  lines.push(`Result: ${report.ok ? "REAL SUCCESS" : "INCOMPLETE"}`);
  return lines.join("\n");
}

/** Utility used by tests: lists the files of the reference project on disk. */
export function referenceProjectFiles(repoRoot: string): string[] {
  const root = path.join(repoRoot, REFERENCE_PROJECT_DIR);
  const found: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), next);
      else found.push(next);
    }
  };
  walk(root, "");
  return found.sort();
}
