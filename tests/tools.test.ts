import { describe, expect, test } from "bun:test";
import { loadProfile, type ProductProfile } from "../core/profile";
import { planBuild, runBuild } from "../tools/build";
import { runGdbBatch } from "../tools/debug";
import { runProfileDoctor } from "../tools/doctor";
import { planFlash } from "../tools/flash";
import { gdbReader, parseGdbBytes, readState, type ReadStateOptions } from "../tools/readState";
import { runTargetTest } from "../tools/targetTest";
import type { BinaryResolver } from "../tools/exec";
import { FAKE_RUNNER, fakeBuild, fakeFlash, fakeRead } from "./helpers/fakeRunner";

const CMAKE_YAML = [
  "prodotto: DEMO-BOARD-01",
  "chip:",
  "  famiglia: stm32",
  "  regioni:",
  "    - { nome: FLASH, tipo: flash, origine: 0x08000000, dimensione: 2097152 }",
  "    - { nome: RAM, tipo: ram, origine: 0x20000000, dimensione: 655360 }",
  'build: { sistema: cmake, toolchain: arm-none-eabi-gcc, comando: "cmake --build build" }',
  "flash: { tool: STM32_Programmer_CLI, interfaccia: swd }",
  "debug: { gdb_server: st, access_port: 0 }",
  "ancore: [APP]",
  "criteri:",
  '  - seriale_contiene: "BOOT OK"',
  "tentativi_max: 3",
].join("\n");

const ZEPHYR_YAML = [
  "prodotto: DEMO-ZEPHYR-01",
  "board: demo_board",
  "chip:",
  "  famiglia: stm32",
  "  regioni:",
  "    - { nome: FLASH, tipo: flash, origine: 0x08000000, dimensione: 1048576 }",
  "    - { nome: RAM, tipo: ram, origine: 0x20000000, dimensione: 262144 }",
  'build: { sistema: zephyr-west, toolchain: arm-zephyr-eabi-gcc, comando: "west build" }',
  "flash: { tool: west, interfaccia: swd }",
  "debug: { gdb_server: st, access_port: 0 }",
  "ancore: [APP]",
  "criteri:",
  "  - test_su_target: pass",
  "tentativi_max: 2",
].join("\n");

function profileFrom(yaml: string): ProductProfile {
  const result = loadProfile(yaml);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.profile;
}

const cmakeProfile = profileFrom(CMAKE_YAML);
const zephyrProfile = profileFrom(ZEPHYR_YAML);

const none: BinaryResolver = () => null;
const has = (...names: string[]): BinaryResolver => (binary) =>
  names.includes(binary) ? `/usr/bin/${binary}` : null;

describe("doctor", () => {
  test("with nothing installed every required check is MISSING with a reason", () => {
    const report = runProfileDoctor(cmakeProfile, { resolve: none });

    expect(report.state).toBe("NOT_READY");
    const required = report.checks.filter((check) => check.required);
    expect(required.length).toBeGreaterThan(0);
    for (const check of required) {
      expect(check.status).toBe("MISSING");
      expect(check.detail.length).toBeGreaterThan(0);
    }
    expect(report.checks.some((check) => check.status === "PASS")).toBe(false);
  });

  test("READY only when every required binary was really found", () => {
    const report = runProfileDoctor(cmakeProfile, {
      resolve: has("cmake", "arm-none-eabi-gcc", "STM32_Programmer_CLI", "arm-none-eabi-gdb"),
    });
    expect(report.state).toBe("READY");
    expect(report.checks.every((check) => check.status === "PASS")).toBe(true);
  });

  test("a missing debugger keeps the environment NOT_READY", () => {
    const report = runProfileDoctor(cmakeProfile, {
      resolve: has("cmake", "arm-none-eabi-gcc", "STM32_Programmer_CLI"),
    });
    expect(report.state).toBe("NOT_READY");
    expect(report.checks.find((check) => check.id === "debug.gdb")?.status).toBe("MISSING");
  });
});

describe("build adapters", () => {
  test("cmake: missing cmake is NOT_AVAILABLE with the binary name", () => {
    const plan = planBuild(cmakeProfile, { resolve: none });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("NOT_AVAILABLE");
      expect(plan.reason).toContain('"cmake"');
      expect(plan.reason).toContain("PATH");
    }
  });

  test("cmake: the profile command becomes the argv", () => {
    const plan = planBuild(cmakeProfile, { resolve: has("cmake", "arm-none-eabi-gcc") });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.value.adapter).toBe("cmake");
      expect(plan.value.argv).toEqual(["cmake", "--build", "build"]);
    }
  });

  test("cmake: a missing toolchain is NOT_AVAILABLE even if cmake exists", () => {
    const plan = planBuild(cmakeProfile, { resolve: has("cmake") });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("arm-none-eabi-gcc");
  });

  test("zephyr-west: uses the board from the profile", () => {
    const plan = planBuild(zephyrProfile, { resolve: has("west") });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.value.adapter).toBe("zephyr-west");
      expect(plan.value.argv).toEqual(["west", "build", "-b", "demo_board", "-d", "build", "."]);
    }
  });

  test("zephyr-west: missing west is NOT_AVAILABLE", () => {
    const plan = planBuild(zephyrProfile, { resolve: none });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain('"west"');
  });

  test("runBuild never pretends to have run a compiler", () => {
    const result = runBuild(cmakeProfile, { resolve: none, cwd: process.cwd() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_AVAILABLE");
  });
});

describe("flash adapters", () => {
  test("STM32_Programmer_CLI: argv comes from the profile", () => {
    const plan = planFlash(cmakeProfile, "build/app.elf", {
      resolve: has("STM32_Programmer_CLI"),
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.value).toEqual(["STM32_Programmer_CLI", "-c", "port=SWD", "-w", "build/app.elf", "-v"]);
  });

  test("a missing flash tool is NOT_AVAILABLE", () => {
    const plan = planFlash(cmakeProfile, "build/app.elf", { resolve: none });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("NOT_AVAILABLE");
      expect(plan.reason).toContain("STM32_Programmer_CLI");
    }
  });

  test("probe-rs needs a target and passes the chip", () => {
    const probeProfile = profileFrom(
      CMAKE_YAML.replace(
        "flash: { tool: STM32_Programmer_CLI, interfaccia: swd }",
        "flash: { tool: probe-rs, interfaccia: swd, target: demo-chip }",
      ),
    );
    const plan = planFlash(probeProfile, "build/app.elf", { resolve: has("probe-rs") });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.value).toEqual(["probe-rs", "download", "--chip", "demo-chip", "build/app.elf"]);
  });

  test("an empty artifact is an invalid request", () => {
    const plan = planFlash(cmakeProfile, "  ");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("INVALID_PROFILE");
  });
});

describe("read_state — declared mode", () => {
  const real = (bytes: number[]) => async () => ({
    ok: true as const,
    bytes,
    verification: "REAL" as const,
    tool: "gdb",
  });

  const sequence = (values: number[][]) => {
    let index = 0;
    return async () => {
      const bytes = values[Math.min(index, values.length - 1)]!;
      index += 1;
      return { ok: true as const, bytes, verification: "REAL" as const, tool: "gdb" };
    };
  };

  test("stable: two identical REAL reads pass", async () => {
    const result = await readState(real([1, 2, 3]), { mode: "stable" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verification).toBe("REAL");
      expect(result.value.mode).toBe("stable");
      expect(result.value.relation).toBe("equal");
      expect(result.value.first).toEqual([1, 2, 3]);
    }
  });

  test("stable: a changing value fails", async () => {
    const result = await readState(sequence([[1, 2], [1, 3]]), { mode: "stable" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FAILED");
      expect(result.reason).toContain("stable read failed");
    }
  });

  test("progressing: an advancing counter passes", async () => {
    const result = await readState(sequence([[0x0f], [0x10]]), {
      mode: "progressing",
      direction: "increasing",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.relation).toBe("increasing");
      expect(result.value.firstValue).toBe("15");
      expect(result.value.secondValue).toBe("16");
    }
  });

  test("progressing: a decreasing value passes when declared", async () => {
    const result = await readState(sequence([[9], [7]]), {
      mode: "progressing",
      direction: "decreasing",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.relation).toBe("decreasing");
  });

  test("progressing: numeric equality beats byte length", async () => {
    const result = await readState(sequence([[0x01], [0x01, 0x00]]), {
      mode: "progressing",
      direction: "increasing",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("did not change");
  });

  test("progressing: an unchanged value fails", async () => {
    const result = await readState(real([4]), { mode: "progressing", direction: "increasing" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FAILED");
      expect(result.reason).toContain("did not change");
    }
  });

  test("progressing: the wrong direction fails", async () => {
    const result = await readState(sequence([[9], [7]]), {
      mode: "progressing",
      direction: "increasing",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FAILED");
      expect(result.reason).toContain("expected increasing");
    }
  });

  test("progressing without a direction is an invalid request", async () => {
    const result = await readState(real([1]), { mode: "progressing" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_REQUEST");
  });

  test("an undeclared mode is an invalid request", async () => {
    const result = await readState(real([1]), {} as ReadStateOptions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_REQUEST");
  });

  test("a simulated read stays SIMULATED, never REAL", async () => {
    const result = await readState(
      async () => ({ ok: true, bytes: [1, 2], verification: "SIMULATED", tool: "fake" }),
      { mode: "stable" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verification).toBe("SIMULATED");
  });

  test("an unreliable target refuses the read", async () => {
    const result = await readState(real([1]), {
      mode: "stable",
      target: { reliable: false, reason: "flash differs from the ELF" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FAILED");
      expect(result.reason).toContain("flash differs");
    }
  });

  test("a read error is NOT_AVAILABLE with its reason", async () => {
    const result = await readState(async () => ({ ok: false, reason: "probe not connected" }), {
      mode: "stable",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NOT_AVAILABLE");
      expect(result.reason).toContain("probe not connected");
    }
  });

  test("gdbReader without gdb is NOT_AVAILABLE, not empty bytes", async () => {
    const result = await readState(
      gdbReader(cmakeProfile, { address: 0x20000000, length: 4 }, { resolve: none }),
      { mode: "stable" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("gdb");
  });

  test("parses gdb x/4xb output", () => {
    const stdout = "0x20000000:\t0x12\t0x34\t0x56\t0x78\n";
    expect(parseGdbBytes(stdout)).toEqual([0x12, 0x34, 0x56, 0x78]);
  });
});

describe("debug and target test", () => {
  test("gdb without the binary is NOT_AVAILABLE", () => {
    const result = runGdbBatch(cmakeProfile, ["info registers"], { resolve: none });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_AVAILABLE");
  });

  test("no gdb command is an invalid request", () => {
    const result = runGdbBatch(cmakeProfile, [], { resolve: none });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PROFILE");
  });

  test("target test without a runner is NOT_AVAILABLE, never passed", async () => {
    const result = await runTargetTest(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_AVAILABLE");
  });
});

describe("fake runner", () => {
  test("is explicitly fake and every answer is SIMULATED", () => {
    expect(FAKE_RUNNER.kind).toBe("FAKE");
    expect(FAKE_RUNNER.simulated).toBe(true);
    for (const outcome of [fakeBuild(), fakeFlash(), fakeRead()]) {
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.verification).toBe("SIMULATED");
    }
  });
});
