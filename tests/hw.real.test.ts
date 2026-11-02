/**
 * Real-hardware test. Skipped unless you explicitly opt in:
 *
 *   PY_BENCH_ALLOW_REAL_HW=1 \
 *   PY_BENCH_HW_PROFILE=profiles/demo-board.yaml \
 *   PY_BENCH_HW_PROJECT=/path/to/firmware \
 *   PY_BENCH_HW_ARTIFACT=/path/to/firmware/build/app.elf \
 *   bun test tests/hw.real.test.ts
 *
 * Optional: PY_BENCH_HW_ADDRESS (default 0x20000000), PY_BENCH_HW_LENGTH (default 4).
 * Nothing here runs by accident on a machine without a board.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadProfile, type ProductProfile } from "../core/profile";
import { runBuild } from "../tools/build";
import { runProfileDoctor } from "../tools/doctor";
import { runFlash } from "../tools/flash";
import { gdbReader, readStateTwice } from "../tools/readState";

const enabled = process.env.PY_BENCH_ALLOW_REAL_HW === "1";
const profilePath = process.env.PY_BENCH_HW_PROFILE ?? "";
const projectPath = process.env.PY_BENCH_HW_PROJECT ?? "";
const artifactPath = process.env.PY_BENCH_HW_ARTIFACT ?? "";

const missing = !enabled
  ? "set PY_BENCH_ALLOW_REAL_HW=1 to run against a real board"
  : !profilePath
    ? "set PY_BENCH_HW_PROFILE to the board profile"
    : !projectPath
      ? "set PY_BENCH_HW_PROJECT to the firmware project directory"
      : !artifactPath
        ? "set PY_BENCH_HW_ARTIFACT to the built firmware artifact"
        : null;

function hwProfile(): ProductProfile {
  const result = loadProfile(readFileSync(profilePath, "utf8"));
  if (!result.ok) throw new Error(`invalid profile ${profilePath}: ${result.errors.join("; ")}`);
  return result.profile;
}

describe.skipIf(missing !== null)("real hardware", () => {
  test("doctor reports READY", () => {
    const report = runProfileDoctor(hwProfile());
    const missingChecks = report.checks
      .filter((check) => check.required && check.status === "MISSING")
      .map((check) => `${check.label}: ${check.detail}`);
    if (report.state !== "READY") {
      throw new Error(`environment NOT_READY:\n${missingChecks.join("\n")}`);
    }
  });

  test("build runs and exits 0", () => {
    const result = runBuild(hwProfile(), { cwd: projectPath, timeoutMs: 600_000 });
    if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
    expect(result.verification).toBe("REAL");
    expect(result.value.exitCode).toBe(0);
  });

  test("flash runs and exits 0", () => {
    const result = runFlash(hwProfile(), artifactPath, { cwd: projectPath, timeoutMs: 300_000 });
    if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
    expect(result.verification).toBe("REAL");
    expect(result.value.exitCode).toBe(0);
  });

  test("read_state is stable across two reads", async () => {
    const address = process.env.PY_BENCH_HW_ADDRESS ?? "0x20000000";
    const length = Number(process.env.PY_BENCH_HW_LENGTH ?? "4");
    const result = await readStateTwice(gdbReader(hwProfile(), { address, length }));
    if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
    expect(result.verification).toBe("REAL");
    expect(result.value.stable).toBe(true);
  });
});
