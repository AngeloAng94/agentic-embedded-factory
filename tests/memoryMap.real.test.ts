/**
 * Real-toolchain test for memory_map_check.
 *
 * This compiles a minimal Cortex-M firmware with arm-none-eabi-gcc and checks
 * the resulting ELF, including the linker-produced LMA of .data. It is skipped
 * unless the toolchain is explicitly allowed, so a normal `bun test` never
 * depends on a cross compiler:
 *
 *   PY_BENCH_ALLOW_REAL_TOOLCHAIN=1 bun test tests/memoryMap.real.test.ts
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProfile } from "../core/profile";
import { checkMemoryMap } from "../tools/memoryMap";

const enabled = process.env.PY_BENCH_ALLOW_REAL_TOOLCHAIN === "1";
const compiler = Bun.which("arm-none-eabi-gcc");
const missing = !enabled
  ? "set PY_BENCH_ALLOW_REAL_TOOLCHAIN=1 to compile a real ELF"
  : !compiler
    ? "arm-none-eabi-gcc is not in PATH"
    : null;

const PROFILE = [
  "prodotto: GCC-REAL-ELF",
  "chip:",
  "  famiglia: stm32",
  "  regioni:",
  "    - { nome: FLASH, tipo: flash, origine: 0x08000000, dimensione: 65536 }",
  "    - { nome: RAM, tipo: ram, origine: 0x20000000, dimensione: 16384 }",
  'build: { sistema: cmake, toolchain: arm-none-eabi-gcc, comando: "cmake --build build" }',
  "flash: { tool: STM32_Programmer_CLI, interfaccia: swd }",
  "debug: { gdb_server: st, access_port: 0 }",
  "ancore: [APP]",
  "criteri:",
  "  - test_su_target: pass",
  "tentativi_max: 1",
].join("\n");

const LINKER_SCRIPT = `
MEMORY
{
  FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 64K
  RAM (rwx)  : ORIGIN = 0x20000000, LENGTH = 16K
}

_estack = ORIGIN(RAM) + LENGTH(RAM);
ENTRY(Reset_Handler)

SECTIONS
{
  .isr_vector : { KEEP(*(.isr_vector)) } > FLASH
  .text : { *(.text*) *(.rodata*) } > FLASH
  .data : { *(.data*) } > RAM AT> FLASH
  .bss : { *(.bss*) *(COMMON) } > RAM
}
`;

const SOURCE = `
#include <stdint.h>

extern uint32_t _estack;

void Reset_Handler(void)
{
  for (;;) {
  }
}

__attribute__((section(".isr_vector"), used))
const uint32_t vector_table[2] = {
  (uint32_t)&_estack,
  ((uint32_t)Reset_Handler) | 1u
};

int initialized_value = 0x12345678;
int zero_value;
`;

describe.skipIf(missing !== null)("memory_map_check — real toolchain", () => {
  test("a real arm-none-eabi-gcc ELF passes the address and vector checks", () => {
    if (!compiler) throw new Error("arm-none-eabi-gcc disappeared from PATH");

    const dir = mkdtempSync(path.join(tmpdir(), "py-bench-gcc-elf-"));
    try {
      writeFileSync(path.join(dir, "linker.ld"), LINKER_SCRIPT);
      writeFileSync(path.join(dir, "app.c"), SOURCE);

      const build = Bun.spawnSync({
        cmd: [
          compiler,
          "-mcpu=cortex-m4",
          "-mthumb",
          "-nostdlib",
          "-Wl,-T,linker.ld",
          "-o",
          "app.elf",
          "app.c",
        ],
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (!build.success) {
        throw new Error(`arm-none-eabi-gcc failed:\n${new TextDecoder().decode(build.stderr)}`);
      }

      const profileResult = loadProfile(PROFILE);
      if (!profileResult.ok) throw new Error(profileResult.errors.join("; "));

      const result = checkMemoryMap(profileResult.profile, {
        artifactPath: path.join(dir, "app.elf"),
      });
      if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);

      const failed = result.value.checks
        .filter((check) => check.status !== "PASS")
        .map((check) => `${check.label}: ${check.status} — ${check.detail}`);
      if (result.value.verdict !== "SUCCESS") {
        throw new Error(`memory map ${result.value.verdict}:\n${failed.join("\n")}`);
      }

      expect(result.value.vectorTable?.source).toContain(".isr_vector");
      expect(
        result.value.checks.find(
          (check) => check.label.startsWith('section ".data"') && check.id.endsWith(".lma"),
        )?.status,
      ).toBe("PASS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
