/**
 * Build adapters, selected by `profile.build.sistema`:
 *
 *   cmake        STM32 (CMake + arm-none-eabi-gcc), command from the profile
 *   zephyr-west  west build -b <board> -d build .
 *
 * A missing binary returns NOT_AVAILABLE with the name. A non-zero exit code is
 * NOT an error here: the compiler ran, the caller derives the verdict from it.
 */
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
