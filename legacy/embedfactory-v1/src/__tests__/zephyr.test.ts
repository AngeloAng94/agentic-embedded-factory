import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  detectFormat,
  inspectArtifactFile,
  inspectArtifacts,
  mergeMemoryUsage,
  parseElfHeader,
  parseGnuSize,
  parseHumanSize,
  parseMemoryReport,
  sha256Hex,
} from "../lib/core/artifactInspect";
import { resolveExecutable } from "../lib/core/buildEngine";
import {
  DEFAULT_REFERENCE_BOARD,
  findZephyrSdk,
  formatDoctorReport,
  readSdkVersion,
  runDoctor,
} from "../lib/core/toolchainDoctor";
import { buildProjectManifest } from "../lib/core/projectExport";
import {
  BROKEN_MAIN_C,
  SKIP_MESSAGE,
  extractCompilerErrors,
  loadReferenceProject,
  referenceProjectFiles,
  runZephyrVerification,
} from "../../runner/lib/verify";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const COMPILER = resolveExecutable("cc") ? "cc" : resolveExecutable("gcc") ? "gcc" : null;

// The environment is probed once, at load time. The Zephyr end-to-end test is
// gated on the real answer: a machine without the toolchain reports SKIPPED
// (never a fake PASS).
const doctor = await runDoctor(process.env, {
  board: process.env.EMBEDFACTORY_BOARD ?? DEFAULT_REFERENCE_BOARD,
  cwd: REPO_ROOT,
});
if (!doctor.ready) {
  console.log(`[zephyr] ${SKIP_MESSAGE} (missing: ${doctor.missing.join(", ")})`);
}

/** A synthetic but byte-accurate ELF header: no compiler or platform needed. */
function makeSyntheticElf(
  options: { classByte?: number; little?: boolean; machine?: number; type?: number } = {},
): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46], 0);
  bytes[4] = options.classByte ?? 2;
  const little = options.little ?? true;
  bytes[5] = little ? 1 : 2;
  const view = new DataView(bytes.buffer);
  view.setUint16(16, options.type ?? 2, little);
  view.setUint16(18, options.machine ?? 40, little);
  view.setBigUint64(24, 0x8000_0000n, little);
  return bytes;
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "embedfactory-zephyr-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("environment doctor", () => {
  test("returns a structured report whose READY verdict matches its missing list", () => {
    expect(doctor.board).toBe(process.env.EMBEDFACTORY_BOARD ?? DEFAULT_REFERENCE_BOARD);
    expect(doctor.checks.length).toBeGreaterThanOrEqual(8);
    expect(doctor.ready).toBe(doctor.environment === "READY");
    expect(doctor.ready).toBe(doctor.missing.length === 0);

    for (const entry of doctor.checks) {
      expect(["PASS", "MISSING"]).toContain(entry.status);
      expect(typeof entry.detail).toBe("string");
      expect(entry.detail.length).toBeGreaterThan(0);
    }

    // Every required check that is missing must be listed by label.
    for (const entry of doctor.checks) {
      if (entry.required && entry.status === "MISSING") {
        expect(doctor.missing).toContain(entry.label);
      }
      if (entry.status === "PASS") expect(doctor.missing).not.toContain(entry.label);
    }
  });

  test("covers the dependencies a real Zephyr build needs", () => {
    const ids = doctor.checks.map((entry) => entry.id);
    for (const id of ["west", "cmake", "generator", "python", "dtc", "zephyr_base", "zephyr_sdk", "arm_toolchain", "board"]) {
      expect(ids).toContain(id);
    }
  });

  test("formats READY / NOT_READY with an explicit Missing list", () => {
    const text = formatDoctorReport(doctor);
    expect(text).toContain("EmbedFactory Environment");
    expect(text).toMatch(new RegExp(`Environment\\s+${doctor.environment}`));
    expect(text).toMatch(new RegExp(`Board\\s+${doctor.board}`));

    if (doctor.ready) {
      expect(text).not.toContain("Missing:");
    } else {
      expect(text).toContain("NOT_READY");
      expect(text).toContain("Missing:");
      for (const item of doctor.missing) expect(text).toContain(`- ${item}`);
    }
  });

  test("finds a Zephyr SDK from ZEPHYR_SDK_INSTALL_DIR and reads its version", () => {
    const dir = path.join(tempDir(), "zephyr-sdk-0.16.5");
    mkdirSync(dir, { recursive: true });
    expect(readSdkVersion(dir)).toBe("0.16.5");
    writeFileSync(path.join(dir, "sdk_version"), "0.16.7\n", "utf8");
    expect(readSdkVersion(dir)).toBe("0.16.7");
    expect(findZephyrSdk({ ZEPHYR_SDK_INSTALL_DIR: dir })).toBe(dir);
    expect(findZephyrSdk({ ZEPHYR_SDK_INSTALL_DIR: path.join(tempDir(), "nope") })).not.toBe(dir);
  });
});

describe("artifact validation", () => {
  test("computes the real sha256 of the bytes", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("decodes an ELF header straight from the file", () => {
    const header = parseElfHeader(makeSyntheticElf());
    expect(header).not.toBeNull();
    expect(header?.class).toBe("ELF64");
    expect(header?.endianness).toBe("little");
    expect(header?.type).toBe("EXEC");
    expect(header?.architecture).toBe("ARM");
    expect(header?.machine).toContain("e_machine=40");
    expect(header?.entry).toBe("0x80000000");

    expect(parseElfHeader(makeSyntheticElf({ classByte: 1, machine: 243 }))?.architecture).toBe("RISC-V");
    expect(parseElfHeader(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(parseElfHeader(new Uint8Array(0))).toBeNull();
  });

  test("detects the format from the real magic bytes, not the file name", () => {
    expect(detectFormat("zephyr.elf", makeSyntheticElf())).toBe("elf");
    expect(detectFormat("zephyr.bin", new Uint8Array([1, 2, 3, 4]))).toBe("bin");
    expect(detectFormat("zephyr.bin", new Uint8Array([0x55, 0x46, 0x32, 0x0a]))).toBe("uf2");
    expect(detectFormat("zephyr.hex", new TextEncoder().encode(":1000000000C0"))).toBe("hex");
    expect(detectFormat("zephyr.elf", new Uint8Array([1, 2, 3, 4]))).toBe("elf"); // extension fallback
  });

  test("inspects a real file on disk: existence, size, hash, format, ELF", () => {
    const dir = tempDir();
    const elf = makeSyntheticElf();
    writeFileSync(path.join(dir, "zephyr.elf"), elf);

    const info = inspectArtifactFile(path.join(dir, "zephyr.elf"), "build/zephyr/zephyr.elf");
    expect(info).not.toBeNull();
    expect(info?.path).toBe("build/zephyr/zephyr.elf");
    expect(info?.bytes).toBe(elf.byteLength);
    expect(info?.sha256).toBe(sha256Hex(elf));
    expect(info?.format).toBe("elf");
    expect(info?.elf?.architecture).toBe("ARM");

    expect(inspectArtifactFile(path.join(dir, "missing.elf"), "build/missing.elf")).toBeNull();
    expect(inspectArtifacts(dir, ["zephyr.elf", "missing.elf"]).map((entry) => entry.path)).toEqual([
      "zephyr.elf",
    ]);
  });

  test.skipIf(COMPILER === null)("validates a real compiler output too", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "main.c"), "int main(void) { return 0; }\n", "utf8");
    const proc = Bun.spawnSync({
      cmd: [COMPILER!, "main.c", "-o", "firmware"],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return; // linker quirks on this host: nothing to assert

    const info = inspectArtifactFile(path.join(dir, "firmware"), "build/firmware");
    expect(info).not.toBeNull();
    expect(info!.bytes).toBeGreaterThan(0);
    expect(info!.sha256).toHaveLength(64);
  });
});

describe("flash/RAM evidence", () => {
  // Verbatim shape of the report the Zephyr linker prints at the end of a build.
  const ZEPHYR_REPORT = [
    "Memory region         Used Size  Region Size  %age Used",
    "           FLASH:       41236 B       256 KB     15.73%",
    "             RAM:        9536 B        64 KB     14.55%",
    "        IDT_LIST:          0 GB         2 KB      0.00%",
  ].join("\n");

  test("parses human sizes", () => {
    expect(parseHumanSize("41236 B")).toBe(41236);
    expect(parseHumanSize("256 KB")).toBe(256 * 1024);
    expect(parseHumanSize("1 MB")).toBe(1024 * 1024);
    expect(parseHumanSize("2 GB")).toBe(2 * 1024 * 1024 * 1024);
    expect(parseHumanSize("nonsense")).toBeNull();
  });

  test("parses the Zephyr linker memory report", () => {
    const memory = parseMemoryReport(ZEPHYR_REPORT);
    expect(memory).not.toBeNull();
    expect(memory?.flashUsed).toBe(41236);
    expect(memory?.flashTotal).toBe(256 * 1024);
    expect(memory?.ramUsed).toBe(9536);
    expect(memory?.ramTotal).toBe(64 * 1024);
    expect(memory?.report).toContain("FLASH:");
    expect(parseMemoryReport("nothing to see here")).toBeNull();
  });

  test("parses the binutils size output and merges it in", () => {
    const sizeOutput = [
      "   text\t   data\t    bss\t    dec\t    hex\tfilename",
      "   1234\t     56\t    789\t   2079\t    81f\tbuild/zephyr/zephyr.elf",
    ].join("\n");
    const sections = parseGnuSize(sizeOutput);
    expect(sections).toEqual({ text: 1234, data: 56, bss: 789 });
    expect(parseGnuSize("no table here")).toBeNull();

    const merged = mergeMemoryUsage(parseMemoryReport(ZEPHYR_REPORT), sections);
    expect(merged?.flashUsed).toBe(41236);
    expect(merged?.sections?.bss).toBe(789);

    // Without the linker report, `size` alone still yields usable numbers.
    const fromSize = mergeMemoryUsage(null, sections);
    expect(fromSize?.flashUsed).toBe(1234 + 56);
    expect(fromSize?.ramUsed).toBe(56 + 789);
    expect(mergeMemoryUsage(null, null)).toBeNull();
  });
});

describe("reference Zephyr project", () => {
  test("is a real, buildable Zephyr application", () => {
    const files = referenceProjectFiles(REPO_ROOT);
    for (const required of ["CMakeLists.txt", "prj.conf", "src/main.c"]) {
      expect(files).toContain(required);
    }

    const project = loadReferenceProject(REPO_ROOT);
    const byPath = new Map(project.map((file) => [file.path, file.content]));
    expect(byPath.get("CMakeLists.txt")).toContain("find_package(Zephyr");
    expect(byPath.get("src/main.c")).toContain("<zephyr/kernel.h>");
    expect(byPath.get("prj.conf")).toContain("CONFIG_PRINTK=y");
    for (const file of project) expect(file.content.trim().length).toBeGreaterThan(0);
  });

  test("uses only portable Zephyr APIs (no invented board support)", () => {
    const main = loadReferenceProject(REPO_ROOT).find((file) => file.path === "src/main.c")!.content;
    expect(main).not.toContain("DT_ALIAS");
    expect(main).toContain("k_sleep(");
    expect(main).toContain("printk(");
    // The intentionally broken variant must call a symbol Zephyr does not have.
    expect(BROKEN_MAIN_C).toContain("gpio_pin_configure_led0_blink");
    expect(BROKEN_MAIN_C).not.toBe(main);
  });
});

describe("compiler error extraction", () => {
  test("keeps the real compiler/linker lines", () => {
    const excerpt = extractCompilerErrors(
      "src/main.c: In function 'main':\nsrc/main.c:12:2: error: implicit declaration of function 'x'\nundefined reference to `gpio_pin_configure_led0_blink'",
    );
    expect(excerpt).toContain("error: implicit declaration");
    expect(excerpt).toContain("undefined reference");
    expect(extractCompilerErrors("everything is fine")).toBeNull();
  });
});

describe("export manifest board profile", () => {
  test("records rtos/board/toolchain/verification/verdict", () => {
    const manifest = buildProjectManifest(
      { name: "demo", rtos: "zephyr", board: "nucleo_l476rg", mcu: null },
      [{ path: "src/main.c", content: "int main(void) { return 0; }\n" }],
      {
        verification: "REAL · SUCCESS",
        verdict: "SUCCESS",
        toolchain: "West version: v1.2.0",
      },
    );

    expect(manifest.rtos).toBe("zephyr");
    expect(manifest.board).toBe("nucleo_l476rg");
    expect(manifest.toolchain).toBe("West version: v1.2.0");
    expect(manifest.verdict).toBe("SUCCESS");
    expect(manifest.boardProfile).toEqual({
      rtos: "zephyr",
      board: "nucleo_l476rg",
      toolchain: "West version: v1.2.0",
      verification: "REAL · SUCCESS",
      verdict: "SUCCESS",
    });
    expect(manifest.buildCommand).toContain("west build -b nucleo_l476rg");
  });

  test("an unbuilt project is never reported as verified", () => {
    const manifest = buildProjectManifest(
      { name: "demo", rtos: "zephyr", board: null, mcu: null },
      [],
    );
    expect(manifest.verification).toBe("NOT_VERIFIED");
    expect(manifest.verdict).toBe("UNKNOWN");
    expect(manifest.boardProfile.verdict).toBe("UNKNOWN");
  });
});

describe("real Zephyr end-to-end (gated on the real toolchain)", () => {
  test.skipIf(doctor.ready)("reports SKIPPED instead of a fake success", async () => {
    const report = await runZephyrVerification({ repoRoot: REPO_ROOT });
    expect(report.skipped).toBe(true);
    expect(report.skipReason).toBe(SKIP_MESSAGE);
    expect(report.ok).toBe(false);
    expect(report.attempt1).toBeNull();
    expect(report.attempt2).toBeNull();
    // The reason is concrete: the doctor names what is missing.
    expect(report.doctor.missing.length).toBeGreaterThan(0);
  });

  test.skipIf(!doctor.ready)(
    "west build: real failure -> real stderr -> repair -> real success + artifacts + export",
    async () => {
      const report = await runZephyrVerification({
        repoRoot: REPO_ROOT,
        timeoutMs: 10 * 60 * 1000,
      });

      expect(report.skipped).toBe(false);
      expect(report.workspace).not.toBeNull();

      // Attempt 1: the real toolchain must reject the broken source.
      expect(report.attempt1?.verification).toBe("REAL");
      expect(report.attempt1?.verdict).toBe("FAILURE");
      expect(report.attempt1?.exitCode).not.toBe(0);
      expect(report.errorExcerpt).not.toBeNull();
      expect(report.attempt1?.command).toContain("west build");
      expect(report.attempt1?.board).toBe(report.board);

      // Repair then rebuild: a real, zero-exit process.
      expect(["llm", "deterministic"]).toContain(report.repairSource);
      expect(report.attempt2?.verification).toBe("REAL");
      expect(report.attempt2?.verdict).toBe("SUCCESS");
      expect(report.attempt2?.exitCode).toBe(0);
      expect(report.attempt2?.attempt).toBe(2);

      // Artifacts really exist and were validated.
      expect(report.artifacts.length).toBeGreaterThan(0);
      const elf = report.artifacts.find((entry) => entry.path.endsWith("zephyr.elf"));
      expect(elf).toBeDefined();
      expect(elf!.bytes).toBeGreaterThan(0);
      expect(elf!.sha256).toHaveLength(64);
      expect(elf!.format).toBe("elf");
      expect(elf!.elf?.architecture).not.toBeNull();

      // FLASH/RAM usage comes from the real toolchain output.
      expect(report.memory).not.toBeNull();
      expect(report.memory?.flashUsed ?? report.memory?.ramUsed).not.toBeNull();

      // The manifest carries the board profile.
      expect(report.exportManifest?.boardProfile).toEqual({
        rtos: "zephyr",
        board: report.board,
        toolchain: report.attempt2?.toolchain ?? null,
        verification: "REAL · SUCCESS",
        verdict: "SUCCESS",
      });
      expect(report.archivePath).not.toBeNull();
      expect(report.ok).toBe(true);
    },
    10 * 60 * 1000,
  );
});
