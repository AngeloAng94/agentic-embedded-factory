import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProfile } from "../core/profile";
import { notAvailable, toolOk } from "../core/toolResult";
import { runProfileDoctor } from "../tools/doctor";
import type { BinaryResolver } from "../tools/exec";
import type { ExpectedSegment, ProbeInspector, ProbeSnapshot } from "../tools/probe";
import { buildElf32, type FixtureSegment } from "./helpers/elfFixture";

const PROFILE_YAML = [
  "prodotto: DEMO-BOARD-01",
  "chip: { famiglia: stm32, flash_kb: 64, ram_kb: 16 }",
  'build: { sistema: cmake, toolchain: arm-none-eabi-gcc, comando: "cmake --build build" }',
  "flash: { tool: STM32_Programmer_CLI, interfaccia: swd }",
  "debug: { gdb_server: st, access_port: 0 }",
  "ancore: [APP]",
  "criteri:",
  '  - seriale_contiene: "BOOT OK"',
  "tentativi_max: 3",
].join("\n");

const profile = (() => {
  const result = loadProfile(PROFILE_YAML);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.profile;
})();

const SEGMENTS: FixtureSegment[] = [
  { address: 0x0800_0000, bytes: [0x01, 0x02, 0x03, 0x04], flags: 5 },
  { address: 0x0800_1000, bytes: [0xaa, 0xbb, 0xcc], flags: 5 },
];
const ELF_BYTES = buildElf32({ entry: 0x0800_0000, segments: SEGMENTS });

const dir = mkdtempSync(path.join(tmpdir(), "py-bench-doctor-test-"));
const elfPath = path.join(dir, "app.elf");
writeFileSync(elfPath, ELF_BYTES);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const resolveAll: BinaryResolver = (binary) => `/usr/bin/${binary}`;

function expected(): ExpectedSegment[] {
  return SEGMENTS.map((segment) => ({
    address: segment.address,
    bytes: new Uint8Array(segment.bytes),
  }));
}

function probeReturning(snapshot: ProbeSnapshot): ProbeInspector {
  return { inspect: () => toolOk(snapshot) };
}

function probeUnavailable(reason: string): ProbeInspector {
  return { inspect: () => notAvailable(reason) };
}

function matchingSnapshot(): ProbeSnapshot {
  return { busy: false, core: "running", flash: expected(), reason: null };
}

function doctor(snapshot: ProbeSnapshot, artifactPath: string | undefined = elfPath) {
  return runProfileDoctor(profile, {
    resolve: resolveAll,
    artifactPath,
    probe: probeReturning(snapshot),
  });
}

function status(report: ReturnType<typeof doctor>, id: string) {
  return report.target.checks.find((check) => check.id === id)?.status;
}

describe("doctor — target", () => {
  test("matching flash and a running core make the target READY", () => {
    const report = doctor(matchingSnapshot());

    expect(report.state).toBe("READY"); // environment
    expect(report.target.state).toBe("READY");
    expect(report.target.readsReliable).toBe(true);
    expect(report.target.reason).toBeNull();
    expect(status(report, "target.probe")).toBe("PASS");
    expect(status(report, "target.flash")).toBe("PASS");
    expect(status(report, "target.core")).toBe("PASS");
    expect(report.target.checks.find((check) => check.id === "target.flash")?.detail).toContain(
      "matches the ELF",
    );
  });

  test("a different flash image is a FAIL and makes every later read unreliable", () => {
    const flash = expected();
    flash[1]!.bytes[1] = 0x00;
    const report = doctor({ busy: false, core: "running", flash, reason: null });

    expect(report.target.state).toBe("NOT_READY");
    expect(report.target.readsReliable).toBe(false);
    expect(status(report, "target.flash")).toBe("FAIL");
    expect(report.target.checks.find((check) => check.id === "target.flash")?.detail).toContain(
      "differs at byte 1",
    );
    expect(report.target.checks.find((check) => check.id === "target.core")?.reliable).toBe(false);
    expect(report.target.reason).toContain("differs");
  });

  test("a busy probe is a FAIL and its other target checks are NOT_AVAILABLE", () => {
    const report = doctor({
      busy: true,
      core: "unreachable",
      flash: null,
      reason: "the probe is held by another process",
    });

    expect(report.target.state).toBe("NOT_READY");
    expect(report.target.readsReliable).toBe(false);
    expect(status(report, "target.probe")).toBe("FAIL");
    expect(status(report, "target.flash")).toBe("NOT_AVAILABLE");
    expect(status(report, "target.core")).toBe("FAIL");
    expect(report.target.checks.find((check) => check.id === "target.probe")?.detail).toContain(
      "busy",
    );
  });

  test("a halted core passes and is reported as halted", () => {
    const report = doctor({
      busy: false,
      core: "halted",
      flash: expected(),
      reason: null,
    });
    expect(status(report, "target.core")).toBe("PASS");
    expect(report.target.checks.find((check) => check.id === "target.core")?.detail).toContain(
      "halted",
    );
    expect(report.target.readsReliable).toBe(true);
  });

  test("a blocked core fails even when the flash matches", () => {
    const report = doctor({
      busy: false,
      core: "blocked",
      flash: expected(),
      reason: "target is locked",
    });
    expect(status(report, "target.core")).toBe("FAIL");
    expect(report.target.state).toBe("NOT_READY");
    expect(report.target.readsReliable).toBe(false);
    expect(report.target.checks.find((check) => check.id === "target.core")?.detail).toContain(
      "blocked",
    );
  });

  test("an unreachable core fails with the reason", () => {
    const report = doctor({
      busy: false,
      core: "unreachable",
      flash: null,
      reason: "connection refused",
    });
    expect(status(report, "target.core")).toBe("FAIL");
    expect(report.target.state).toBe("NOT_READY");
    expect(report.target.checks.find((check) => check.id === "target.core")?.detail).toContain(
      "connection refused",
    );
  });

  test("a probe that cannot inspect is NOT_AVAILABLE with the reason, not PASS", () => {
    const report = runProfileDoctor(profile, {
      resolve: resolveAll,
      artifactPath: elfPath,
      probe: probeUnavailable("gdb is not installed"),
    });

    expect(report.target.state).toBe("NOT_AVAILABLE");
    expect(report.target.readsReliable).toBe(false);
    expect(report.target.reason).toBe("gdb is not installed");
    for (const check of report.target.checks) {
      expect(check.status).toBe("NOT_AVAILABLE");
      expect(check.detail).toBe("gdb is not installed");
    }
  });

  test("without an ELF the flash check is NOT_AVAILABLE, even if the probe answers", () => {
    const report = doctor(matchingSnapshot(), "");

    expect(status(report, "target.probe")).toBe("PASS");
    expect(status(report, "target.core")).toBe("PASS");
    expect(status(report, "target.flash")).toBe("NOT_AVAILABLE");
    expect(report.target.state).toBe("NOT_AVAILABLE");
    expect(report.target.readsReliable).toBe(false);
    expect(report.target.reason).toContain("no artifact");
  });

  test("an unreadable ELF is NOT_AVAILABLE, not an empty comparison", () => {
    const report = doctor(matchingSnapshot(), path.join(dir, "missing.elf"));
    expect(status(report, "target.flash")).toBe("NOT_AVAILABLE");
    expect(report.target.state).toBe("NOT_AVAILABLE");
    expect(report.target.reason).toContain("cannot read");
  });

  test("environment READY is reported independently from the target", () => {
    const report = runProfileDoctor(profile, {
      resolve: resolveAll,
      artifactPath: elfPath,
      probe: probeUnavailable("no probe"),
    });
    expect(report.state).toBe("READY");
    expect(report.target.state).toBe("NOT_AVAILABLE");
  });
});
