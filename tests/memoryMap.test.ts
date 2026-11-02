import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProfile, type ProductProfile } from "../core/profile";
import { buildElf32, type FixtureSection } from "./helpers/elfFixture";
import { checkMemoryMap } from "../tools/memoryMap";

const SHF_WRITE = 1;
const SHF_ALLOC = 2;
const SHF_EXECINSTR = 4;
const SHT_NOBITS = 8;

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

function profileWith(flashKb: number, ramKb: number): ProductProfile {
  const result = loadProfile(
    PROFILE_YAML.replace("flash_kb: 64", `flash_kb: ${flashKb}`).replace(
      "ram_kb: 16",
      `ram_kb: ${ramKb}`,
    ),
  );
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.profile;
}

const SECTIONS: FixtureSection[] = [
  { name: ".vectors", flags: SHF_ALLOC, address: 0x0800_0000, size: 256 },
  {
    name: ".text",
    flags: SHF_ALLOC | SHF_EXECINSTR,
    address: 0x0800_0100,
    size: 4096,
  },
  { name: ".rodata", flags: SHF_ALLOC, address: 0x0800_1100, size: 1024 },
  {
    name: ".data",
    flags: SHF_ALLOC | SHF_WRITE,
    address: 0x2000_0000,
    size: 512,
  },
  {
    name: ".bss",
    type: SHT_NOBITS,
    flags: SHF_ALLOC | SHF_WRITE,
    address: 0x2000_0200,
    size: 1024,
  },
];

// FLASH = 256 + 4096 + 1024 + 512 = 5888 B; RAM = 512 + 1024 = 1536 B.
const EXPECTED_FLASH = 5888;
const EXPECTED_RAM = 1536;

const dir = mkdtempSync(path.join(tmpdir(), "py-bench-memory-test-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeElf(name: string, bytes: Uint8Array): string {
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

function elfWith(sections: FixtureSection[], entry = 0x0800_0100): string {
  return writeElf(`app-${Math.random().toString(16).slice(2)}.elf`, buildElf32({ entry, sections }));
}

describe("memory_map_check", () => {
  test("a fitting image passes every check", () => {
    const result = checkMemoryMap(profileWith(64, 16), { artifactPath: elfWith(SECTIONS) });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verification).toBe("REAL");
      expect(result.value.flashUsed).toBe(EXPECTED_FLASH);
      expect(result.value.ramUsed).toBe(EXPECTED_RAM);
      expect(result.value.flashTotal).toBe(64 * 1024);
      expect(result.value.ramTotal).toBe(16 * 1024);
      expect(result.value.entry).toBe("0x8000100");
      expect(result.value.verdict).toBe("SUCCESS");
      for (const check of result.value.checks) expect(check.status).toBe("PASS");
    }
  });

  test("a flash overflow is a FAILURE, not a warning", () => {
    const result = checkMemoryMap(profileWith(1, 16), { artifactPath: elfWith(SECTIONS) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verdict).toBe("FAILURE");
      const flash = result.value.checks.find((check) => check.id === "flash.fits");
      expect(flash?.status).toBe("FAIL");
      expect(flash?.detail).toContain("declares");
    }
  });

  test("a RAM overflow is a FAILURE", () => {
    const result = checkMemoryMap(profileWith(64, 1), { artifactPath: elfWith(SECTIONS) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verdict).toBe("FAILURE");
      expect(result.value.checks.find((check) => check.id === "ram.fits")?.status).toBe("FAIL");
    }
  });

  test("overlapping allocated sections are a FAILURE", () => {
    const overlapping: FixtureSection[] = [
      ...SECTIONS,
      { name: ".duplicate", flags: SHF_ALLOC, address: 0x0800_0200, size: 64 },
    ];
    const result = checkMemoryMap(profileWith(64, 16), { artifactPath: elfWith(overlapping) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verdict).toBe("FAILURE");
      const overlap = result.value.checks.find((check) => check.id === "sections.overlap");
      expect(overlap?.status).toBe("FAIL");
      expect(overlap?.detail).toContain("overlaps");
    }
  });

  test("an entry point outside the executable sections is a FAILURE", () => {
    const result = checkMemoryMap(profileWith(64, 16), {
      artifactPath: elfWith(SECTIONS, 0x2000_0000),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verdict).toBe("FAILURE");
      expect(result.value.checks.find((check) => check.id === "entry.executable")?.status).toBe(
        "FAIL",
      );
    }
  });

  test("an ELF without allocated sections is NOT_AVAILABLE, not zero bytes", () => {
    const result = checkMemoryMap(profileWith(64, 16), { artifactPath: elfWith([]) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NOT_AVAILABLE");
      expect(result.reason).toContain("no allocated sections");
    }
  });

  test("a missing file is NOT_AVAILABLE with the path", () => {
    const result = checkMemoryMap(profileWith(64, 16), {
      artifactPath: path.join(dir, "missing.elf"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("cannot read");
  });

  test("a file that is not an ELF is NOT_AVAILABLE", () => {
    const file = path.join(dir, "not-elf.bin");
    writeFileSync(file, new Uint8Array([1, 2, 3, 4]));
    const result = checkMemoryMap(profileWith(64, 16), { artifactPath: file });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not an ELF");
  });

  test("no artifact path is an invalid request", () => {
    const result = checkMemoryMap(profileWith(64, 16), { artifactPath: "  " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_REQUEST");
  });
});
