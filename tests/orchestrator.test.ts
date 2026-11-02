import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProfile, type ProductProfile } from "../core/profile";
import { notAvailable, toolOk } from "../core/toolResult";
import { realResult } from "../core/buildStatus";
import type { ExecResult } from "../tools/exec";
import { buildElf32, vectorBytes } from "./helpers/elfFixture";
import { SerialCaptureSession, type SerialBackend } from "../tools/serialCapture";
import { FakeModelRuntime } from "../agent/modelRuntime";
import {
  runOrchestrator,
  type BuildOutcome,
  type OrchestratorRequest,
  type OrchestratorTools,
} from "../agent/orchestrator";
import type { KnownIssue } from "../agent/deterministicRepair";
import type { TurnFile, TurnWrite } from "../agent/turn";
import { InMemoryVcs } from "../core/vcs";

const BASE_YAML = [
  "prodotto: DEMO-ORCH-01",
  "chip:",
  "  famiglia: stm32",
  "  regioni:",
  "    - { nome: FLASH, tipo: flash, origine: 0x08000000, dimensione: 65536 }",
  "    - { nome: RAM, tipo: ram, origine: 0x20000000, dimensione: 16384 }",
  'build: { sistema: cmake, toolchain: arm-none-eabi-gcc, comando: "cmake --build build" }',
  "flash: { tool: STM32_Programmer_CLI, interfaccia: swd }",
  "debug: { gdb_server: st, access_port: 0 }",
  "ancore: [APP, LED]",
  "tentativi_max: 3",
  "budget: { tempo_totale_ms: 60000, flash_max: 2 }",
].join("\n");

function profileWith(criteria: string, extra = ""): ProductProfile {
  const base = extra.startsWith("budget:")
    ? BASE_YAML.replace(/^budget:.*$/m, extra)
    : BASE_YAML;
  const result = loadProfile(`${base}\ncriteri:\n${criteria}`);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.profile;
}

function noCriteriaProfile(): ProductProfile {
  const result = loadProfile(`${BASE_YAML}\ncriteri: []`);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.profile;
}

const SERIAL_PASS = profileWith('  - seriale_contiene: "BOOT OK"');
const SERIAL_FAIL = profileWith('  - seriale_contiene: "BOOT OK"');
const LOG_PASS = profileWith("  - log_non_contiene: [HardFault, ERROR]");
const LOG_FAIL = profileWith("  - log_non_contiene: [HardFault, ERROR]");
const NO_CRITERIA = noCriteriaProfile();
const TARGET_PASS = profileWith("  - test_su_target: pass");
const TARGET_FAIL = profileWith("  - test_su_target: pass");

const FIRST_FILE = [
  "#include <stdint.h>",
  "",
  "// [AI_START_APP]",
  "int main(void) {",
  "    led_ini();",
  "    return 0;",
  "}",
  "// [AI_END_APP]",
  "",
  "// [AI_START_LED]",
  "void led_init(void) {}",
  "// [AI_END_LED]",
  "",
].join("\n");

const files: TurnFile[] = [{ path: "src/main.c", content: FIRST_FILE }];

const dir = mkdtempSync(path.join(tmpdir(), "py-bench-orchestrator-test-"));
const elfPath = path.join(dir, "firmware.elf");
writeFileSync(
  elfPath,
  buildElf32({
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
        bytes: new Array<number>(16).fill(0),
      },
      {
        name: ".data",
        flags: 3,
        address: 0x2000_0000,
        loadAddress: 0x0800_1000,
        bytes: [1, 2, 3, 4],
      },
    ],
  }),
);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function buildSuccess(attempt = 1): BuildOutcome {
  return {
    result: realResult({
      command: "fake build",
      exitCode: 0,
      durationMs: 1,
      stdout: "ok",
      stderr: "",
      artifacts: ["firmware.elf"],
      attempt,
      toolchain: "arm-none-eabi-gcc",
    }),
    artifactPath: elfPath,
  };
}

function buildFailure(stderr: string, attempt = 1): BuildOutcome {
  return {
    result: realResult({
      command: "fake build",
      exitCode: 1,
      durationMs: 1,
      stdout: "",
      stderr,
      attempt,
      toolchain: "arm-none-eabi-gcc",
    }),
    artifactPath: null,
  };
}

function execOk(): ExecResult {
  return {
    argv: ["fake-flash"],
    display: "fake-flash",
    exitCode: 0,
    stdout: "flashed",
    stderr: "",
    durationMs: 1,
    timedOut: false,
  };
}

function serialBackend(text: string, simulated = false): SerialBackend {
  return {
    simulated,
    start: () => toolOk({ stop: async () => text }, simulated ? "SIMULATED" : "REAL"),
  };
}

function session(text: string, simulated = false): SerialCaptureSession {
  return new SerialCaptureSession(serialBackend(text, simulated));
}

function applyWrites(files: readonly TurnFile[], writes: readonly TurnWrite[]): TurnFile[] {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  for (const write of writes) byPath.set(write.path, write.content);
  return [...byPath.entries()].map(([pathName, content]) => ({ path: pathName, content }));
}

function plan(summary: string, content: string): string {
  return JSON.stringify({
    summary,
    creates: [],
    edits: [{ path: "src/main.c", block: "APP", content }],
  });
}

async function run(
  profile: ProductProfile,
  tools: Partial<OrchestratorTools>,
  serial: SerialCaptureSession,
  modelRuntime?: FakeModelRuntime,
  now?: () => number,
  knownIssues?: KnownIssue[],
  vcs?: InMemoryVcs,
  runId?: string,
  projectDir: string = dir,
): Promise<{
  result: Awaited<ReturnType<typeof runOrchestrator>>;
  writes: TurnWrite[][];
  buildCalls: { attempt: number; content: string }[];
}> {
  const buildCalls: { attempt: number; content: string }[] = [];
  const writes: TurnWrite[][] = [];
  const request: OrchestratorRequest = {
    profile,
    project: { name: "DEMO-ORCH-01", rtos: "freertos", board: "demo", mcu: "stm32" },
    files,
    userMessage: "make the LED blink",
    projectDir,
    anchors: ["APP", "LED"],
    serialSession: serial,
    modelRuntime,
    now,
    knownIssues,
    vcs,
    runId,
    tools: {
      ...tools,
      build: (input) => {
        buildCalls.push({ attempt: input.attempt, content: input.files[0]?.content ?? "" });
        return tools.build ? tools.build(input) : buildSuccess(input.attempt);
      },
      flash: tools.flash ?? (() => toolOk(execOk())),
    },
  };
  const result = await runOrchestrator(request, {
    applyWrites: ({ writes: next }) => {
      writes.push(next);
      return applyWrites(files, next);
    },
  });
  return { result, writes, buildCalls };
}

function flashCounter(): { tools: Partial<OrchestratorTools>; count: () => number } {
  let count = 0;
  return {
    tools: {
      flash: () => {
        count += 1;
        return toolOk(execOk());
      },
    },
    count: () => count,
  };
}

describe("Phase 6c/6d orchestrator", () => {
  test("a deterministic parser repair completes the whole cycle without calling the model", async () => {
    let attempt = 0;
    const model = new FakeModelRuntime(() => {
      throw new Error("the model must not be called for a deterministic fix");
    });
    const flashes = flashCounter();
    const runResult = await run(
      SERIAL_PASS,
      {
        build: () => {
          attempt += 1;
          return attempt === 1
            ? buildFailure("src/main.c:(.text+0x4): undefined reference to `led_ini'")
            : buildSuccess(2);
        },
        ...flashes.tools,
      },
      session("BOOT OK\n"),
      model,
    );

    expect(runResult.result.ok).toBe(true);
    expect(runResult.result.code).toBe("SUCCESS");
    expect(runResult.result.attempts).toBe(2);
    expect(runResult.result.flashes).toBe(1);
    expect(runResult.result.serial?.complete).toBe(true);
    expect(runResult.result.runRecord.level).toBe("observed");
    expect(runResult.result.runRecord.status).toBe("SUCCESS");
    expect(model.callCount).toBe(0);
    expect(runResult.writes).toHaveLength(1);
    expect(runResult.writes[0]?.[0]?.block).toBe("APP");
    expect(runResult.buildCalls[1]?.content).toContain("led_init();");
    expect(runResult.buildCalls[1]?.content).not.toContain("led_ini();");
    expect(runResult.result.files[0]?.content).toContain("led_init();");
    expect(runResult.result.report).toContain("| Criterio di accettazione | Esito |");
    expect(runResult.result.report.trimEnd().split("\n").at(-1)).toContain("PASS");
  });

  test("an undefined symbol with no near match is handed to the model with no deterministic write", async () => {
    let attempt = 0;
    const prompts: string[] = [];
    const model = new FakeModelRuntime((request) => {
      prompts.push(request.prompt);
      return plan(
        "implement missing_function",
        "int main(void) {\n    missing_function();\n    return 0;\n}",
      );
    });
    const runResult = await run(
      SERIAL_PASS,
      {
        build: () => {
          attempt += 1;
          return attempt === 1
            ? buildFailure("src/main.c:(.text+0x4): undefined reference to `missing_function'")
            : buildSuccess(2);
        },
      },
      session("BOOT OK\n"),
      model,
    );

    expect(runResult.result.ok).toBe(true);
    expect(model.callCount).toBe(1);
    expect(prompts[0]).toContain("no existing declared function is one edit away");
    expect(runResult.writes).toHaveLength(1);
    expect(runResult.writes[0]?.[0]?.content).toContain("missing_function();");
    expect(runResult.writes[0]?.[0]?.content).not.toContain("void missing_function");
  });

  test("a missing include is refused outside the blocks and is handed to the model", async () => {
    let attempt = 0;
    const prompts: string[] = [];
    const model = new FakeModelRuntime((request) => {
      prompts.push(request.prompt);
      return plan("add the include inside the editable block", "#include <board.h>\nint main(void) {\n    return 0;\n}");
    });
    const flashes = flashCounter();
    const runResult = await run(
      SERIAL_PASS,
      {
        build: () => {
          attempt += 1;
          return attempt === 1
            ? buildFailure("src/main.c:1:10: fatal error: board.h: No such file or directory")
            : buildSuccess(2);
        },
        ...flashes.tools,
      },
      session("BOOT OK\n"),
      model,
      undefined,
      [
        {
          error: "fatal error: board.h: No such file or directory",
          hint: "declare the board header inside the APP block",
        },
      ],
    );

    expect(runResult.result.ok).toBe(true);
    expect(model.callCount).toBe(1);
    expect(prompts[0]).toContain("would not fix a standard function");
    expect(prompts[0]).toContain("declare the board header inside the APP block");
    expect(runResult.result.attempts).toBe(2);
    expect(runResult.result.report.trimEnd().split("\n").at(-1)).toContain("PASS");
  });

  test("an incomplete serial capture is not evaluated and cannot reach observed", async () => {
    const serial = session("BOOT OK\n");
    serial.noteFlash(); // before start: the boot banner is missing
    const runResult = await run(
      SERIAL_PASS,
      { build: () => buildSuccess() },
      serial,
    );

    expect(runResult.result.ok).toBe(false);
    expect(runResult.result.code).toBe("OBSERVATION_INCOMPLETE");
    expect(runResult.result.serial?.complete).toBe(false);
    expect(runResult.result.runRecord.level).toBeNull();
    expect(runResult.result.runRecord.status).toBe("UNKNOWN");
    expect(
      runResult.result.runRecord.record.evidence.some(
        (entry) => entry.level === "flashed" && entry.verdict === "SUCCESS",
      ),
    ).toBe(true);
    expect(runResult.result.criterionOutcomes[0]?.status).toBe("NOT_EVALUATED");
    expect(
      runResult.result.runRecord.record.evidence.some(
        (entry) => entry.level === "observed" && entry.verdict === "FAILURE",
      ),
    ).toBe(false);
    expect(runResult.result.report).toContain("NON VALUTATO");
  });

  test("a failed acceptance criterion is a FAILURE", async () => {
    const runResult = await run(
      SERIAL_FAIL,
      { build: () => buildSuccess() },
      session("BOOT BAD\n"),
    );

    expect(runResult.result.ok).toBe(false);
    expect(runResult.result.code).toBe("CRITERIA_FAILED");
    expect(runResult.result.runRecord.status).toBe("FAILURE");
    expect(runResult.result.criterionOutcomes[0]?.status).toBe("FAIL");
  });

  test("log_non_contiene passes when every forbidden token is absent", async () => {
    let attempt = 0;
    const runResult = await run(
      LOG_PASS,
      {
        build: () => {
          attempt += 1;
          return attempt === 1
            ? buildFailure("src/main.c:(.text+0x4): undefined reference to `led_ini'")
            : buildSuccess(2);
        },
      },
      session("BOOT OK\n"),
    );

    expect(runResult.result.ok).toBe(true);
    expect(runResult.result.criterionOutcomes[0]?.status).toBe("PASS");
  });

  test("log_non_contiene fails when a forbidden token appears", async () => {
    const runResult = await run(
      LOG_FAIL,
      { build: () => buildSuccess() },
      session("BOOT OK\nERROR: sensor init failed\n"),
    );

    expect(runResult.result.ok).toBe(false);
    expect(runResult.result.code).toBe("CRITERIA_FAILED");
    expect(runResult.result.criterionOutcomes[0]?.status).toBe("FAIL");
  });

  test("an on-target test criterion is evaluated after flash", async () => {
    let attempt = 0;
    const runResult = await run(
      TARGET_PASS,
      {
        build: () => {
          attempt += 1;
          return attempt === 1
            ? buildFailure("src/main.c:(.text+0x4): undefined reference to `led_ini'")
            : buildSuccess(2);
        },
        targetTest: () => toolOk({ passed: true }),
      },
      session(""),
    );

    expect(runResult.result.ok).toBe(true);
    expect(runResult.result.code).toBe("SUCCESS");
    expect(runResult.result.runRecord.level).toBe("observed");
    expect(runResult.result.files[0]?.content).toContain("led_init();");
  });

  test("a failing on-target test blocks observed", async () => {
    const runResult = await run(
      TARGET_FAIL,
      {
        build: () => buildSuccess(),
        targetTest: () => toolOk({ passed: false }),
      },
      session(""),
    );

    expect(runResult.result.ok).toBe(false);
    expect(runResult.result.code).toBe("CRITERIA_FAILED");
    expect(runResult.result.runRecord.status).toBe("FAILURE");
  });

  test("stops before flash when the profile flash budget is exhausted", async () => {
    const profile = profileWith('  - seriale_contiene: "BOOT OK"', "budget: { tempo_totale_ms: 60000, flash_max: 0 }");
    const flashes = flashCounter();
    const runResult = await run(profile, { build: () => buildSuccess(), ...flashes.tools }, session("BOOT OK\n"));

    expect(runResult.result.ok).toBe(false);
    expect(runResult.result.code).toBe("FLASH_BUDGET_EXCEEDED");
    expect(runResult.result.flashes).toBe(0);
    expect(flashes.count()).toBe(0);
    expect(runResult.result.runRecord.level).toBeNull();
    expect(runResult.result.runRecord.record.evidence.some((entry) => entry.level === "compiled")).toBe(true);
    expect(runResult.result.reason.toLowerCase()).toContain("flash budget");
  });

  test("stops with the time budget in the run record", async () => {
    const profile = profileWith('  - seriale_contiene: "BOOT OK"', "budget: { tempo_totale_ms: 1000, flash_max: 2 }");
    let calls = 0;
    const runResult = await run(profile, { build: () => buildSuccess() }, session("BOOT OK\n"), undefined, () => {
      calls += 1;
      return calls === 1 ? 0 : 2_000;
    });

    expect(runResult.result.ok).toBe(false);
    expect(runResult.result.code).toBe("TIME_BUDGET_EXCEEDED");
    expect(runResult.result.build).toBeNull();
    expect(runResult.result.reason.toLowerCase()).toContain("time budget");
  });

  test("a memory-map failure blocks flash", async () => {
    const flashes = flashCounter();
    const runResult = await run(
      SERIAL_PASS,
      {
        build: () => buildSuccess(),
        memoryMap: () => notAvailable("memory map tool unavailable"),
        ...flashes.tools,
      },
      session("BOOT OK\n"),
    );

    expect(runResult.result.ok).toBe(false);
    expect(runResult.result.code).toBe("MEMORY_MAP_FAILED");
    expect(runResult.result.flashes).toBe(0);
    expect(flashes.count()).toBe(0);
    expect(runResult.result.runRecord.level).toBeNull();
  });

  test("a build without an ELF artifact is not flashed", async () => {
    const flashes = flashCounter();
    const runResult = await run(
      SERIAL_PASS,
      {
        build: () => ({ result: buildSuccess().result, artifactPath: null }),
        ...flashes.tools,
      },
      session("BOOT OK\n"),
    );

    expect(runResult.result.ok).toBe(false);
    expect(runResult.result.code).toBe("NO_ARTIFACT");
    expect(flashes.count()).toBe(0);
  });

  test("no criteria never reaches observed and is capped at compiled", async () => {
    let attempt = 0;
    const runResult = await run(
      NO_CRITERIA,
      {
        build: () => {
          attempt += 1;
          return attempt === 1
            ? buildFailure("src/main.c:(.text+0x4): undefined reference to `led_ini'")
            : buildSuccess(2);
        },
      },
      session("BOOT OK\n"),
    );

    expect(runResult.result.ok).toBe(false);
    expect(runResult.result.code).toBe("NO_CRITERIA");
    expect(runResult.result.flashes).toBe(0);
    expect(runResult.result.runRecord.level).toBe("compiled");
    expect(runResult.result.criterionOutcomes[0]?.status).toBe("NOT_EVALUATED");
    expect(runResult.result.report.trimEnd().split("\n").at(-1)).toContain("NON VALUTATO");
  });

  test("a failed flash never produces observed evidence", async () => {
    const runResult = await run(
      SERIAL_PASS,
      {
        build: () => buildSuccess(),
        flash: () => notAvailable("no programmer connected"),
      },
      session("BOOT OK\n"),
    );

    expect(runResult.result.ok).toBe(false);
    expect(runResult.result.code).toBe("FLASH_FAILED");
    expect(runResult.result.flashes).toBe(1);
    expect(
      runResult.result.runRecord.record.evidence.some(
        (entry) => entry.level === "observed" && entry.verdict === "SUCCESS",
      ),
    ).toBe(false);
  });

  test("a serial capture that cannot start leaves serial criteria unevaluated", async () => {
    const unavailable = new SerialCaptureSession({
      simulated: false,
      start: () => notAvailable("no serial port configured"),
    });
    const runResult = await run(
      SERIAL_PASS,
      { build: () => buildSuccess() },
      unavailable,
    );

    expect(runResult.result.ok).toBe(false);
    expect(runResult.result.code).toBe("OBSERVATION_INCOMPLETE");
    expect(runResult.result.criterionOutcomes[0]?.status).toBe("NOT_EVALUATED");
    expect(runResult.result.runRecord.record.evidence.some((entry) => entry.verdict === "FAILURE")).toBe(false);
  });

  test("a model failure after an unrecognized compiler error stops the run", async () => {
    const model = new FakeModelRuntime(() => {
      throw new Error("provider unavailable");
    });
    const runResult = await run(
      SERIAL_PASS,
      { build: () => buildFailure("error: unexpected token at line 4") },
      session("BOOT OK\n"),
      model,
    );

    expect(runResult.result.ok).toBe(false);
    expect(runResult.result.code).toBe("MODEL_FAILED");
    expect(runResult.result.flashes).toBe(0);
    expect(model.callCount).toBe(1);
  });

  test("a build tool that is not available stops before flash", async () => {
    const flashes = flashCounter();
    const runResult = await run(
      SERIAL_PASS,
      {
        build: () => ({
          result: {
            ...realResult({
              command: "cmake --build build",
              exitCode: 0,
              durationMs: 0,
              stdout: "",
              stderr: "",
            }),
            verification: "NOT_AVAILABLE",
            verdict: "UNKNOWN",
            reason: "toolchain missing",
          },
          artifactPath: null,
        }),
        ...flashes.tools,
      },
      session("BOOT OK\n"),
    );

    expect(runResult.result.ok).toBe(false);
    expect(runResult.result.code).toBe("BUILD_NOT_AVAILABLE");
    expect(flashes.count()).toBe(0);
  });

  test("Phase 6d keeps a successful run branch with one commit per attempt", async () => {
    const vcs = new InMemoryVcs("main");
    let attempt = 0;
    const runResult = await run(
      SERIAL_PASS,
      {
        build: () => {
          attempt += 1;
          return attempt === 1
            ? buildFailure("src/main.c:(.text+0x4): undefined reference to `led_ini'")
            : buildSuccess(2);
        },
      },
      session("BOOT OK\n"),
      undefined,
      undefined,
      undefined,
      vcs,
      "run-6d-success",
    );

    expect(runResult.result.ok).toBe(true);
    expect(runResult.result.branch).toBe("job/run-6d-success");
    expect(runResult.result.baseBranch).toBe("main");
    expect(runResult.result.commits).toHaveLength(2);
    expect(runResult.result.commits[0]?.commit).toBe("fake-0001");
    expect(runResult.result.commits[1]?.commit).toBe("fake-0002");
    expect((await vcs.currentState()).branch).toBe("job/run-6d-success");

    const report = readFileSync(path.join(dir, "report.md"), "utf8");
    expect(report).toContain("Branch: job/run-6d-success");
    expect(report).toContain("Commit tentativo 1: fake-0001");
    expect(report).toContain("Commit tentativo 2: fake-0002");
    expect(report.trimEnd().split("\n").at(-1)).toContain("PASS");
    expect(existsSync(path.join(dir, "known_issues.yaml"))).toBe(true);
  });

  test("Phase 6d restores the base branch on failure and leaves the report", async () => {
    const vcs = new InMemoryVcs("main");
    const projectDir = mkdtempSync(path.join(tmpdir(), "py-bench-6d-failure-"));
    const model = new FakeModelRuntime(() =>
      plan("attempted fix", "int main(void) {\n    return 0;\n}"),
    );
    try {
      const runResult = await run(
        SERIAL_PASS,
        {
          build: () =>
            buildFailure("src/main.c:(.text+0x4): undefined reference to `missing_function'"),
        },
        session("BOOT OK\n"),
        model,
        undefined,
        undefined,
        vcs,
        "run-6d-failure",
        projectDir,
      );

      expect(runResult.result.ok).toBe(false);
      expect(runResult.result.code).toBe("REPAIR_LIMIT_REACHED");
      expect(runResult.result.branch).toBe("job/run-6d-failure");
      expect(runResult.result.commits).toHaveLength(3);
      expect((await vcs.currentState()).branch).toBe("main");
      expect(
        await vcs.currentState().then((state) => state.branch === "job/run-6d-failure"),
      ).toBe(false);

      const report = readFileSync(path.join(projectDir, "report.md"), "utf8");
      expect(report).toContain("branch eliminato");
      expect(report.trimEnd().split("\n").at(-1)).toContain("NON VALUTATO");
      const issues = readFileSync(path.join(projectDir, "known_issues.yaml"), "utf8");
      expect(issues).toContain("missing_function");
      expect(issues).toContain("no verified repair is recorded");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("a serial criterion cannot pass on a simulated capture", async () => {
    const runResult = await run(
      SERIAL_PASS,
      { build: () => buildSuccess() },
      session("BOOT OK\n", true),
    );

    expect(runResult.result.ok).toBe(false);
    expect(runResult.result.code).toBe("OBSERVATION_INCOMPLETE");
    expect(runResult.result.runRecord.level).toBeNull();
    expect(runResult.result.criterionOutcomes[0]?.status).toBe("NOT_EVALUATED");
  });

  test("the flash gate refuses an ELF that was never memory-map checked", async () => {
    // A report for another file is enough to record a successful map, but its
    // SHA-256 does not match this artifact, so the shared gate must refuse it.
    const otherElf = path.join(dir, "other.elf");
    writeFileSync(
      otherElf,
      buildElf32({
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
            bytes: [9, 9, 9, 9],
          },
          {
            name: ".data",
            flags: 3,
            address: 0x2000_0000,
            loadAddress: 0x0800_1000,
            bytes: [1, 2, 3, 4],
          },
        ],
      }),
    );
    const checked = await import("../tools/memoryMap").then((module) =>
      module.checkMemoryMap(SERIAL_PASS, { artifactPath: otherElf }),
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    const flashes = flashCounter();
    const runResult = await run(
      SERIAL_PASS,
      {
        build: () => buildSuccess(),
        memoryMap: () => toolOk(checked.value),
        ...flashes.tools,
      },
      session("BOOT OK\n"),
    );

    expect(runResult.result.ok).toBe(false);
    expect(runResult.result.code).toBe("FLASH_GATE_REFUSED");
    expect(flashes.count()).toBe(0);
  });
});
