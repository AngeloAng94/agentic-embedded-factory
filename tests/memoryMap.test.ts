import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadProfile,
  type MemoryRegion,
  type ProductProfile,
} from "../core/profile";
import {
  buildElf32,
  vectorBytes,
  type FixtureSection,
  type FixtureSegment,
} from "./helpers/elfFixture";
import { checkMemoryMap, type MemoryMapReport } from "../tools/memoryMap";

const SHF_WRITE = 1;
const SHF_ALLOC = 2;
const SHF_EXECINSTR = 4;
const SHT_NOBITS = 8;

const FLASH_ORIGIN = 0x0800_0000;
const RAM_ORIGIN = 0x2000_0000;
const FLASH_SIZE = 64 * 1024;
const RAM_SIZE = 16 * 1024;
const STACK = RAM_ORIGIN + RAM_SIZE; // 0x20004000, the end of RAM
const RESET = 0x0800_0101; // odd: Thumb bit set
const APP_VECTOR_ADDRESS = FLASH_ORIGIN + 0x4000; // behind a bootloader
const APP_STACK = RAM_ORIGIN + 0x3000;
const APP_RESET = 0x0800_0201; // handler 0x08000200 is inside .text

const DEFAULT_REGIONS: MemoryRegion[] = [
  { nome: "FLASH", tipo: "flash", origine: FLASH_ORIGIN, dimensione: FLASH_SIZE },
  { nome: "RAM", tipo: "ram", origine: RAM_ORIGIN, dimensione: RAM_SIZE },
];

const BASE_YAML = [
  "prodotto: DEMO-BOARD-01",
  'build: { sistema: cmake, toolchain: arm-none-eabi-gcc, comando: "cmake --build build" }',
  "flash: { tool: STM32_Programmer_CLI, interfaccia: swd }",
  "debug: { gdb_server: st, access_port: 0 }",
  "ancore: [APP]",
  "criteri:",
  '  - seriale_contiene: "BOOT OK"',
  "tentativi_max: 3",
].join("\n");

function profileWith(
  regions: readonly MemoryRegion[] = DEFAULT_REGIONS,
  vettori?: number,
): ProductProfile {
  const chip = [
    "chip:",
    "  famiglia: stm32",
    ...(vettori === undefined ? [] : [`  vettori: 0x${vettori.toString(16)}`]),
    "  regioni:",
    ...regions.map(
      (region) =>
        `    - { nome: ${region.nome}, tipo: ${region.tipo}, origine: 0x${region.origine.toString(16)}, dimensione: ${region.dimensione} }`,
    ),
  ].join("\n");
  const result = loadProfile(`${BASE_YAML}\n${chip}`);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.profile;
}

function vectorSection(stack = STACK, reset = RESET, size = 256): FixtureSection {
  return {
    name: ".vectors",
    flags: SHF_ALLOC,
    address: FLASH_ORIGIN,
    bytes: vectorBytes(stack, reset, size),
  };
}

const SECTIONS: FixtureSection[] = [
  vectorSection(),
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
    bytes: new Array<number>(512).fill(0x5a),
    loadAddress: 0x0800_1600,
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

const RAMFUNC: FixtureSection = {
  name: ".ramfunc",
  flags: SHF_ALLOC | SHF_EXECINSTR,
  address: 0x2000_2000,
  bytes: new Array<number>(64).fill(0x90),
  loadAddress: 0x0800_1800,
};

const dir = mkdtempSync(path.join(tmpdir(), "py-bench-memory-test-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeElf(name: string, bytes: Uint8Array): string {
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

function elfWith(
  sections: FixtureSection[],
  entry = 0x0800_0100,
  segments: FixtureSegment[] = [],
): string {
  return writeElf(
    `app-${Math.random().toString(16).slice(2)}.elf`,
    buildElf32({ entry, sections, segments }),
  );
}

function reportFor(
  sections: FixtureSection[] = SECTIONS,
  profile: ProductProfile = profileWith(),
  entry = 0x0800_0100,
  segments: FixtureSegment[] = [],
): MemoryMapReport {
  const result = checkMemoryMap(profile, {
    artifactPath: elfWith(sections, entry, segments),
  });
  if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
  expect(result.verification).toBe("REAL");
  return result.value;
}

function sectionCheck(
  report: MemoryMapReport,
  name: string,
  suffix: "vma" | "lma" = "vma",
) {
  return report.checks.find(
    (check) => check.label.startsWith(`section "${name}"`) && check.id.endsWith(`.${suffix}`),
  );
}

function checkNamed(report: MemoryMapReport, id: string) {
  return report.checks.find((check) => check.id === id);
}

function withVectors(sections: FixtureSection[], stack = STACK, reset = RESET): FixtureSection[] {
  return sections.map((section) =>
    section.name === ".vectors" ? { ...section, bytes: vectorBytes(stack, reset, 256) } : section,
  );
}

function withoutSection(name: string): FixtureSection[] {
  return SECTIONS.filter((section) => section.name !== name);
}

describe("memory_map_check", () => {
  test("a correct image passes every address and vector check", () => {
    const report = reportFor();

    expect(report.flashUsed).toBe(EXPECTED_FLASH);
    expect(report.ramUsed).toBe(EXPECTED_RAM);
    expect(report.flashTotal).toBe(FLASH_SIZE);
    expect(report.ramTotal).toBe(RAM_SIZE);
    expect(report.entry).toBe("0x8000100");
    expect(report.vectorTable?.stack).toBe(STACK);
    expect(report.vectorTable?.reset).toBe(RESET);
    expect(report.verdict).toBe("SUCCESS");
    for (const check of report.checks) expect(check.status).toBe("PASS");
    expect(report.regions.map((region) => [region.name, region.used])).toEqual([
      ["FLASH", EXPECTED_FLASH],
      ["RAM", EXPECTED_RAM],
    ]);
  });

  test("a correct image with two RAM regions passes", () => {
    const regions: MemoryRegion[] = [
      DEFAULT_REGIONS[0]!,
      { nome: "RAM1", tipo: "ram", origine: 0x2000_0000, dimensione: 0x200 },
      { nome: "RAM2", tipo: "ram", origine: 0x2000_0200, dimensione: 0x3e00 },
    ];
    // .data exactly fills RAM1; .bss and the initial SP live in RAM2.
    const report = reportFor(SECTIONS, profileWith(regions));

    expect(report.verdict).toBe("SUCCESS");
    expect(report.regions).toHaveLength(3);
    expect(report.vectorTable?.stack).toBe(STACK);
    for (const check of report.checks) expect(check.status).toBe("PASS");
  });

  test("an initial stack pointer at the exact end of RAM is valid", () => {
    const report = reportFor(withVectors(SECTIONS, STACK, RESET));

    expect(report.verdict).toBe("SUCCESS");
    const stack = checkNamed(report, "vectors.stack");
    expect(stack?.status).toBe("PASS");
    expect(stack?.detail).toContain("initial SP 0x20004000");
    expect(stack?.detail).toContain("is in RAM region");
  });

  test("an initial stack pointer 8 bytes past RAM is rejected", () => {
    const report = reportFor(withVectors(SECTIONS, STACK + 8, RESET));

    expect(report.verdict).toBe("FAILURE");
    const stack = checkNamed(report, "vectors.stack");
    expect(stack?.status).toBe("FAIL");
    expect(stack?.detail).toContain("initial SP 0x20004008");
    expect(stack?.detail).toContain("outside every RAM region");
  });

  test("a wrong RAM origin with the correct size is rejected", () => {
    const regions: MemoryRegion[] = [
      DEFAULT_REGIONS[0]!,
      { nome: "RAM", tipo: "ram", origine: 0x2000_0800, dimensione: RAM_SIZE },
    ];
    const report = reportFor(SECTIONS, profileWith(regions));

    expect(report.verdict).toBe("FAILURE");
    const data = sectionCheck(report, ".data");
    expect(data?.status).toBe("FAIL");
    expect(data?.detail).toContain("0x20000000");
    expect(data?.detail).toContain("outside every RAM region");
    expect(sectionCheck(report, ".bss")?.status).toBe("FAIL");
  });

  test("an initial stack pointer outside RAM is rejected", () => {
    const report = reportFor(withVectors(SECTIONS, 0x2000_6000, RESET));

    expect(report.verdict).toBe("FAILURE");
    const stack = checkNamed(report, "vectors.stack");
    expect(stack?.status).toBe("FAIL");
    expect(stack?.detail).toContain("initial SP 0x20006000");
    expect(stack?.detail).toContain("outside every RAM region");
  });

  test("an unaligned initial stack pointer is rejected", () => {
    const report = reportFor(withVectors(SECTIONS, 0x2000_3ffc, RESET));

    expect(report.verdict).toBe("FAILURE");
    const stack = checkNamed(report, "vectors.stack");
    expect(stack?.status).toBe("FAIL");
    expect(stack?.detail).toContain("initial SP 0x20003ffc");
    expect(stack?.detail).toContain("not 8-byte aligned");
  });

  test("an initial stack pointer in FLASH is rejected", () => {
    const report = reportFor(withVectors(SECTIONS, 0x0800_0100, RESET));

    expect(report.verdict).toBe("FAILURE");
    const stack = checkNamed(report, "vectors.stack");
    expect(stack?.status).toBe("FAIL");
    expect(stack?.detail).toContain("is in FLASH region");
    expect(stack?.detail).toContain("RAM region was expected");
  });

  test("a reset handler outside FLASH is rejected", () => {
    const report = reportFor(withVectors(SECTIONS, STACK, 0x2000_0001));

    expect(report.verdict).toBe("FAILURE");
    const reset = checkNamed(report, "vectors.reset");
    expect(reset?.status).toBe("FAIL");
    expect(reset?.detail).toContain("reset handler 0x20000000");
    expect(reset?.detail).toContain("is in RAM region");
    expect(reset?.detail).toContain("FLASH region was expected");
  });

  test("a reset handler without the Thumb bit is rejected", () => {
    const report = reportFor(withVectors(SECTIONS, STACK, 0x0800_0100));

    expect(report.verdict).toBe("FAILURE");
    const reset = checkNamed(report, "vectors.reset");
    expect(reset?.status).toBe("FAIL");
    expect(reset?.detail).toContain("Thumb bit clear");
    expect(reset?.detail).toContain("0x8000100");
  });

  test("a .data load address outside FLASH is rejected", () => {
    const sections = SECTIONS.map((section) =>
      section.name === ".data" ? { ...section, loadAddress: 0x2000_1000 } : section,
    );
    const report = reportFor(sections);

    expect(report.verdict).toBe("FAILURE");
    const lma = sectionCheck(report, ".data", "lma");
    expect(lma?.status).toBe("FAIL");
    expect(lma?.detail).toContain("LMA 0x20001000");
    expect(lma?.detail).toContain("RAM region");
    expect(lma?.detail).toContain("FLASH region was expected");
  });

  test("a section in a region that does not exist is rejected", () => {
    const sections: FixtureSection[] = [
      ...SECTIONS,
      { name: ".orphan", flags: SHF_ALLOC, address: 0x6000_0000, size: 64 },
    ];
    const report = reportFor(sections);

    expect(report.verdict).toBe("FAILURE");
    const orphan = sectionCheck(report, ".orphan");
    expect(orphan?.status).toBe("FAIL");
    expect(orphan?.detail).toContain("VMA 0x60000000");
    expect(orphan?.detail).toContain("outside every FLASH region");
    expect(orphan?.detail).toContain("FLASH region \"FLASH\"");
  });

  test("writable .data placed in FLASH is rejected", () => {
    const sections = SECTIONS.map((section) =>
      section.name === ".data"
        ? { ...section, address: 0x0800_2000, loadAddress: 0x0800_2200 }
        : section,
    );
    const report = reportFor(sections);

    expect(report.verdict).toBe("FAILURE");
    const data = sectionCheck(report, ".data");
    expect(data?.status).toBe("FAIL");
    expect(data?.detail).toContain("is in FLASH region");
    expect(data?.detail).toContain("RAM region was expected");
  });

  test("executable .text placed in RAM is rejected", () => {
    const sections = SECTIONS.map((section) =>
      section.name === ".text" ? { ...section, address: 0x2000_1000 } : section,
    );
    const report = reportFor(sections, profileWith(), 0x2000_1000);

    expect(report.verdict).toBe("FAILURE");
    const text = sectionCheck(report, ".text");
    expect(text?.status).toBe("FAIL");
    expect(text?.detail).toContain("is in RAM region");
    expect(text?.detail).toContain("FLASH region was expected");
  });

  test("an executable, non-writable .ramfunc copied to RAM is valid", () => {
    const report = reportFor([...SECTIONS, RAMFUNC]);

    expect(report.verdict).toBe("SUCCESS");
    expect(sectionCheck(report, ".ramfunc")?.status).toBe("PASS");
    expect(sectionCheck(report, ".ramfunc", "lma")?.status).toBe("PASS");
    expect(report.regions.find((region) => region.name === "FLASH")?.used).toBe(
      EXPECTED_FLASH + RAMFUNC.bytes!.length,
    );
    expect(report.regions.find((region) => region.name === "RAM")?.used).toBe(
      EXPECTED_RAM + RAMFUNC.bytes!.length,
    );
  });

  test("a .ramfunc whose VMA is outside every RAM region is rejected", () => {
    const bad: FixtureSection = { ...RAMFUNC, address: 0x2000_5000 };
    const report = reportFor([...SECTIONS, bad]);

    expect(report.verdict).toBe("FAILURE");
    const vma = sectionCheck(report, ".ramfunc");
    expect(vma?.status).toBe("FAIL");
    expect(vma?.detail).toContain("VMA 0x20005000");
    expect(vma?.detail).toContain("outside every RAM region");
  });

  test("a section that crosses the end of RAM is rejected", () => {
    const sections = SECTIONS.map((section) =>
      section.name === ".data"
        ? { ...section, address: 0x2000_3f00, loadAddress: 0x0800_1600 }
        : section,
    );
    const report = reportFor(sections);

    expect(report.verdict).toBe("FAILURE");
    const data = sectionCheck(report, ".data");
    expect(data?.status).toBe("FAIL");
    expect(data?.detail).toContain("past the end 0x20004000");
    expect(data?.detail).toContain("RAM region");
  });

  test("a .data load address that crosses the end of FLASH is rejected", () => {
    const sections = SECTIONS.map((section) =>
      section.name === ".data" ? { ...section, loadAddress: 0x0800_ff00 } : section,
    );
    const report = reportFor(sections);

    expect(report.verdict).toBe("FAILURE");
    const lma = sectionCheck(report, ".data", "lma");
    expect(lma?.status).toBe("FAIL");
    expect(lma?.detail).toContain("LMA 0x800ff00");
    expect(lma?.detail).toContain("past the end 0x8010000");
    expect(lma?.detail).toContain("FLASH region");
  });

  test("overlapping runtime or load ranges are rejected", () => {
    const sections: FixtureSection[] = [
      ...SECTIONS,
      { name: ".duplicate", flags: SHF_ALLOC, address: 0x0800_0200, size: 64 },
    ];
    const report = reportFor(sections);

    expect(report.verdict).toBe("FAILURE");
    const overlap = checkNamed(report, "sections.overlap");
    expect(overlap?.status).toBe("FAIL");
    expect(overlap?.detail).toContain("overlaps");
  });

  test("chip.vettori reads the table at a bootloader offset, overriding the named section", () => {
    const sections: FixtureSection[] = [
      ...withVectors(SECTIONS, 0x2000_6000, 0x0800_0100), // invalid table at 0x08000000
      {
        name: ".app_vectors",
        flags: SHF_ALLOC,
        address: APP_VECTOR_ADDRESS,
        bytes: vectorBytes(APP_STACK, APP_RESET),
      },
    ];
    const report = reportFor(sections, profileWith(DEFAULT_REGIONS, APP_VECTOR_ADDRESS));

    expect(report.verdict).toBe("SUCCESS");
    expect(report.vectorTable?.address).toBe(APP_VECTOR_ADDRESS);
    expect(report.vectorTable?.stack).toBe(APP_STACK);
    expect(report.vectorTable?.reset).toBe(APP_RESET);
    expect(report.vectorTable?.source).toContain("chip.vettori");
    expect(checkNamed(report, "vectors.stack")?.status).toBe("PASS");
    expect(checkNamed(report, "vectors.reset")?.status).toBe("PASS");
  });

  test("the vector table can be read from the start of FLASH without a named section", () => {
    const sections = withoutSection(".vectors");
    const vectors = vectorBytes(STACK, RESET);
    const segments: FixtureSegment[] = [{ address: FLASH_ORIGIN, bytes: vectors }];
    const report = reportFor(sections, profileWith(), 0x0800_0100, segments);

    expect(report.verdict).toBe("SUCCESS");
    expect(report.vectorTable?.source).toContain("start of FLASH region");
    expect(checkNamed(report, "vectors.stack")?.status).toBe("PASS");
    expect(checkNamed(report, "vectors.reset")?.status).toBe("PASS");
  });

  test("a vector section shorter than two words is a FAILURE", () => {
    const sections = SECTIONS.map((section) =>
      section.name === ".vectors" ? { ...section, bytes: [0, 0, 0, 0] } : section,
    );
    const report = reportFor(sections);

    expect(report.verdict).toBe("FAILURE");
    const table = checkNamed(report, "vectors.table");
    expect(table?.status).toBe("FAIL");
    expect(table?.detail).toContain("need 8 B");
  });

  test("no vector section and no segment at the start of FLASH is NOT_AVAILABLE", () => {
    const report = reportFor(withoutSection(".vectors"));

    expect(report.verdict).toBe("UNKNOWN");
    const table = checkNamed(report, "vectors.table");
    expect(table?.status).toBe("NOT_AVAILABLE");
    expect(table?.detail).toContain("no vector section");
  });

  test("an entry point outside the executable sections is a secondary FAILURE", () => {
    const report = reportFor(SECTIONS, profileWith(), 0x2000_0000);

    expect(report.verdict).toBe("FAILURE");
    const entry = checkNamed(report, "entry.executable");
    expect(entry?.status).toBe("FAIL");
    expect(entry?.detail).toContain("0x20000000");
  });

  test("an ELF without allocated sections is NOT_AVAILABLE, not zero bytes", () => {
    const result = checkMemoryMap(profileWith(), { artifactPath: elfWith([]) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NOT_AVAILABLE");
      expect(result.reason).toContain("no allocated sections");
    }
  });

  test("a missing file is NOT_AVAILABLE with the path", () => {
    const result = checkMemoryMap(profileWith(), {
      artifactPath: path.join(dir, "missing.elf"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("cannot read");
  });

  test("a file that is not an ELF is NOT_AVAILABLE", () => {
    const file = path.join(dir, "not-elf.bin");
    writeFileSync(file, new Uint8Array([1, 2, 3, 4]));
    const result = checkMemoryMap(profileWith(), { artifactPath: file });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not an ELF");
  });

  test("no artifact path is an invalid request", () => {
    const result = checkMemoryMap(profileWith(), { artifactPath: "  " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_REQUEST");
  });
});
