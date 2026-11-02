/**
 * Real build engine (Node only).
 *
 * Every result comes from an actually executed process: real stdout, real
 * stderr, real exit code and real duration. When the toolchain is missing the
 * result is NOT_AVAILABLE — never a fabricated success.
 *
 * This module is imported by the local runner and by tests, never by the
 * browser bundle.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { BuildResult } from "./types";
import { notAvailable, realResult } from "./buildStatus";
import {
  inspectArtifacts,
  mergeMemoryUsage,
  parseGnuSize,
  parseMemoryReport,
} from "./artifactInspect";

export const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

export interface CommandSpec {
  program: string;
  args: string[];
  display: string;
}

export type CommandOutcome =
  | {
      ok: true;
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
      command: string;
    }
  | {
      ok: false;
      code: "TOOLCHAIN_NOT_AVAILABLE" | "SPAWN_FAILED" | "TIMEOUT";
      message: string;
      command: string;
      stdout: string;
      stderr: string;
      durationMs: number;
    };

function executableCandidates(name: string): string[] {
  if (process.platform === "win32") {
    const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
    return [name, ...exts.map((ext) => `${name}${ext.toLowerCase()}`)];
  }
  return [name];
}

/** Resolves a program on PATH without invoking a shell. */
export function resolveExecutable(name: string): string | null {
  if (name.includes("/") || name.includes("\\")) {
    return existsSync(name) ? name : null;
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of executableCandidates(name)) {
      const full = path.join(dir, candidate);
      try {
        const stat = statSync(full);
        if (!stat.isFile()) continue;
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function splitCommandString(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of value.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== "") {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current !== "") parts.push(current);
  return parts;
}

export function runCommand(
  spec: CommandSpec,
  options: { cwd: string; timeoutMs?: number; env?: Record<string, string> } = {
    cwd: process.cwd(),
  },
): Promise<CommandOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  const started = Date.now();

  return new Promise<CommandOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(spec.program, spec.args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
    });

    const finish = (outcome: CommandOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        code: "TIMEOUT",
        message: `command timed out after ${timeoutMs} ms`,
        command: spec.display,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      const missing = error.code === "ENOENT";
      finish({
        ok: false,
        code: missing ? "TOOLCHAIN_NOT_AVAILABLE" : "SPAWN_FAILED",
        message: missing
          ? `toolchain unavailable: "${spec.program}" was not found in PATH`
          : `failed to start "${spec.program}": ${error.message}`,
        command: spec.display,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });

    child.on("close", (code) => {
      finish({
        ok: true,
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        command: spec.display,
      });
    });
  });
}

export function buildCommandForProject(input: {
  rtos: string;
  board?: string | null;
  commandOverride?: string | null;
}): CommandSpec {
  if (input.commandOverride && input.commandOverride.trim() !== "") {
    const parts = splitCommandString(input.commandOverride);
    return {
      program: parts[0]!,
      args: parts.slice(1),
      display: input.commandOverride.trim(),
    };
  }

  if (input.rtos === "zephyr") {
    const args = ["build"];
    if (input.board) args.push("-b", input.board);
    args.push("-d", "build", "-p", "auto");
    return { program: "west", args, display: `west ${args.join(" ")}` };
  }

  return {
    program: "cmake",
    args: ["-S", ".", "-B", "build"],
    display: "cmake -S . -B build (then cmake --build build)",
  };
}

const ARTIFACT_PATTERNS = /\.(elf|bin|hex|uf2|map|axf)$/i;

export function collectArtifacts(root: string, buildDir = "build"): string[] {
  const start = path.join(root, buildDir);
  const found: string[] = [];
  if (!existsSync(start)) return found;

  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (entry === ".git" || entry === "node_modules") continue;
        walk(full, depth + 1);
        continue;
      }
      if (ARTIFACT_PATTERNS.test(entry)) {
        found.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };

  walk(start, 0);
  return found.sort();
}

async function toolchainVersion(program: string, cwd: string): Promise<string | null> {
  const outcome = await runCommand(
    { program, args: ["--version"], display: `${program} --version` },
    { cwd, timeoutMs: 5000 },
  );
  if (!outcome.ok) return null;
  const line = (outcome.stdout || outcome.stderr).split("\n")[0]?.trim();
  return line && line.length > 0 ? line : null;
}

export interface ProjectBuildInput {
  dir: string;
  rtos: string;
  board?: string | null;
  commandOverride?: string | null;
  timeoutMs?: number;
  attempt?: number;
  /** Extra environment variables for the build process (e.g. ZEPHYR_BASE). */
  env?: Record<string, string>;
}

/** Reads text/data/bss from the binutils `size` tool, when it is installed. */
async function sizeSections(
  cwd: string,
  elfRelativePath: string | undefined,
): Promise<{ text: number; data: number; bss: number } | null> {
  if (!elfRelativePath) return null;
  for (const candidate of ["arm-zephyr-eabi-size", "size"]) {
    if (!resolveExecutable(candidate)) continue;
    const outcome = await runCommand(
      { program: candidate, args: [elfRelativePath], display: `${candidate} ${elfRelativePath}` },
      { cwd, timeoutMs: 15_000 },
    );
    if (outcome.ok && outcome.exitCode === 0) {
      const parsed = parseGnuSize(outcome.stdout);
      if (parsed) return parsed;
    }
  }
  return null;
}

function withBoardProfile(result: BuildResult, input: ProjectBuildInput): BuildResult {
  result.rtos = input.rtos;
  result.board = input.board ?? null;
  return result;
}

export async function runProjectBuild(input: ProjectBuildInput): Promise<BuildResult> {
  const spec = buildCommandForProject(input);

  if (!resolveExecutable(spec.program)) {
    return withBoardProfile(
      notAvailable(
        `toolchain unavailable: "${spec.program}" is not installed or not in PATH`,
        spec.display,
      ),
      input,
    );
  }

  const outcome = await runCommand(spec, {
    cwd: input.dir,
    timeoutMs: input.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
    env: input.env,
  });

  if (!outcome.ok) {
    if (outcome.code === "TIMEOUT") {
      const result = notAvailable(outcome.message, spec.display);
      result.stdout = outcome.stdout;
      result.stderr = outcome.stderr;
      result.durationMs = outcome.durationMs;
      return withBoardProfile(result, input);
    }
    return withBoardProfile(notAvailable(outcome.message, spec.display), input);
  }

  const version = await toolchainVersion(spec.program, input.dir);
  const artifacts = collectArtifacts(input.dir);

  // Real, byte-level validation of every artifact the build produced.
  const artifactDetails = inspectArtifacts(input.dir, artifacts);
  const elfArtifact = artifacts.find((entry) => entry.toLowerCase().endsWith(".elf"));
  const sections = await sizeSections(input.dir, elfArtifact);

  return withBoardProfile(
    realResult({
      command: spec.display,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      artifacts,
      artifactDetails,
      // Prefer the linker's own report; fall back to the `size` tool.
      memory: mergeMemoryUsage(parseMemoryReport(outcome.stdout), sections),
      attempt: input.attempt ?? 1,
      toolchain: version,
    }),
    input,
  );
}

export type GitOutcome =
  | { ok: true; steps: { command: string; exitCode: number; stdout: string; stderr: string }[] }
  | { ok: false; code: "TOOLCHAIN_NOT_AVAILABLE" | "GIT_FAILED"; message: string; steps: { command: string; exitCode: number; stdout: string; stderr: string }[] };

export async function gitInitCommit(
  dir: string,
  message = "Initial commit from EmbedFactory",
): Promise<GitOutcome> {
  if (!resolveExecutable("git")) {
    return {
      ok: false,
      code: "TOOLCHAIN_NOT_AVAILABLE",
      message: 'toolchain unavailable: "git" is not installed or not in PATH',
      steps: [],
    };
  }

  const steps: { command: string; exitCode: number; stdout: string; stderr: string }[] = [];
  const commands: CommandSpec[] = [
    { program: "git", args: ["init"], display: "git init" },
    { program: "git", args: ["add", "-A"], display: "git add -A" },
    {
      program: "git",
      args: [
        "-c",
        "user.name=EmbedFactory",
        "-c",
        "user.email=dev@embedfactory.local",
        "commit",
        "-m",
        message,
      ],
      display: `git commit -m "${message}"`,
    },
  ];

  for (const command of commands) {
    const outcome = await runCommand(command, { cwd: dir, timeoutMs: 60_000 });
    if (!outcome.ok) {
      steps.push({ command: command.display, exitCode: -1, stdout: outcome.stdout, stderr: outcome.stderr });
      return { ok: false, code: "GIT_FAILED", message: outcome.message, steps };
    }
    steps.push({
      command: command.display,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    });
    if (outcome.exitCode !== 0) {
      return {
        ok: false,
        code: "GIT_FAILED",
        message: `${command.display} exited with ${outcome.exitCode}: ${outcome.stderr.trim() || outcome.stdout.trim()}`,
        steps,
      };
    }
  }

  return { ok: true, steps };
}
