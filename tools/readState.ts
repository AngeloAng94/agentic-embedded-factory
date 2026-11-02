/**
 * `read_state`, with the mode the caller must declare.
 *
 *   stable       two reads must be identical: a halted core, configuration
 *                registers, a checksum that must not move.
 *   progressing  two reads must differ in the expected direction: a counter
 *                that advances proves the core is executing.
 *
 * A stable read that changes is a failure. A progressing read that does not
 * move, or moves backwards, is a failure too. Two different values on a stable
 * read are never averaged. Simulated reads stay SIMULATED.
 *
 * If the doctor found that the flash does not match the expected ELF, the
 * caller passes `target.reliable = false` and this tool refuses to report a
 * state: reads after a wrong image are not evidence.
 */
import type { ProductProfile } from "../core/profile";
import {
  invalidRequest,
  notAvailable,
  toolFailed,
  toolOk,
  type ToolOutcome,
} from "../core/toolResult";
import { runCommand, systemResolver, type BinaryResolver, type ExecResult } from "./exec";

export type ReadStateMode = "stable" | "progressing";
export type ReadDirection = "increasing" | "decreasing";
export type ReadRelation = "equal" | "increasing" | "decreasing";

export interface ReadOnceOk {
  ok: true;
  bytes: number[];
  verification: "REAL" | "SIMULATED";
  tool: string;
}

export type ReadOnceResult = ReadOnceOk | { ok: false; reason: string };
export type ReadOnce = () => Promise<ReadOnceResult>;

export interface ReadStateOptions {
  mode: ReadStateMode;
  /** Required when mode is `progressing`. */
  direction?: ReadDirection;
  /** Result of the doctor's target checks; false refuses the read. */
  target?: { reliable: boolean; reason?: string | null };
}

export interface ReadStateValue {
  mode: ReadStateMode;
  first: number[];
  second: number[];
  /** Unsigned little-endian value as a decimal string. */
  firstValue: string;
  secondValue: string;
  relation: ReadRelation;
}

/** Unsigned little-endian integer of the read bytes. */
export function bytesToUnsigned(bytes: readonly number[]): bigint {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt((bytes[index] ?? 0) & 0xff);
  }
  return value;
}

function sameBytes(first: readonly number[], second: readonly number[]): boolean {
  return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

async function readOne(
  readOnce: ReadOnce,
  label: string,
): Promise<ToolOutcome<ReadOnceOk>> {
  try {
    const result = await readOnce();
    if (!result.ok) return notAvailable(`${label}: ${result.reason}`);
    return toolOk(result, result.verification);
  } catch (error) {
    return notAvailable(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readState(
  readOnce: ReadOnce,
  options: ReadStateOptions,
): Promise<ToolOutcome<ReadStateValue>> {
  if (!options || (options.mode !== "stable" && options.mode !== "progressing")) {
    return invalidRequest('read_state mode is required: "stable" or "progressing"');
  }
  if (
    options.mode === "progressing" &&
    options.direction !== "increasing" &&
    options.direction !== "decreasing"
  ) {
    return invalidRequest('progressing reads need a direction: "increasing" or "decreasing"');
  }
  if (options.target && options.target.reliable === false) {
    return toolFailed(
      `target reads are unreliable: ${options.target.reason ?? "the flash does not match the expected ELF"}`,
    );
  }

  const first = await readOne(readOnce, "first read");
  if (!first.ok) return first;
  const second = await readOne(readOnce, "second read");
  if (!second.ok) return second;

  const firstValue = bytesToUnsigned(first.value.bytes);
  const secondValue = bytesToUnsigned(second.value.bytes);
  const equal = sameBytes(first.value.bytes, second.value.bytes);
  const relation: ReadRelation =
    secondValue === firstValue ? "equal" : secondValue > firstValue ? "increasing" : "decreasing";

  const verification =
    first.value.verification === "REAL" && second.value.verification === "REAL"
      ? "REAL"
      : "SIMULATED";

  if (options.mode === "stable") {
    if (!equal) {
      return toolFailed(
        `stable read failed: first read [${first.value.bytes.join(" ")}], second read [${second.value.bytes.join(" ")}]`,
      );
    }
    return toolOk(
      {
        mode: "stable",
        first: first.value.bytes,
        second: second.value.bytes,
        firstValue: firstValue.toString(),
        secondValue: secondValue.toString(),
        relation,
      },
      verification,
    );
  }

  if (relation === "equal") {
    return toolFailed(
      `progressing read failed: the value did not change (${firstValue.toString()}), the core is not advancing`,
    );
  }
  if (relation !== options.direction) {
    return toolFailed(
      `progressing read failed: value moved ${relation}, expected ${options.direction} (${firstValue.toString()} → ${secondValue.toString()})`,
    );
  }

  return toolOk(
    {
      mode: "progressing",
      first: first.value.bytes,
      second: second.value.bytes,
      firstValue: firstValue.toString(),
      secondValue: secondValue.toString(),
      relation,
    },
    verification,
  );
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
