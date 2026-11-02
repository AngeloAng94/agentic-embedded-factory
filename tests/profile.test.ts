import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { editableAnchors, loadProfile, profileCriteria } from "../core/profile";

const BASE = [
  "prodotto: DEMO-BOARD-01",
  "chip: { famiglia: stm32, flash_kb: 2048, ram_kb: 640 }",
  "build: { sistema: cmake, toolchain: arm-none-eabi-gcc, comando: \"cmake --build build\" }",
  "flash: { tool: STM32_Programmer_CLI, interfaccia: swd }",
  "debug: { gdb_server: st, access_port: 0 }",
  "ancore: [APP, LED]",
  "criteri:",
  "  - seriale_contiene: \"BOOT OK\"",
  "  - log_non_contiene: [HardFault, ERROR]",
  "  - test_su_target: pass",
  "tentativi_max: 3",
  "",
].join("\n");

function errorsOf(text: string): string {
  const result = loadProfile(text);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.errors.join(" | ");
}

describe("product profile", () => {
  test("the shipped example is valid and entirely fictional", () => {
    const text = readFileSync(path.join(import.meta.dir, "../profiles/demo-board.yaml"), "utf8");
    const result = loadProfile(text);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.prodotto).toBe("DEMO-BOARD-01");
      expect(result.profile.chip).toEqual({ famiglia: "stm32", flash_kb: 2048, ram_kb: 640 });
      expect(result.profile.ancore).toEqual(["APP", "LED"]);
      expect(result.profile.criteri).toHaveLength(3);
      expect(result.profile.tentativi_max).toBe(3);
      expect(editableAnchors(result.profile)).toEqual(["APP", "LED"]);
    }
  });

  test("a valid profile parses every criterion", () => {
    const result = loadProfile(BASE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.criteri[0]).toEqual({ seriale_contiene: "BOOT OK" });
      expect(result.profile.criteri[1]).toEqual({ log_non_contiene: ["HardFault", "ERROR"] });
      expect(result.profile.criteri[2]).toEqual({ test_su_target: "pass" });
    }
  });

  test("rejects a non-numeric flash size", () => {
    expect(errorsOf(BASE.replace("flash_kb: 2048", "flash_kb: tanto"))).toContain("chip.flash_kb");
  });

  test("rejects a zero flash size", () => {
    expect(errorsOf(BASE.replace("flash_kb: 2048", "flash_kb: 0"))).toContain("chip.flash_kb");
  });

  test("rejects an unknown build system", () => {
    expect(errorsOf(BASE.replace("sistema: cmake", "sistema: bazel"))).toContain("build.sistema");
  });

  test("rejects an unknown flash interface", () => {
    expect(errorsOf(BASE.replace("interfaccia: swd", "interfaccia: spi"))).toContain(
      "flash.interfaccia",
    );
  });

  test("accepts the Zephyr adapter only when the board is declared", () => {
    const zephyr = BASE.replace(
      'build: { sistema: cmake, toolchain: arm-none-eabi-gcc, comando: "cmake --build build" }',
      'board: demo_board\nbuild: { sistema: zephyr-west, toolchain: arm-zephyr-eabi-gcc, comando: "west build" }',
    );
    const result = loadProfile(zephyr);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.build.sistema).toBe("zephyr-west");
      expect(result.profile.board).toBe("demo_board");
    }

    const withoutBoard = BASE.replace(
      'build: { sistema: cmake, toolchain: arm-none-eabi-gcc, comando: "cmake --build build" }',
      'build: { sistema: zephyr-west, toolchain: arm-zephyr-eabi-gcc, comando: "west build" }',
    );
    expect(errorsOf(withoutBoard)).toContain("board");
  });

  test("rejects an unknown flash tool", () => {
    expect(errorsOf(BASE.replace("tool: STM32_Programmer_CLI", "tool: st-flash"))).toContain(
      "flash.tool",
    );
  });

  test("requires a target for probe-rs and openocd", () => {
    const probe = BASE.replace(
      "flash: { tool: STM32_Programmer_CLI, interfaccia: swd }",
      "flash: { tool: probe-rs, interfaccia: swd }",
    );
    expect(errorsOf(probe)).toContain("flash.target");

    const openocd = BASE.replace(
      "flash: { tool: STM32_Programmer_CLI, interfaccia: swd }",
      "flash: { tool: openocd, interfaccia: jtag }",
    );
    expect(errorsOf(openocd)).toContain("flash.target");
  });

  test("parses an optional serial section", () => {
    const result = loadProfile(
      `${BASE}seriale: { porta: "/dev/ttyUSB0", baud: 115200, comando: "cat {porta}" }`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.seriale).toEqual({
        porta: "/dev/ttyUSB0",
        baud: 115200,
        comando: "cat {porta}",
      });
    }
  });

  test("rejects an impossible baud rate", () => {
    expect(errorsOf(`${BASE}seriale: { porta: "/dev/ttyUSB0", baud: 7 }`)).toContain(
      "seriale.baud",
    );
  });

  test("criterion ids are stable and indexed", () => {
    const result = loadProfile(BASE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(profileCriteria(result.profile).map((criterion) => criterion.id)).toEqual([
        "seriale_contiene[0]",
        "log_non_contiene[1]",
        "test_su_target[2]",
      ]);
    }
  });

  test("rejects duplicate anchors", () => {
    expect(errorsOf(BASE.replace("ancore: [APP, LED]", "ancore: [APP, APP]"))).toContain(
      "duplicate block APP",
    );
  });

  test("rejects an anchor that is not an identifier", () => {
    expect(errorsOf(BASE.replace("ancore: [APP, LED]", "ancore: [app, LED]"))).toContain(
      "ancore[0]",
    );
  });

  test("rejects unknown fields (a typo must not be silently ignored)", () => {
    expect(errorsOf(BASE.replace("prodotto: DEMO-BOARD-01", "prodotto: DEMO-BOARD-01\ncliente: ACME"))).toContain(
      "profile.cliente: unknown field",
    );
  });

  test("rejects an empty criteria list", () => {
    const text = BASE.replace(
      "criteri:\n  - seriale_contiene: \"BOOT OK\"\n  - log_non_contiene: [HardFault, ERROR]\n  - test_su_target: pass",
      "criteri: []",
    );
    expect(errorsOf(text)).toContain("criteri");
  });

  test("rejects attempts outside 1..10", () => {
    expect(errorsOf(BASE.replace("tentativi_max: 3", "tentativi_max: 0"))).toContain("tentativi_max");
    expect(errorsOf(BASE.replace("tentativi_max: 3", "tentativi_max: 99"))).toContain("tentativi_max");
  });

  test("rejects invalid YAML", () => {
    expect(errorsOf("prodotto: [unclosed")).toContain("YAML");
  });
});
