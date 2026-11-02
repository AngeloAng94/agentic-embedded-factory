/**
 * Debug through GDB in batch mode.
 *
 * `commands` are `-ex` expressions; nothing is inferred. The remote endpoint is
 * `debug.access_port` from the profile. Missing gdb is NOT_AVAILABLE.
 */
import type { ProductProfile } from "../core/profile";
import { invalidProfile, notAvailable, toolOk, type ToolOutcome } from "../core/toolResult";
import {
  runCommand,
  systemResolver,
  type BinaryResolver,
  type ExecOptions,
  type ExecResult,
} from "./exec";

export function runGdbBatch(
  profile: ProductProfile,
  commands: string[],
  options: ExecOptions & { resolve?: BinaryResolver } = {},
): ToolOutcome<ExecResult> {
  const resolve = options.resolve ?? systemResolver;
  if (commands.length === 0) return invalidProfile("no gdb command was provided");

  const gdb = resolve("arm-none-eabi-gdb") ?? resolve("gdb");
  if (!gdb) return notAvailable("arm-none-eabi-gdb and gdb are not installed or not in PATH");

  const argv = [
    gdb,
    "-batch",
    "-ex",
    `target extended-remote :${profile.debug.access_port}`,
    ...commands.flatMap((command) => ["-ex", command]),
    "-ex",
    "detach",
  ];

  return toolOk(runCommand(argv, options));
}
