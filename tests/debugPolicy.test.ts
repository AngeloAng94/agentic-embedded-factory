import { describe, expect, test } from "bun:test";
import { loadProfile } from "../core/profile";
import { runGdbBatch } from "../tools/debug";
import { validateDebugCommands } from "../tools/debugPolicy";
import type { BinaryResolver } from "../tools/exec";

const PROFILE_YAML = [
  "prodotto: DEMO-DEBUG-POLICY",
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
  '  - seriale_contiene: "BOOT OK"',
  "tentativi_max: 3",
].join("\n");

const profile = (() => {
  const result = loadProfile(PROFILE_YAML);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.profile;
})();

const none: BinaryResolver = () => null;

function allowed(commands: string[]) {
  return validateDebugCommands(profile, commands);
}

function rejected(commands: string[]) {
  const result = allowed(commands);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  return result;
}

describe("debug command policy", () => {
  test("allows breakpoints, halt/continue, reads, RAM/register writes and detach", () => {
    const commands = [
      "break main",
      "b main",
      "interrupt",
      "halt",
      "continue",
      "c",
      "detach",
      "x/4xb 0x08000000",
      "info registers",
      "p/x $pc",
      "set $r0 = 1",
      "set {unsigned int}0x20000000 = 1",
      "set *(unsigned int*)0x20000000 = 1",
      "restore /tmp/ram.bin binary 0x20000000",
      "monitor reset",
      "monitor halt",
      "monitor flash banks",
      "monitor mww 0x20000000 1",
    ];
    for (const command of commands) {
      const result = allowed([command]);
      expect({ command, ok: result.ok }).toEqual({ command, ok: true });
    }
  });

  test("rejects load and every firmware-write command", () => {
    for (const command of [
      "load app.elf",
      "LOAD app.elf",
      "flash write_image erase app.elf 0x08000000",
      "program app.elf",
      "download app.elf",
      "monitor program app.elf",
      "monitor flash write_image erase app.elf 0x08000000",
      "monitor flash erase 0x08000000",
      "monitor flash mass_erase 0",
      "monitor mww 0x08000000 1",
      "monitor mwb 0x08000000 1",
    ]) {
      const result = rejected([command]);
      if (!result.ok) expect(result.reason).toContain("flash");
    }
  });

  test("rejects restore without an explicit RAM address and restore to FLASH", () => {
    for (const command of [
      "restore image.bin",
      "restore image.bin binary",
      "restore image.bin 0x08000000",
      "restore image.bin binary 0x08000000",
      "restore image.bin &flash_start",
    ]) {
      rejected([command]);
    }
  });

  test("rejects arithmetic address expressions that could resolve into FLASH", () => {
    for (const command of [
      "set {int}0x20000000 + 0x08000000 = 1",
      "set *(unsigned int*)0x20000000+0x08000000 = 1",
      "set {int}(0x20000000) = 1",
    ]) {
      const result = validateDebugCommands(profile, [command]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("RAM");
    }
  });

  test("rejects memory writes to FLASH through every set spelling", () => {
    for (const command of [
      "set {unsigned int}0x08000000 = 1",
      "set {unsigned char}0x08000001 = 0",
      "set *(unsigned int*)0x08000000 = 1",
      "set *0x08000000 = 1",
      "set {unsigned int}&flash_var = 1",
      "set var flash_var = 1",
      "set write on",
    ]) {
      rejected([command]);
    }
  });

  test("rejects writes outside declared RAM and symbolic addresses", () => {
    for (const command of [
      "set {unsigned int}0x30000000 = 1",
      "set *(unsigned int*)0x30000000 = 1",
      "set *(unsigned int*)&var = 1",
      "set *(unsigned int*)$sp = 1",
    ]) {
      rejected([command]);
    }
  });

  test("rejects disallowed control/script commands and semicolon smuggling", () => {
    for (const command of [
      "step",
      "next",
      "jump main",
      "call erase_flash()",
      "source script.gdb",
      "python print('x')",
      "x/4xb 0x08000000; load app.elf",
      "x/4xb 0x08000000\nload app.elf",
      "set $r0 = 1; set {unsigned int}0x08000000 = 1",
    ]) {
      rejected([command]);
    }
  });

  test("runGdbBatch enforces the policy before looking for gdb", () => {
    const result = runGdbBatch(profile, ["load app.elf"], { resolve: none });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_REQUEST");
      expect(result.reason).toContain("load");
    }
  });
});
