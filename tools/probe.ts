/**
 * Target probe inspection over GDB.
 *
 * The doctor needs three facts that only the probe can answer: is another
 * process holding it, is the core running/halted/blocked/unreachable, and does
 * the flash contain the expected image. This module attempts a real GDB
 * connection and dumps the expected segments to temporary files.
 *
 * Without gdb, or when gdb cannot connect, the answer is NOT_AVAILABLE with the
 * reason: no invented "free probe" or "running core". A connection failure that
 * gdb really observed is reported as the corresponding core state instead.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProductProfile } from "../core/profile";
import { notAvailable, toolOk, type ToolOutcome } from "../core/toolResult";
import { runCommand, systemResolver, type BinaryResolver } from "./exec";

export type CoreState = "running" | "halted" | "blocked" | "unreachable";

export interface ExpectedSegment {
  address: number;
  bytes: Uint8Array;
}

export interface ProbeSnapshot {
  busy: boolean;
  core: CoreState;
  /** Bytes read back for every requested segment, or null when unreadable. */
  flash: ExpectedSegment[] | null;
  /** Why a field is null/unknown. */
  reason: string | null;
}

export interface ProbeInspector {
  inspect(
    profile: ProductProfile,
    expected: readonly ExpectedSegment[],
  ): ToolOutcome<ProbeSnapshot>;
}

export interface ProbeOptions {
  resolve?: BinaryResolver;
  timeoutMs?: number;
}

const BUSY_PATTERN = /busy|already in use|in use by|LIBUSB_ERROR_BUSY/i;
const BLOCKED_PATTERN = /locked|read.?out protection|not responding|no response|timed out|timeout/i;

function hex(address: number): string {
  return `0x${address.toString(16)}`;
}

function coreFromError(text: string): CoreState {
  return BLOCKED_PATTERN.test(text) ? "blocked" : "unreachable";
}

function summarize(result: { stdout: string; stderr: string; exitCode: number | null }): string {
  const text = (result.stderr || result.stdout).trim().replace(/\s+/g, " ");
  if (text !== "") return text.slice(0, 300);
  return `gdb exited with ${result.exitCode ?? "no exit code"}`;
}

export function gdbProbeInspector(options: ProbeOptions = {}): ProbeInspector {
  return {
    inspect(profile, expected) {
      const resolve = options.resolve ?? systemResolver;
      const gdb = resolve("arm-none-eabi-gdb") ?? resolve("gdb");
      if (!gdb) {
        return notAvailable("arm-none-eabi-gdb and gdb are not installed or not in PATH");
      }

      let dir: string;
      try {
        dir = mkdtempSync(path.join(tmpdir(), "py-bench-probe-"));
      } catch (error) {
        return notAvailable(
          `cannot create a temporary directory for the flash dump: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      try {
        const dumpCommands = expected.map((segment, index) => {
          const file = path.join(dir, `segment-${index}.bin`);
          return `dump binary memory ${file} ${hex(segment.address)} ${hex(segment.address + segment.bytes.length)}`;
        });

        const argv = [
          gdb,
          "-batch",
          "-ex",
          `target extended-remote :${profile.debug.access_port}`,
          ...dumpCommands.flatMap((command) => ["-ex", command]),
          "-ex",
          "info program",
          "-ex",
          "detach",
        ];

        let result;
        try {
          result = runCommand(argv, { timeoutMs: options.timeoutMs ?? 30_000 });
        } catch (error) {
          return notAvailable(
            `cannot run gdb: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const output = `${result.stdout}\n${result.stderr}`;

        if (BUSY_PATTERN.test(output)) {
          return toolOk({
            busy: true,
            core: "unreachable",
            flash: null,
            reason: "the probe is held by another process (busy or already in use)",
          });
        }

        if (result.exitCode !== 0) {
          return toolOk({
            busy: false,
            core: coreFromError(output),
            flash: null,
            reason: summarize(result),
          });
        }

        const running = /\bis running\b/i.test(output) || /\brunning\b/i.test(output);
        const core: CoreState = running ? "running" : "halted";

        const flash: ExpectedSegment[] = [];
        for (let index = 0; index < expected.length; index += 1) {
          try {
            flash.push({
              address: expected[index]!.address,
              bytes: new Uint8Array(readFileSync(path.join(dir, `segment-${index}.bin`))),
            });
          } catch {
            return toolOk({
              busy: false,
              core,
              flash: null,
              reason: `gdb connected (core ${core}) but the flash dump of segment ${index} is missing`,
            });
          }
        }

        return toolOk({ busy: false, core, flash, reason: null });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
