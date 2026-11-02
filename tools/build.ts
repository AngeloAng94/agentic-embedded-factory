/**
 * Build adapters, selected by `profile.build.sistema`:
 *
 *   cmake        STM32 (CMake + arm-none-eabi-gcc), command from the profile
 *   zephyr-west  west build -b <board> -d build .
 *
 * A missing binary returns NOT_AVAILABLE with the name. A non-zero exit code is
 * NOT an error here: the compiler ran, the caller derives the verdict from it.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import type { ProductProfile } from "../core/profile";
import { invalidProfile, notAvailable, toolOk, type ToolOutcome } from "../core/toolResult";
import {
  runCommand,
  systemResolver,
  tokenize,
  type BinaryResolver,
  type ExecOptions,
  type ExecResult,
} from "./exec";

export interface BuildPlan {
  adapter: "cmake" | "zephyr-west";
  argv: string[];
}

export function planBuild(
  profile: ProductProfile,
  options: { resolve?: BinaryResolver } = {},
): ToolOutcome<BuildPlan> {
  const resolve = options.resolve ?? systemResolver;

  if (profile.build.sistema === "zephyr-west") {
    if (!profile.board) {
      return invalidProfile("build.sistema is zephyr-west but the profile has no board");
    }
    if (!resolve("west")) return notAvailable('"west" is not installed or not in PATH');
    return toolOk({
      adapter: "zephyr-west",
      argv: ["west", "build", "-b", profile.board, "-d", "build", "."],
    });
  }

  const argv = tokenize(profile.build.comando);
  if (argv.length === 0) return invalidProfile("build.comando is empty");
  const tool = resolve(argv[0]!);
  if (!tool) return notAvailable(`"${argv[0]}" is not installed or not in PATH`);
  if (!resolve(profile.build.toolchain)) {
    return notAvailable(`"${profile.build.toolchain}" is not installed or not in PATH`);
  }
  return toolOk({ adapter: "cmake", argv });
}

export function runBuild(
  profile: ProductProfile,
  options: ExecOptions & { resolve?: BinaryResolver } = {},
): ToolOutcome<ExecResult> {
  const plan = planBuild(profile, options);
  if (!plan.ok) return plan;
  return toolOk(runCommand(plan.value.argv, options));
}

/**
 * Finds the ELF a build produced without trusting a path from the model. This
 * is only artifact discovery; the flash gate still hashes and checks the file.
 * Directories that never contain a firmware image are skipped, and the result
 * is deterministic (shortest path first).
 */
export function findElfArtifact(root: string, options: { maxDepth?: number } = {}): string | null {
  const maxDepth = options.maxDepth ?? 8;
  const found: string[] = [];
  const skip = new Set([".git", "node_modules", ".venv", "venv", "__pycache__"]);

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".elf")) {
        found.push(full);
      }
    }
  };

  walk(path.resolve(root), 0);
  return found.sort((left, right) => left.length - right.length || left.localeCompare(right))[0] ?? null;
}
