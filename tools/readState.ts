/**
 * `read_state`, with the double read the product requires.
 *
 * Two independent reads must return the same bytes. A mismatch is a failure,
 * not an average: a flaky probe must never be reported as stable state.
 * Simulated reads stay SIMULATED and can never become evidence.
 */
import type { ProductProfile } from "../core/profile";
import { notAvailable, toolFailed, toolOk, type ToolOutcome } from "../core/toolResult";
import { runCommand, systemResolver, type BinaryResolver, type ExecResult } from "./exec";

export interface ReadOnceOk {
  ok: true;
  bytes: number[];
  verification: "REAL" | "SIMULATED";
  tool: string;
}

export type ReadOnceResult = ReadOnceOk | { ok: false; reason: string };
export type ReadOnce = () => Promise<ReadOnceResult>;

export interface ReadStateValue {
  first: number[];
  second: number[];
  stable: boolean;
}

export async function readStateTwice(readOnce: ReadOnce): Promise<ToolOutcome<ReadStateValue>> {
  let first: ReadOnceResult;
  try {
    first = await readOnce();
  } catch (error) {
    return notAvailable(`read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!first.ok) return notAvailable(first.reason);

  let second: ReadOnceResult;
  try {
    second = await readOnce();
  } catch (error) {
    return notAvailable(`second read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!second.ok) return notAvailable(second.reason);

  const same =
    first.bytes.length === second.bytes.length &&
    first.bytes.every((byte, index) => byte === second.bytes[index]);

  if (!same) {
    return toolFailed(
      `unstable read: first read ${first.bytes.length} byte(s) [${first.bytes.join(" ")}], second read ${second.bytes.length} byte(s) [${second.bytes.join(" ")}]`,
    );
  }

  const verification =
    first.verification === "REAL" && second.verification === "REAL" ? "REAL" : "SIMULATED";

  return toolOk({ first: first.bytes, second: second.bytes, stable: true }, verification);
}

/** Parses `x/4xb` output: `0x20000000:\t0x12\t0x34`. */
export function parseGdbBytes(stdout: string): number[] {
  const bytes: number[] = [];
  for (const line of stdout.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    for (const match of line.slice(colon + 1).matchAll(/0x([0-9a-fA-F]{2})\b/g)) {
      bytes.push(Number.parseInt(match[1]!, 16));
    }
  }
  return bytes;
}

/** Real reader over GDB batch. Missing gdb/port is NOT_AVAILABLE. */
export function gdbReader(
  profile: ProductProfile,
  input: { address: string | number; length: number },
  options: { resolve?: BinaryResolver } = {},
): ReadOnce {
  const resolve = options.resolve ?? systemResolver;
  const gdb = resolve("arm-none-eabi-gdb") ?? resolve("gdb");
  const address =
    typeof input.address === "number" ? `0x${input.address.toString(16)}` : input.address;

  return async (): Promise<ReadOnceResult> => {
    if (!gdb) return { ok: false, reason: "arm-none-eabi-gdb and gdb are not installed or not in PATH" };
    if (!Number.isInteger(input.length) || input.length <= 0) {
      return { ok: false, reason: "read_state length must be a positive integer" };
    }

    const argv = [
      gdb,
      "-batch",
      "-ex",
      `target extended-remote :${profile.debug.access_port}`,
      "-ex",
      `x/${input.length}xb ${address}`,
      "-ex",
      "detach",
    ];
    const result: ExecResult = runCommand(argv, { timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        reason: `gdb exited with ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
      };
    }

    const bytes = parseGdbBytes(result.stdout);
    if (bytes.length < input.length) {
      return {
        ok: false,
        reason: `gdb returned ${bytes.length} byte(s) for a ${input.length}-byte read`,
      };
    }
    return { ok: true, bytes: bytes.slice(0, input.length), verification: "REAL", tool: "gdb" };
  };
}
