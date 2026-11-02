import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_RUN_FLASH_BUDGET,
  DEFAULT_RUN_TIME_BUDGET_MS,
  editableAnchors,
  loadProfile,
  profileCriteria,
} from "../core/profile";

const CHIP = [
  "chip:",
  "  famiglia: stm32",
  "  regioni:",
  "    - { nome: FLASH, tipo: flash, origine: 0x08000000, dimensione: 2097152 }",
  "    - { nome: RAM, tipo: ram, origine: 0x20000000, dimensione: 655360 }",
].join("\n");

const BASE = [
  "prodotto: DEMO-BOARD-01",
  CHIP,
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
      expect(result.profile.chip).toEqual({
        famiglia: "stm32",
        regioni: [
          { nome: "FLASH", tipo: "flash", origine: 0x08000000, dimensione: 2097152 },
          { nome: "RAM", tipo: "ram", origine: 0x20000000, dimensione: 655360 },
        ],
      });
      expect(result.profile.ancore).toEqual(["APP", "LED"]);
      expect(result.profile.criteri).toHaveLength(3);
      expect(result.profile.tentativi_max).toBe(3);
      expect(result.profile.budget).toEqual({ tempo_totale_ms: 480000, flash_max: 2 });
      expect(editableAnchors(result.profile)).toEqual(["APP", "LED"]);
    }
  });

  test("defaults the run budget prudently when budget is absent", () => {
    const result = loadProfile(BASE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.budget).toEqual({
        tempo_totale_ms: DEFAULT_RUN_TIME_BUDGET_MS,
        flash_max: DEFAULT_RUN_FLASH_BUDGET,
      });
    }
  });

  test("parses budget overrides and rejects invalid bounds", () => {
    const result = loadProfile(`${BASE}budget: { tempo_totale_ms: 120000, flash_max: 0 }`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.budget).toEqual({ tempo_totale_ms: 120000, flash_max: 0 });

    expect(errorsOf(`${BASE}budget: { tempo_totale_ms: 999, flash_max: 2 }`)).toContain(
      "budget.tempo_totale_ms",
    );
    expect(errorsOf(`${BASE}budget: { tempo_totale_ms: 1000, flash_max: 21 }`)).toContain(
      "budget.flash_max",
    );
    expect(errorsOf(`${BASE}budget: { tempo_totale_ms: 1000, extra: 1 }`)).toContain(
      "budget.extra",
    );
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

  test("rejects a non-numeric region size", () => {
    expect(errorsOf(BASE.replace("dimensione: 2097152", "dimensione: tanto"))).toContain(
      "chip.regioni[0].dimensione",
    );
  });

  test("rejects a zero region size", () => {
    expect(errorsOf(BASE.replace("dimensione: 2097152", "dimensione: 0"))).toContain(
      "chip.regioni[0].dimensione",
    );
  });

  test("rejects flash_kb/ram_kb with an explicit request to declare regions", () => {
    const old = BASE.replace(
      CHIP,
      "chip: { famiglia: stm32, flash_kb: 2048, ram_kb: 640 }",
    );
    const errors = errorsOf(old);
    expect(errors).toContain("chip.flash_kb: deprecated");
    expect(errors).toContain("chip.ram_kb: deprecated");
    expect(errors).toContain("chip.regioni");
  });

  test("accepts an optional vector table address inside FLASH", () => {
    const result = loadProfile(
      BASE.replace("  famiglia: stm32", "  famiglia: stm32\n  vettori: 0x08004000"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.chip.vettori).toBe(0x08004000);
  });

  test("rejects a vector table address outside FLASH", () => {
    expect(
      errorsOf(
        BASE.replace("  famiglia: stm32", "  famiglia: stm32\n  vettori: 0x20000000"),
      ),
    ).toContain("chip.vettori");
  });

  test("rejects a non-hex vector table address", () => {
    expect(
      errorsOf(
        BASE.replace("  famiglia: stm32", "  famiglia: stm32\n  vettori: 0xZZZZZZZZ"),
      ),
    ).toContain("chip.vettori");
  });

  test("accepts more than one RAM region", () => {
    const multi = BASE.replace(
      "    - { nome: RAM, tipo: ram, origine: 0x20000000, dimensione: 655360 }",
      "    - { nome: RAM1, tipo: ram, origine: 0x20000000, dimensione: 327680 }\n" +
        "    - { nome: RAM2, tipo: ram, origine: 0x20050000, dimensione: 327680 }",
    );
    const result = loadProfile(multi);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.chip.regioni.map((region) => region.nome)).toEqual([
        "FLASH",
        "RAM1",
        "RAM2",
      ]);
    }
  });

  test("rejects overlapping regions", () => {
    const errors = errorsOf(
      BASE.replace(
        "    - { nome: RAM, tipo: ram, origine: 0x20000000, dimensione: 655360 }",
        "    - { nome: RAM, tipo: ram, origine: 0x20000000, dimensione: 655360 }\n" +
          "    - { nome: RAM_ALIAS, tipo: ram, origine: 0x20080000, dimensione: 4096 }",
      ),
    );
    expect(errors).toContain("overlaps");
  });

  test("rejects duplicate region names, unknown types and bad origins", () => {
    expect(
      errorsOf(BASE.replace("nome: RAM, tipo: ram", "nome: FLASH, tipo: ram")),
    ).toContain("duplicate region");
    expect(
      errorsOf(BASE.replace("tipo: ram, origine", "tipo: sram, origine")),
    ).toContain("chip.regioni[1].tipo");
    expect(
      errorsOf(BASE.replace("origine: 0x20000000", "origine: 0x1_0000_0000")),
    ).toContain("chip.regioni[1].origine");
  });

  test("requires at least one flash region and one RAM region", () => {
    const noRam = BASE.replace(
      "    - { nome: RAM, tipo: ram, origine: 0x20000000, dimensione: 655360 }\n",
      "",
    );
    expect(errorsOf(noRam)).toContain('at least one "ram" region');
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

  test("accepts an empty criteria list: no criterion can reach observed", () => {
    const text = BASE.replace(
      "criteri:\n  - seriale_contiene: \"BOOT OK\"\n  - log_non_contiene: [HardFault, ERROR]\n  - test_su_target: pass",
      "criteri: []",
    );
    const result = loadProfile(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.criteri).toEqual([]);
  });

  test("accepts omitted criteria and an optional model runtime", () => {
    const withoutCriteria = BASE.replace(
      "criteri:\n  - seriale_contiene: \"BOOT OK\"\n  - log_non_contiene: [HardFault, ERROR]\n  - test_su_target: pass\n",
      "",
    );
    const result = loadProfile(`${withoutCriteria}llm: { provider: llmClient }\n`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.criteri).toEqual([]);
      expect(result.profile.llm).toEqual({ provider: "llmClient" });
    }
  });

  test("validates the model runtime provider and model", () => {
    const fake = loadProfile(`${BASE}llm: { provider: fake, model: test-model }`);
    expect(fake.ok).toBe(true);
    if (fake.ok) expect(fake.profile.llm).toEqual({ provider: "fake", model: "test-model" });

    expect(errorsOf(`${BASE}llm: { provider: openai }`)).toContain("llm.provider");
    expect(errorsOf(`${BASE}llm: { provider: llmClient, extra: true }`)).toContain(
      "llm.extra: unknown field",
    );
  });

  test("rejects attempts outside 1..10", () => {
    expect(errorsOf(BASE.replace("tentativi_max: 3", "tentativi_max: 0"))).toContain("tentativi_max");
    expect(errorsOf(BASE.replace("tentativi_max: 3", "tentativi_max: 99"))).toContain("tentativi_max");
  });

  test("rejects invalid YAML", () => {
    expect(errorsOf("prodotto: [unclosed")).toContain("YAML");
  });
});
