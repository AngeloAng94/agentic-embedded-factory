import { afterEach, describe, expect, test } from "bun:test";
import {
  runRepairLoop,
  type RepairLoopPorts,
  type RepairLoopResult,
  type RepairRunRecord,
  type RepairRunRecorded,
} from "../agent/repairLoop";
import type { TurnFile, TurnWrite } from "../agent/turn";
import { isVerifiedSuccess, projectStatusFor } from "../core/buildStatus";
import { dispatchBuild, notAvailableFromDispatch, resolveRunnerConfig } from "../core/buildDispatch";
import { validateRunRecord } from "../core/runRecord";

/**
 * These are the old Convex-cycle tests (agentCycle.test.ts) moved onto the
 * Convex-free loop. The LLM and the build runner are real HTTP servers on
 * localhost: a fake success would have to come from a real process, and there
 * is no injected "pretend" path.
 */

const MAIN_C = ["int main(void) {", "    return 0;", "}", ""].join("\n");

function seedFiles(): TurnFile[] {
  return [
    { path: "CMakeLists.txt", content: "project(demo)\n" },
    { path: "prj.conf", content: "CONFIG_MAIN_STACK_SIZE=2048\n" },
    { path: "src/main.c", content: MAIN_C },
  ];
}

class MemoryStore implements RepairLoopPorts {
  files: TurnFile[];
  runs: RepairRunRecord[] = [];
  runRecords: RepairRunRecorded[] = [];
  messages: { content: string; meta?: unknown }[] = [];
  versions = new Map<string, { verdict: string | null }>();
  status: "verified" | "unverified" | "failed" = "unverified";

  constructor(files: TurnFile[]) {
    this.files = files.map((file) => ({ ...file }));
  }

  applyWrites({ writes }: { writes: TurnWrite[]; attempt: number; summary: string }): TurnFile[] {
    for (const write of writes) {
      const index = this.files.findIndex((file) => file.path === write.path);
      if (index === -1) this.files.push({ path: write.path, content: write.content });
      else this.files[index] = { path: write.path, content: write.content };
      if (!this.versions.has(write.path)) this.versions.set(write.path, { verdict: null });
    }
    return this.files;
  }

  record(run: RepairRunRecord): void {
    this.runs.push(run);
    if (run.type === "build") this.status = projectStatusFor(run.build);
  }

  recordRun(run: RepairRunRecorded): void {
    this.runRecords.push(run);
  }

  onBuildRecorded({ build }: { attempt: number; build: Parameters<typeof isVerifiedSuccess>[0] }): void {
    for (const version of this.versions.values()) version.verdict = build.verdict;
  }

  say(content: string, meta?: unknown): void {
    this.messages.push({ content, meta });
  }

  builds(): Extract<RepairRunRecord, { type: "build" }>[] {
    return this.runs.filter((run): run is Extract<RepairRunRecord, { type: "build" }> => run.type === "build");
  }

  retrieval(): Extract<RepairRunRecord, { type: "retrieval" }>[] {
    return this.runs.filter(
      (run): run is Extract<RepairRunRecord, { type: "retrieval" }> => run.type === "retrieval",
    );
  }
}

/** These tests must never reach the network: only loopback is allowed. */
function loopback(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function startLlm(answerFor: (call: number) => string) {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      calls += 1;
      return Response.json({ response: answerFor(calls) });
    },
  });
  return {
    url: loopback(server.port!),
    calls: () => calls,
    stop: () => server.stop(true),
  };
}

function startRunner(
  resultFor: (attempt: number) => Record<string, unknown>,
  health: Record<string, unknown> = { ok: true },
) {
  const attempts: number[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json().catch(() => ({}))) as { attempt?: number };
      const attempt = Number(body.attempt ?? 1);
      attempts.push(attempt);
      if (health.ok === false) return Response.json(health, { status: 500 });
      return Response.json(resultFor(attempt));
    },
  });
  return {
    url: loopback(server.port!),
    attempts,
    stop: () => server.stop(true),
  };
}

const realSuccess = (overrides: Record<string, unknown> = {}) => ({
  verification: "REAL",
  verdict: "SUCCESS",
  command: "west build -b nucleo_l476rg -d build -p auto",
  toolchain: "West version: v1.2.0",
  exitCode: 0,
  durationMs: 18400,
  stdout: "[build] Built target zephyr.elf",
  stderr: "",
  artifacts: ["build/zephyr/zephyr.elf"],
  reason: null,
  ...overrides,
});

const realFailure = {
  verification: "REAL",
  verdict: "FAILURE",
  command: "west build",
  exitCode: 1,
  durationMs: 3200,
  stdout: "",
  stderr: "src/main.c:3:5: error: implicit declaration of function 'init_all'",
  artifacts: [],
  reason: null,
};

const createPlan = (path: string) =>
  JSON.stringify({
    summary: `create ${path}`,
    creates: [{ path, content: "void init_all(void) {}\n" }],
    edits: [],
    requestBuild: true,
  });

/** `expect(...).toBe(false)` does not narrow the union: this does. */
function expectFailure(result: RepairLoopResult): Extract<RepairLoopResult, { ok: false }> {
  if (result.ok) throw new Error(`expected a failure, received status ${result.status}`);
  return result;
}

const project = {
  name: "demo",
  rtos: "zephyr",
  board: "nucleo_l476rg",
  mcu: "stm32l476rg",
};

const envWith = (extra: Record<string, string> = {}) => ({
  LLM_PROVIDER: "ollama",
  LLM_MAX_RETRIES: "0",
  LLM_TIMEOUT_MS: "5000",
  ...extra,
});

const knowledge = [
  {
    _id: "kb:1",
    rtos: "zephyr" as const,
    category: "pattern",
    title: "Zephyr GPIO interrupt pattern",
    content: "k_work_submit from the ISR and defer blocking work to a workqueue.",
    tags: ["zephyr", "gpio", "isr"],
  },
];

afterEach(() => {
  delete process.env.BUILD_RUNNER_URL;
});

describe("repair loop — the model never fabricates code", () => {
  test("unreachable provider: explicit error, no file change, no build", async () => {
    const store = new MemoryStore(seedFiles());
    const result = await runRepairLoop(
      {
        project,
        files: store.files,
        userMessage: "add an LED driver",
        env: envWith({ LLM_BASE_URL: "http://127.0.0.1:1" }),
      },
      store,
    );

    expect(expectFailure(result).code).toBe("LLM_UNREACHABLE");
    expect(store.files).toEqual(seedFiles());
    expect(store.versions.size).toBe(0);
    expect(store.builds()).toHaveLength(0);
    expect(store.status).toBe("unverified");

    const last = store.messages[store.messages.length - 1];
    expect(String(last?.content)).toContain("no files were created or modified");
    expect(String(last?.content)).toContain("LLM_UNREACHABLE");
  });

  test("unusable model answer: nothing is written either", async () => {
    const llm = startLlm(() => "I am sorry, I cannot produce JSON today.");
    const store = new MemoryStore(seedFiles());

    try {
      const result = await runRepairLoop(
        {
          project,
          files: store.files,
          userMessage: "add an LED driver",
          env: envWith({ LLM_BASE_URL: llm.url }),
        },
        store,
      );

      expect(expectFailure(result).code).toBe("LLM_BAD_RESPONSE");
      expect(store.files).toEqual(seedFiles());
      expect(store.versions.size).toBe(0);
    } finally {
      llm.stop();
    }
  });

  test("an edit outside the declared blocks is PATCH_FAILED and nothing is written", async () => {
    const llm = startLlm(() =>
      JSON.stringify({
        summary: "edit main",
        creates: [],
        edits: [{ path: "src/main.c", block: "NOPE", content: "void init(void) {}" }],
        requestBuild: true,
      }),
    );
    const store = new MemoryStore(seedFiles());

    try {
      const result = await runRepairLoop(
        {
          project,
          files: store.files,
          userMessage: "change main",
          anchors: ["APP"],
          env: envWith({ LLM_BASE_URL: llm.url }),
        },
        store,
      );

      expect(expectFailure(result).code).toBe("PATCH_FAILED");
      expect(store.files).toEqual(seedFiles());
      expect(store.versions.size).toBe(0);
    } finally {
      llm.stop();
    }
  });
});

describe("repair loop — build evidence and repair", () => {
  test("no runner: changes are saved, build NOT_AVAILABLE, never verified", async () => {
    const llm = startLlm(() => createPlan("src/led.c"));
    const store = new MemoryStore(seedFiles());

    try {
      const result = await runRepairLoop(
        {
          project,
          files: store.files,
          userMessage: "add an LED driver",
          env: envWith({ LLM_BASE_URL: llm.url }),
        },
        store,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.status).toBe("BUILD_NOT_AVAILABLE");

      expect(store.files.some((file) => file.path === "src/led.c")).toBe(true);

      const [build] = store.builds();
      expect(build?.build.verification).toBe("NOT_AVAILABLE");
      expect(build?.build.verdict).toBe("UNKNOWN");
      expect(String(build?.build.reason)).toContain("RUNNER_NOT_CONFIGURED");

      expect(store.status).toBe("unverified");
      expect(store.runRecords).toHaveLength(1);
      expect(store.runRecords[0]?.level).toBe("written");
      expect(store.runRecords[0]?.status).toBe("UNKNOWN");
    } finally {
      llm.stop();
    }
  });

  test("a real runner success records the evidence and marks the project verified", async () => {
    const llm = startLlm(() => createPlan("src/led.c"));
    const runner = startRunner(() => realSuccess());
    const store = new MemoryStore(seedFiles());

    try {
      const result = await runRepairLoop(
        {
          project,
          files: store.files,
          userMessage: "add an LED driver",
          knowledge,
          env: envWith({ LLM_BASE_URL: llm.url, BUILD_RUNNER_URL: runner.url }),
        },
        store,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.status).toBe("SUCCESS");

      const [build] = store.builds();
      expect(build?.build.verification).toBe("REAL");
      expect(build?.build.verdict).toBe("SUCCESS");
      expect(build?.build.exitCode).toBe(0);
      expect(build?.build.command).toBe("west build -b nucleo_l476rg -d build -p auto");
      expect(build?.build.artifacts).toEqual(["build/zephyr/zephyr.elf"]);

      expect(store.status).toBe("verified");
      expect(store.versions.get("src/led.c")?.verdict).toBe("SUCCESS");

      expect(store.runRecords).toHaveLength(1);
      const recorded = store.runRecords[0]!;
      expect(recorded.level).toBe("compiled");
      expect(recorded.status).toBe("UNKNOWN");
      expect(recorded.simulated).toBe(false);
      expect(recorded.record.changes).toEqual([
        { path: "src/led.c", kind: "create", block: null },
      ]);
      expect(recorded.record.evidence.map((entry) => entry.level)).toEqual([
        "written",
        "compiled",
      ]);
      expect(validateRunRecord(recorded.record).ok).toBe(true);
      expect("level" in recorded.record).toBe(false);

      // retrieval is real and recorded as evidence, not printed as decoration
      const [retrieval] = store.retrieval();
      expect(retrieval).toBeDefined();
      expect(String(retrieval?.log)).toContain("[kb]");
      expect(runner.attempts).toEqual([1]);
    } finally {
      llm.stop();
      runner.stop();
    }
  });

  test("no profile criteria: compiled at most, UNKNOWN, and a stated reason", async () => {
    const llm = startLlm(() => createPlan("src/no_criteria.c"));
    const runner = startRunner(() => realSuccess());
    const store = new MemoryStore(seedFiles());

    try {
      const result = await runRepairLoop(
        {
          project,
          files: store.files,
          userMessage: "build without a profile criterion",
          env: envWith({ LLM_BASE_URL: llm.url, BUILD_RUNNER_URL: runner.url }),
        },
        store,
      );

      expect(result.ok).toBe(true);
      const recorded = store.runRecords[0]!;
      expect(result.runRecord.record.criteria).toEqual([]);
      expect(recorded.level).toBe("compiled");
      expect(recorded.status).toBe("UNKNOWN");
      expect(recorded.reason).toContain("No acceptance criteria are declared");
      expect(validateRunRecord(recorded.record).ok).toBe(true);
    } finally {
      llm.stop();
      runner.stop();
    }
  });

  test("an explicit simulation never records a REAL level", async () => {
    const llm = startLlm(() => createPlan("src/simulated.c"));
    const runner = startRunner(() => realSuccess());
    const store = new MemoryStore(seedFiles());

    try {
      await runRepairLoop(
        {
          project,
          files: store.files,
          userMessage: "simulate an LED driver",
          simulated: true,
          env: envWith({ LLM_BASE_URL: llm.url, BUILD_RUNNER_URL: runner.url }),
        },
        store,
      );

      const recorded = store.runRecords[0]!;
      expect(recorded.simulated).toBe(true);
      expect(recorded.level).toBeNull();
      expect(recorded.status).toBe("UNKNOWN");
      expect(recorded.record.evidence.length).toBeGreaterThan(0);
      for (const evidence of recorded.record.evidence) {
        expect(evidence.verification).toBe("SIMULATED");
      }
      if (recorded.level !== null) {
        expect(["written", "compiled"]).toContain(recorded.level);
      }
    } finally {
      llm.stop();
      runner.stop();
    }
  });

  test("a runner claiming SUCCESS without a real process verifies nothing", async () => {
    const llm = startLlm((call) => createPlan(`src/led_${call}.c`));
    const runner = startRunner(() =>
      realSuccess({ verification: "SIMULATED", verdict: "SUCCESS", exitCode: null }),
    );
    const store = new MemoryStore(seedFiles());

    try {
      const result = await runRepairLoop(
        {
          project,
          files: store.files,
          userMessage: "add an LED driver",
          env: envWith({ LLM_BASE_URL: llm.url, BUILD_RUNNER_URL: runner.url }),
        },
        store,
      );

      const builds = store.builds();
      expect(builds.length).toBeGreaterThan(0);
      expect(builds.every((run) => run.build.verdict === "UNKNOWN")).toBe(true);
      expect(String(builds[0]?.build.reason)).toContain(
        "claimed SUCCESS without a real successful process",
      );
      expect(store.status).toBe("unverified");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("REPAIR_LIMIT_REACHED");
    } finally {
      llm.stop();
      runner.stop();
    }
  });

  test("repair: the compiler error is fed back and the rebuild succeeds", async () => {
    const llm = startLlm((call) => createPlan(`src/attempt_${call}.c`));
    const runner = startRunner((attempt) => (attempt === 1 ? realFailure : realSuccess()));
    const store = new MemoryStore(seedFiles());

    try {
      const result = await runRepairLoop(
        {
          project,
          files: store.files,
          userMessage: "add an init step",
          env: envWith({ LLM_BASE_URL: llm.url, BUILD_RUNNER_URL: runner.url }),
        },
        store,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status).toBe("SUCCESS");
        expect(result.attempts).toBe(2);
      }
      expect(llm.calls()).toBe(2);
      expect(store.builds()).toHaveLength(2);
      expect(store.builds().some((run) => run.build.verdict === "FAILURE")).toBe(true);
      expect(store.builds().some((run) => run.build.verdict === "SUCCESS")).toBe(true);
      expect(store.status).toBe("verified");
    } finally {
      llm.stop();
      runner.stop();
    }
  });

  test("repair limit: 3 attempts, then BUILD FAILED — REPAIR LIMIT REACHED", async () => {
    const llm = startLlm((call) => createPlan(`src/attempt_${call}.c`));
    const runner = startRunner(() => realFailure);
    const store = new MemoryStore(seedFiles());

    try {
      const result = await runRepairLoop(
        {
          project,
          files: store.files,
          userMessage: "add an init step",
          env: envWith({ LLM_BASE_URL: llm.url, BUILD_RUNNER_URL: runner.url }),
        },
        store,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("REPAIR_LIMIT_REACHED");
        expect(result.attempts).toBe(3);
        expect(result.message).toContain("REPAIR LIMIT REACHED");
      }
      expect(llm.calls()).toBe(3);
      expect(store.status).toBe("failed");
      expect(store.builds()).toHaveLength(3);
      expect(store.runRecords).toHaveLength(1);
      expect(store.runRecords[0]?.level).toBe("written");
      expect(store.runRecords[0]?.status).toBe("FAILURE");
      expect(store.runRecords[0]?.record.evidence.at(-1)?.level).toBe("compiled");
      expect(store.runRecords[0]?.record.evidence.at(-1)?.verdict).toBe("FAILURE");
      expect(String(store.builds()[0]?.build.stderr)).toContain("implicit declaration");
    } finally {
      llm.stop();
      runner.stop();
    }
  });

  test("answer only: no write and no build, answered as a question", async () => {
    const llm = startLlm(() =>
      JSON.stringify({
        summary: "The LED is on PA5 on this board.",
        creates: [],
        edits: [],
        requestBuild: false,
        answerOnly: true,
      }),
    );
    const store = new MemoryStore(seedFiles());

    try {
      const result = await runRepairLoop(
        {
          project,
          files: store.files,
          userMessage: "which pin is the LED on?",
          env: envWith({ LLM_BASE_URL: llm.url }),
        },
        store,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.status).toBe("ANSWER_ONLY");
      expect(store.files).toEqual(seedFiles());
      expect(store.builds()).toHaveLength(0);
      expect(store.messages[store.messages.length - 1]?.content).toContain("PA5");
      expect(store.runRecords).toHaveLength(1);
      expect(store.runRecords[0]?.level).toBeNull();
      expect(store.runRecords[0]?.status).toBe("UNKNOWN");
      expect(store.runRecords[0]?.record.evidence).toEqual([]);
      expect(store.runRecords[0]?.record.changes).toEqual([]);
    } finally {
      llm.stop();
    }
  });

  test("changes without a build are CHANGES_APPLIED and claim nothing", async () => {
    const llm = startLlm(() =>
      JSON.stringify({
        summary: "add a comment-only helper",
        creates: [{ path: "src/notes.c", content: "/* notes */\n" }],
        edits: [],
        requestBuild: false,
      }),
    );
    const store = new MemoryStore(seedFiles());

    try {
      const result = await runRepairLoop(
        {
          project,
          files: store.files,
          userMessage: "add a notes file",
          env: envWith({ LLM_BASE_URL: llm.url }),
        },
        store,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status).toBe("CHANGES_APPLIED");
        expect(result.build).toBeNull();
      }
      expect(store.files.some((file) => file.path === "src/notes.c")).toBe(true);
      expect(store.builds()).toHaveLength(0);
      expect(store.status).toBe("unverified");
    } finally {
      llm.stop();
    }
  });

  test("a standalone build with no runner is NOT_AVAILABLE, never fake evidence", async () => {
    const dispatch = await dispatchBuild(resolveRunnerConfig({}), {
      projectName: "demo",
      rtos: "zephyr",
      files: [],
      attempt: 1,
    });

    expect(dispatch.ok).toBe(false);
    if (!dispatch.ok) {
      expect(dispatch.code).toBe("RUNNER_NOT_CONFIGURED");
      const build = notAvailableFromDispatch(dispatch.code, dispatch.message, 1);
      expect(build.verification).toBe("NOT_AVAILABLE");
      expect(build.verdict).toBe("UNKNOWN");
      expect(String(build.reason)).toContain("RUNNER_NOT_CONFIGURED");
    }
  });

  test("time budget: stops before a new attempt and says why", async () => {
    const llm = startLlm((call) => createPlan(`src/attempt_${call}.c`));
    const runner = startRunner(() => realFailure);
    const store = new MemoryStore(seedFiles());
    const times = [0, 0, 10_000];
    let index = 0;
    const now = () => times[Math.min(index++, times.length - 1)]!;

    try {
      const result = await runRepairLoop(
        {
          project,
          files: store.files,
          userMessage: "add an init step",
          timeBudgetMs: 5_000,
          now,
          env: envWith({ LLM_BASE_URL: llm.url, BUILD_RUNNER_URL: runner.url }),
        },
        store,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("TIME_BUDGET_EXHAUSTED");
        expect(result.attempts).toBe(1);
      }
      expect(store.builds()).toHaveLength(1);
      expect(store.status).toBe("failed");
    } finally {
      llm.stop();
      runner.stop();
    }
  });
});
