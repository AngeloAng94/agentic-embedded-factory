/**
 * Environment diagnostic (`runner/index.ts doctor`).
 *
 * Probes the real machine for the tools a Zephyr build needs and reports
 * READY / NOT_READY with an explicit "Missing:" list. It never guesses: a tool
 * that cannot be found is MISSING, and a board that is not listed by
 * `west boards` is not considered supported.
 *
 * Node only — imported by the runner and by tests, never by the browser bundle.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveExecutable, runCommand } from "./buildEngine";

export type DoctorStatus = "PASS" | "MISSING";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  required: boolean;
  detail: string;
}

export interface DoctorReport {
  environment: "READY" | "NOT_READY";
  ready: boolean;
  board: string;
  checks: DoctorCheck[];
  missing: string[];
  zephyrBase: string | null;
  zephyrSdk: string | null;
  zephyrSdkVersion: string | null;
  boardsSupported: string[] | null;
  generatedAt: string;
}

/** A board that upstream Zephyr really ships a definition for. */
export const DEFAULT_REFERENCE_BOARD = "nucleo_l476rg";

const LABEL_WIDTH = 17;

async function firstLine(
  program: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<string | null> {
  const outcome = await runCommand(
    { program, args, display: `${program} ${args.join(" ")}` },
    { cwd, timeoutMs: 20_000, env },
  );
  if (!outcome.ok) return null;
  const line = (outcome.stdout || outcome.stderr)
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ?? null;
}

function check(id: string, label: string, pass: boolean, required: boolean, detail: string): DoctorCheck {
  return { id, label, status: pass ? "PASS" : "MISSING", required, detail };
}

async function westTopdir(west: string | null): Promise<string | null> {
  if (!west) return null;
  const outcome = await runCommand(
    { program: west, args: ["topdir"], display: "west topdir" },
    { cwd: process.cwd(), timeoutMs: 20_000 },
  );
  if (!outcome.ok || outcome.exitCode !== 0) return null;
  const line = outcome.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line && existsSync(line) ? line : null;
}

/** ZEPHYR_SDK_INSTALL_DIR first, then the usual install locations. */
export function findZephyrSdk(env: Record<string, string | undefined>): string | null {
  const explicit = env.ZEPHYR_SDK_INSTALL_DIR?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  const roots = [os.homedir(), path.join(os.homedir(), ".local", "opt"), "/opt", "/usr/local"];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    const match = entries
      .filter((entry) => entry.startsWith("zephyr-sdk"))
      .sort()
      .reverse()
      .map((entry) => path.join(root, entry))
      .find((candidate) => {
        try {
          return statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      });
    if (match) return match;
  }
  return null;
}

export function readSdkVersion(sdkDir: string | null): string | null {
  if (!sdkDir) return null;
  const versionFile = path.join(sdkDir, "sdk_version");
  if (existsSync(versionFile)) {
    try {
      const value = readFileSync(versionFile, "utf8").trim();
      if (value !== "") return value;
    } catch {
      /* fall through to the directory name */
    }
  }
  const match = /zephyr-sdk-([0-9][\w.-]*)/.exec(path.basename(sdkDir));
  return match ? match[1]! : null;
}

export function findArmCompiler(
  sdkDir: string | null,
  env: Record<string, string | undefined>,
): string | null {
  const onPath = resolveExecutable(env.CROSS_COMPILE ? `${env.CROSS_COMPILE}gcc` : "arm-zephyr-eabi-gcc");
  if (onPath) return onPath;
  if (sdkDir) {
    const candidate = path.join(sdkDir, "arm-zephyr-eabi", "bin", "arm-zephyr-eabi-gcc");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface DoctorOptions {
  board?: string;
  cwd?: string;
  /** Skip the `west boards` probe (used by fast unit tests). */
  skipBoards?: boolean;
}

export async function runDoctor(
  env: Record<string, string | undefined> = process.env,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const board = options.board ?? env.EMBEDFACTORY_BOARD?.trim() ?? DEFAULT_REFERENCE_BOARD;
  const cwd = options.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];

  // ---- west ---------------------------------------------------------------
  const west = resolveExecutable("west");
  const westVersion = west ? await firstLine(west, ["--version"], cwd) : null;
  checks.push(
    check("west", "west", Boolean(west), true, west ? westVersion ?? "found (version unknown)" : "not found in PATH"),
  );

  // ---- cmake --------------------------------------------------------------
  const cmake = resolveExecutable("cmake");
  const cmakeVersion = cmake ? await firstLine(cmake, ["--version"], cwd) : null;
  checks.push(
    check("cmake", "cmake", Boolean(cmake), true, cmake ? cmakeVersion ?? "found" : "not found in PATH"),
  );

  // ---- ninja or make ------------------------------------------------------
  const ninja = resolveExecutable("ninja");
  const make = ninja ? null : resolveExecutable("make");
  const generator = ninja ?? make;
  checks.push(
    check(
      "generator",
      "ninja",
      Boolean(generator),
      true,
      ninja ? "ninja found" : make ? "ninja missing — make found (west -G 'Unix Makefiles')" : "neither ninja nor make was found",
    ),
  );

  // ---- python -------------------------------------------------------------
  const python = resolveExecutable("python3") ?? resolveExecutable("python");
  const pythonVersion = python
    ? await firstLine(python, ["--version"], cwd)
    : null;
  checks.push(
    check("python", "python", Boolean(python), true, python ? pythonVersion ?? "found" : "not found in PATH"),
  );

  // ---- dtc (devicetree compiler) -----------------------------------------
  const dtc = resolveExecutable("dtc") ?? resolveExecutable("dtc.exe");
  checks.push(
    check(
      "dtc",
      "dtc",
      Boolean(dtc),
      true,
      dtc ? "devicetree compiler found" : "not found in PATH (Zephyr needs dtc)",
    ),
  );

  // ---- ZEPHYR_BASE --------------------------------------------------------
  const envBase = env.ZEPHYR_BASE?.trim() ?? "";
  let zephyrBase: string | null = null;
  let baseDetail = "";
  if (envBase !== "" && existsSync(envBase)) {
    zephyrBase = envBase;
    baseDetail = `${zephyrBase} (from ZEPHYR_BASE)`;
  } else {
    const topdir = await westTopdir(west);
    const candidate = topdir ? path.join(topdir, "zephyr") : null;
    if (candidate && existsSync(candidate)) {
      zephyrBase = candidate;
      baseDetail = `${candidate} (west workspace; \`west build\` exports ZEPHYR_BASE itself)`;
    } else {
      baseDetail =
        envBase === ""
          ? "ZEPHYR_BASE is not set and no west workspace was found (`west topdir`)"
          : `ZEPHYR_BASE="${envBase}" does not exist`;
    }
  }
  checks.push(check("zephyr_base", "ZEPHYR_BASE", zephyrBase !== null, true, baseDetail));

  // ---- Zephyr SDK ---------------------------------------------------------
  const sdkDir = findZephyrSdk(env);
  const sdkVersion = readSdkVersion(sdkDir);
  checks.push(
    check(
      "zephyr_sdk",
      "Zephyr SDK",
      sdkDir !== null,
      true,
      sdkDir ? `${sdkDir}${sdkVersion ? ` (${sdkVersion})` : ""}` : "no zephyr-sdk-* directory found (set ZEPHYR_SDK_INSTALL_DIR)",
    ),
  );

  // ---- ARM toolchain ------------------------------------------------------
  const armCompiler = findArmCompiler(sdkDir, env);
  const armVersion = armCompiler ? await firstLine(armCompiler, ["--version"], cwd) : null;
  checks.push(
    check(
      "arm_toolchain",
      "arm-zephyr-eabi",
      Boolean(armCompiler),
      true,
      armCompiler
        ? armVersion ?? "found"
        : "arm-zephyr-eabi-gcc was not found in PATH or in the Zephyr SDK",
    ),
  );

  // ---- board recognition --------------------------------------------------
  let boardsSupported: string[] | null = null;
  let boardDetail = `not verified — west/ZEPHYR_BASE unavailable, so board "${board}" cannot be confirmed`;
  let boardOk = false;
  if (!options.skipBoards && west && zephyrBase) {
    const outcome = await runCommand(
      { program: west, args: ["boards"], display: "west boards" },
      { cwd: zephyrBase, timeoutMs: 120_000, env: { ZEPHYR_BASE: zephyrBase } },
    );
    if (outcome.ok && outcome.exitCode === 0) {
      const names = outcome.stdout
        .split("\n")
        .map((entry) => entry.trim())
        .filter((entry) => /^[a-z0-9][a-z0-9_/.-]*$/.test(entry));
      boardsSupported = names;
      boardOk = names.includes(board);
      boardDetail = boardOk
        ? `"${board}" recognised by west (${names.length} boards)`
        : `"${board}" is not among the ${names.length} boards reported by \`west boards\``;
    } else {
      boardDetail = `\`west boards\` failed: ${(outcome.stderr || outcome.stdout).trim().split("\n")[0] ?? "no output"}`;
    }
  } else if (options.skipBoards) {
    boardDetail = "board probe skipped";
  }
  checks.push(check("board", "board", boardOk, !options.skipBoards, boardDetail));

  const missing = checks.filter((entry) => entry.required && entry.status !== "PASS").map((entry) => entry.label);
  const ready = missing.length === 0;

  return {
    environment: ready ? "READY" : "NOT_READY",
    ready,
    board,
    checks,
    missing,
    zephyrBase,
    zephyrSdk: sdkDir,
    zephyrSdkVersion: sdkVersion,
    boardsSupported,
    generatedAt: new Date().toISOString(),
  };
}

/** The human-readable report printed by `bun runner/index.ts doctor`. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("EmbedFactory Environment");
  lines.push("");
  for (const entry of report.checks) {
    const label = entry.label.padEnd(LABEL_WIDTH, " ");
    const status = entry.status === "PASS" ? "PASS" : "MISSING";
    lines.push(`${label} ${status.padEnd(7, " ")} ${entry.detail}`);
  }
  lines.push("");
  lines.push(`${"Environment".padEnd(LABEL_WIDTH, " ")} ${report.environment}`);
  lines.push(`${"Board".padEnd(LABEL_WIDTH, " ")} ${report.board}`);
  if (!report.ready) {
    lines.push("");
    lines.push("Missing:");
    for (const item of report.missing) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}
