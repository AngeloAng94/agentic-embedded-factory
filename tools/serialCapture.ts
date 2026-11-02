/**
 * Serial capture.
 *
 * Opening a COM port with the right baud is OS-specific, so the profile owns a
 * capture command (e.g. a pyserial one-liner) with `{porta}` and `{baud}`
 * placeholders. Without a port, a command or the binary, the answer is
 * NOT_AVAILABLE: no invented serial output.
 */
import type { ProductProfile } from "../core/profile";
import { notAvailable, toolOk, type ToolOutcome } from "../core/toolResult";
import {
  runCommand,
  systemResolver,
  tokenize,
  type BinaryResolver,
  type ExecResult,
} from "./exec";

export function captureSerial(
  profile: ProductProfile,
  options: { timeoutMs?: number; cwd?: string; resolve?: BinaryResolver } = {},
): ToolOutcome<ExecResult> {
  const resolve = options.resolve ?? systemResolver;

  if (!profile.seriale) {
    return notAvailable("no serial port configured in the profile (seriale.porta)");
  }
  if (!profile.seriale.comando) {
    return notAvailable(
      "no serial capture command configured (seriale.comando): opening a port needs an OS-specific helper",
    );
  }

  const command = profile.seriale.comando
    .replaceAll("{porta}", profile.seriale.porta)
    .replaceAll("{baud}", String(profile.seriale.baud));
  const argv = tokenize(command);
  if (argv.length === 0) return notAvailable("seriale.comando is empty after substitution");
  if (!resolve(argv[0]!)) return notAvailable(`"${argv[0]}" is not installed or not in PATH`);

  return toolOk(
    runCommand(argv, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 10_000,
    }),
  );
}
