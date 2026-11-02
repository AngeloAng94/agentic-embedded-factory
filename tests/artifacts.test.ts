import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProfile } from "../core/profile";
import { checkMemoryMap } from "../tools/memoryMap";
import { deriveFromElf } from "../tools/mcp/artifacts";
import { McpRunState } from "../tools/mcp/runState";
import { buildElf32, vectorBytes } from "./helpers/elfFixture";

const PROFILE_YAML = [
  "prodotto: DEMO-DERIVE",
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

const dir = mkdtempSync(path.join(tmpdir(), "py-bench-derive-test-"));
const elfPath = path.join(dir, "app.elf");
const binPath = path.join(dir, "app.bin");
const hexPath = path.join(dir, "app.hex");

const elfBytes = buildElf32({
  entry: 0x0800_0201,
  sections: [
    {
      name: ".vectors",
      flags: 2,
      address: 0x0800_0000,
      loadAddress: 0x0800_0000,
      bytes: vectorBytes(0x2000_4000, 0x0800_0201),
    },
    {
      name: ".text",
      flags: 6,
      address: 0x0800_0200,
      loadAddress: 0x0800_0200,
      bytes: new Array<number>(16).fill(0xa5),
    },
    {
      name: ".data",
      flags: 3,
      address: 0x2000_0000,
      loadAddress: 0x0800_1000,
      bytes: [1, 2, 3, 4],
    },
  ],
});

writeFileSync(elfPath, elfBytes);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ELF → bin/hex derivation", () => {
  test("derives both formats from FLASH PT_LOAD bytes only", () => {
    const bin = deriveFromElf(profile, elfPath, "bin");
    expect(bin.ok).toBe(true);
    if (bin.ok) {
      const bytes = new Uint8Array(readFileSync(bin.value.artifact));
      expect(bytes.length).toBe(0x1004);
      expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x40, 0x00, 0x20]);
      expect(bytes[0x200]).toBe(0xa5);
      expect([...bytes.subarray(0x1000, 0x1004)]).toEqual([1, 2, 3, 4]);
      expect(bin.value.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(bin.value.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    }

    const hex = deriveFromElf(profile, elfPath, "hex");
    expect(hex.ok).toBe(true);
    if (hex.ok) {
      const text = readFileSync(hex.value.artifact, "utf8");
      expect(text).toContain(":00000001FF");
      expect(text.split("\n").every((line) => line === "" || /^:[0-9A-F]+$/.test(line))).toBe(true);
      expect(hex.value.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("rejects a non-ELF source", () => {
    const result = deriveFromElf(profile, binPath, "bin");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ELF");
  });
});

describe("flash derivation gate", () => {
  test("an external bin is refused until the tool derives it from a checked ELF", () => {
    const run = new McpRunState(profile);
    const checked = checkMemoryMap(profile, { artifactPath: elfPath });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    run.recordMemoryMap(checked.value);

    const derived = deriveFromElf(profile, elfPath, "bin");
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    writeFileSync(binPath, readFileSync(derived.value.artifact));

    const external = run.canFlash(binPath);
    expect(external.ok).toBe(false);
    if (!external.ok) expect(external.reason).toContain("externally");

    const withSource = run.canFlash(binPath, elfPath);
    expect(withSource.ok).toBe(true);
    if (withSource.ok) {
      expect(withSource.flashPath).not.toBe(binPath);
      expect(withSource.derivedFrom?.sourceSha256).toBe(checked.value.sha256);
    }

    const afterDerivation = run.canFlash(binPath);
    expect(afterDerivation.ok).toBe(true);
    expect(run.snapshot().derivations).toHaveLength(1);
    expect(run.snapshot().derivations[0]?.sha256).toBe(derived.value.sha256);
  });

  test("a tampered bin does not match the source derivation", () => {
    const run = new McpRunState(profile);
    const checked = checkMemoryMap(profile, { artifactPath: elfPath });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    run.recordMemoryMap(checked.value);

    const derived = deriveFromElf(profile, elfPath, "bin");
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    const tampered = path.join(dir, "tampered.bin");
    const bytes = new Uint8Array(readFileSync(derived.value.artifact));
    bytes[0] = 0xff;
    writeFileSync(tampered, bytes);

    const result = run.canFlash(tampered, elfPath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not the bin derived");
  });

  test("hex gets the same derivation rule", () => {
    const run = new McpRunState(profile);
    const checked = checkMemoryMap(profile, { artifactPath: elfPath });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    run.recordMemoryMap(checked.value);

    const derived = deriveFromElf(profile, elfPath, "hex");
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    writeFileSync(hexPath, readFileSync(derived.value.artifact));

    expect(run.canFlash(hexPath).ok).toBe(false);
    const withSource = run.canFlash(hexPath, elfPath);
    expect(withSource.ok).toBe(true);
    if (withSource.ok) expect(withSource.derivedFrom?.format).toBe("hex");
    expect(run.canFlash(hexPath).ok).toBe(true);
  });
});
