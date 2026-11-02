/**
 * Profile-driven doctor.
 *
 * Environment checks: the binaries and serial helper the profile needs. Every
 * check is PASS or MISSING with the reason; `state` is READY only when every
 * required one passed.
 *
 * Target checks, once an ELF and a probe are available:
 *   - is the probe held by another process?
 *   - is the core running, halted, blocked or unreachable?
 *   - does the flash contain the same bytes as the expected ELF?
 *
 * A flash mismatch is a FAIL and marks every later read as unreliable; the
 * report carries `target.readsReliable` and the reason, which `read_state`
 * refuses to ignore. If a tool cannot answer, the check is NOT_AVAILABLE with
 * the reason: no invented "free probe" and no invented "running core".
 */
import { existsSync } from "node:fs";
import { readElfImage, type ElfSegment } from "../core/elfImage";
import type { ProductProfile } from "../core/profile";
import { tokenize, type BinaryResolver, systemResolver } from "./exec";
import { gdbProbeInspector, type ProbeInspector, type ProbeSnapshot } from "./probe";

export type DoctorStatus = "PASS" | "MISSING" | "FAIL" | "NOT_AVAILABLE";

export interface DoctorCheck {
  id: string;
  label: string;
  required: boolean;
  status: DoctorStatus;
  detail: string;
  /** False when an earlier flash mismatch makes this reading untrustworthy. */
  reliable?: boolean;
}

export interface TargetDoctorReport {
  state: "READY" | "NOT_READY" | "NOT_AVAILABLE";
  /** Only true when probe, flash image and core state were all verified. */
  readsReliable: boolean;
  reason: string | null;
  checks: DoctorCheck[];
}

export interface ProfileDoctorReport {
  profile: string;
  /** Environment checks (toolchain, flash tool, debugger, serial). */
  checks: DoctorCheck[];
  target: TargetDoctorReport;
  /** Environment state only; the target has its own `target.state`. */
  state: "READY" | "NOT_READY";
}

export interface DoctorOptions {
  resolve?: BinaryResolver;
  /** ELF that should be on the board. */
  artifactPath?: string;
  /** Injectable for tests; defaults to the real GDB inspector. */
  probe?: ProbeInspector;
}

function hex(address: number): string {
  return `0x${address.toString(16)}`;
}

/** Compares the expected loadable segments with the bytes read back from flash. */
export function compareFlash(
  expected: readonly { address: number; bytes: Uint8Array }[],
  actual: readonly { address: number; bytes: Uint8Array }[],
): { same: boolean; detail: string } {
  if (actual.length !== expected.length) {
    return {
      same: false,
      detail: `expected ${expected.length} segment(s), the probe read ${actual.length}`,
    };
  }

  let total = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index]!;
    const got = actual[index]!;
    if (want.address !== got.address) {
      return {
        same: false,
        detail: `segment ${index} is at ${hex(got.address)}, expected ${hex(want.address)}`,
      };
    }
    if (want.bytes.length !== got.bytes.length) {
      return {
        same: false,
        detail: `segment ${index} at ${hex(want.address)} is ${got.bytes.length} B, expected ${want.bytes.length} B`,
      };
    }
    for (let offset = 0; offset < want.bytes.length; offset += 1) {
      if (want.bytes[offset] !== got.bytes[offset]) {
        return {
          same: false,
          detail: `segment ${index} at ${hex(want.address)} differs at byte ${offset}: expected 0x${want.bytes[offset]!.toString(16).padStart(2, "0")}, read 0x${got.bytes[offset]!.toString(16).padStart(2, "0")}`,
        };
      }
    }
    total += want.bytes.length;
  }

  return {
    same: true,
    detail: `flash matches the ELF: ${expected.length} segment(s), ${total} B`,
  };
}

function environmentCheck(
  checks: DoctorCheck[],
  id: string,
  label: string,
  name: string,
  found: string | null,
  required = true,
): void {
  checks.push({
    id,
    label,
    required,
    status: found ? "PASS" : "MISSING",
    detail: found ?? `${name} not found in PATH`,
  });
}

function targetReport(checks: DoctorCheck[]): TargetDoctorReport {
  const failed = checks.filter((check) => check.status === "FAIL");
  const unavailable = checks.filter((check) => check.status === "NOT_AVAILABLE");
  const state =
    failed.length > 0
      ? "NOT_READY"
      : unavailable.length > 0
        ? "NOT_AVAILABLE"
        : "READY";
  const reason = failed[0]?.detail ?? unavailable[0]?.detail ?? null;
  return {
    state,
    readsReliable: state === "READY",
    reason,
    checks,
  };
}

function inspectTarget(
  profile: ProductProfile,
  options: DoctorOptions,
  resolve: BinaryResolver,
): TargetDoctorReport {
  const probe = options.probe ?? gdbProbeInspector({ resolve });

  let expected: ElfSegment[] = [];
  let elfReason: string | null = null;
  if (!options.artifactPath) {
    elfReason = "no artifact was given to doctor: the flash cannot be compared with an expected ELF";
  } else {
    const parsed = readElfImage(options.artifactPath);
    if (!parsed.ok) elfReason = parsed.reason;
    else if (parsed.image.segments.length === 0) {
      elfReason = "the ELF has no loadable segments to compare";
    } else {
      expected = parsed.image.segments;
    }
  }

  const inspection = probe.inspect(profile, expected);
  if (!inspection.ok) {
    const checks: DoctorCheck[] = [
      {
        id: "target.probe",
        label: "debug probe",
        required: true,
        status: "NOT_AVAILABLE",
        detail: inspection.reason,
      },
      {
        id: "target.flash",
        label: "flash image",
        required: true,
        status: "NOT_AVAILABLE",
        detail: inspection.reason,
      },
      {
        id: "target.core",
        label: "core state",
        required: true,
        status: "NOT_AVAILABLE",
        detail: inspection.reason,
      },
    ];
    return { state: "NOT_AVAILABLE", readsReliable: false, reason: inspection.reason, checks };
  }

  const snapshot: ProbeSnapshot = inspection.value;

  const probeCheck: DoctorCheck = snapshot.busy
    ? {
        id: "target.probe",
        label: "debug probe",
        required: true,
        status: "FAIL",
        detail: "the probe is busy: another process is holding it",
      }
    : {
        id: "target.probe",
        label: "debug probe",
        required: true,
        status: "PASS",
        detail: "the probe answered",
      };

  let flashCheck: DoctorCheck;
  if (elfReason !== null) {
    flashCheck = {
      id: "target.flash",
      label: "flash image",
      required: true,
      status: "NOT_AVAILABLE",
      detail: elfReason,
    };
  } else if (snapshot.flash === null) {
    flashCheck = {
      id: "target.flash",
      label: "flash image",
      required: true,
      status: "NOT_AVAILABLE",
      detail: snapshot.reason ?? "the probe could not read the flash image",
    };
  } else {
    const comparison = compareFlash(expected, snapshot.flash);
    flashCheck = {
      id: "target.flash",
      label: "flash image",
      required: true,
      status: comparison.same ? "PASS" : "FAIL",
      detail: comparison.detail,
    };
  }

  const coreDetail: Record<ProbeSnapshot["core"], string> = {
    running: "the core is running",
    halted: "the core is halted under the debugger",
    blocked: `the core is blocked${snapshot.reason ? `: ${snapshot.reason}` : ""}`,
    unreachable: `the core is unreachable${snapshot.reason ? `: ${snapshot.reason}` : ""}`,
  };
  const coreCheck: DoctorCheck = {
    id: "target.core",
    label: "core state",
    required: true,
    status:
      snapshot.core === "blocked" || snapshot.core === "unreachable" ? "FAIL" : "PASS",
    detail: coreDetail[snapshot.core],
    reliable: flashCheck.status !== "FAIL",
  };

  return targetReport([probeCheck, flashCheck, coreCheck]);
}

export function runProfileDoctor(
  profile: ProductProfile,
  options: DoctorOptions = {},
): ProfileDoctorReport {
  const resolve = options.resolve ?? systemResolver;
  const checks: DoctorCheck[] = [];

  if (profile.build.sistema === "zephyr-west") {
    environmentCheck(checks, "build.west", "west", "west", resolve("west"));
    environmentCheck(checks, "build.cmake", "cmake", "cmake", resolve("cmake"));
    environmentCheck(checks, "build.ninja", "ninja", "ninja", resolve("ninja"), false);
  } else {
    environmentCheck(checks, "build.cmake", "cmake", "cmake", resolve("cmake"));
    environmentCheck(
      checks,
      "build.toolchain",
      `toolchain ${profile.build.toolchain}`,
      profile.build.toolchain,
      resolve(profile.build.toolchain),
    );
  }

  environmentCheck(
    checks,
    "flash.tool",
    `flash ${profile.flash.tool}`,
    profile.flash.tool,
    resolve(profile.flash.tool),
  );

  const gdb = resolve("arm-none-eabi-gdb") ?? resolve("gdb");
  checks.push({
    id: "debug.gdb",
    label: "gdb",
    required: true,
    status: gdb ? "PASS" : "MISSING",
    detail: gdb ?? "arm-none-eabi-gdb and gdb not found in PATH",
  });

  if (profile.seriale) {
    if (profile.seriale.comando) {
      const argv = tokenize(profile.seriale.comando);
      environmentCheck(
        checks,
        "serial.command",
        `serial command ${argv[0] ?? ""}`,
        argv[0] ?? "",
        argv[0] ? resolve(argv[0]) : null,
      );
    } else {
      const present = existsSync(profile.seriale.porta);
      checks.push({
        id: "serial.port",
        label: `serial ${profile.seriale.porta} @ ${profile.seriale.baud}`,
        required: true,
        status: present ? "PASS" : "MISSING",
        detail: present
          ? profile.seriale.porta
          : `${profile.seriale.porta} is not present on this machine; set seriale.comando to use a helper`,
      });
    }
  }

  const ready = checks.every((check) => !check.required || check.status === "PASS");
  return {
    profile: profile.prodotto,
    checks,
    target: inspectTarget(profile, options, resolve),
    state: ready ? "READY" : "NOT_READY",
  };
}
