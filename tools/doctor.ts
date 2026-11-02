/**
 * Profile-driven doctor.
 *
 * It probes only what the profile needs: build adapter, toolchain, flash tool,
 * debugger, serial capture. Every check is PASS or MISSING with the reason; the
 * overall state is READY only when every required check passed. There is no
 * UNKNOWN here because `which` and `existsSync` always answer.
 */
import { existsSync } from "node:fs";
import type { ProductProfile } from "../core/profile";
import { tokenize, type BinaryResolver, systemResolver } from "./exec";

export interface DoctorCheck {
  id: string;
  label: string;
  required: boolean;
  status: "PASS" | "MISSING";
  detail: string;
}

export interface ProfileDoctorReport {
  profile: string;
  checks: DoctorCheck[];
  state: "READY" | "NOT_READY";
}

export function runProfileDoctor(
  profile: ProductProfile,
  options: { resolve?: BinaryResolver } = {},
): ProfileDoctorReport {
  const resolve = options.resolve ?? systemResolver;
  const checks: DoctorCheck[] = [];

  const binary = (id: string, label: string, name: string, required = true): void => {
    const found = resolve(name);
    checks.push({
      id,
      label,
      required,
      status: found ? "PASS" : "MISSING",
      detail: found ?? `${name} not found in PATH`,
    });
  };

  if (profile.build.sistema === "zephyr-west") {
    binary("build.west", "west", "west");
    binary("build.cmake", "cmake", "cmake");
    binary("build.ninja", "ninja", "ninja", false);
  } else {
    binary("build.cmake", "cmake", "cmake");
    binary("build.toolchain", `toolchain ${profile.build.toolchain}`, profile.build.toolchain);
  }

  binary("flash.tool", `flash ${profile.flash.tool}`, profile.flash.tool);

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
      binary("serial.command", `serial command ${argv[0] ?? ""}`, argv[0] ?? "", true);
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
  return { profile: profile.prodotto, checks, state: ready ? "READY" : "NOT_READY" };
}
