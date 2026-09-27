import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as agent from "../convex/agent";
import * as agentStore from "../convex/agentStore";
import * as messages from "../convex/messages";
import * as runs from "../convex/runs";
import * as knowledgeBase from "../convex/knowledgeBase";
import { FakeDb, handlerOf, makeCtx } from "./helpers/fakeConvex";

const USER = "users:1";
const PROJECT = "projects:A";

const REGISTRY = {
  "agentStore:projectContext": agentStore.projectContext,
  "agentStore:listFiles": agentStore.listFiles,
  "agentStore:applyPlan": agentStore.applyPlan,
  "agentStore:attachBuildToVersions": agentStore.attachBuildToVersions,
  "messages:insertInternal": messages.insertInternal,
  "runs:insert": runs.insert,
  "knowledgeBase:allDocuments": knowledgeBase.allDocuments,
};

const MAIN_C = ["int main(void) {", "    return 0;", "}", ""].join("\n");

function seedProject() {
  const db = new FakeDb();
  db.seed("users", [{ _id: USER, email: "a@example.com" }]);
  db.seed("projects", [
    { _id: PROJECT, userId: USER, name: "demo", rtos: "zephyr", status: "unverified" },
  ]);
  db.seed("projectFiles", [
    { projectId: PROJECT, path: "CMakeLists.txt", content: "project(demo)\n", type: "cmake", version: 1, status: "current" },
    { projectId: PROJECT, path: "prj.conf", content: "CONFIG_MAIN_STACK_SIZE=2048\n", type: "conf", version: 1, status: "current" },
    { projectId: PROJECT, path: "src/main.c", content: MAIN_C, type: "c", version: 1, status: "current" },
  ]);
  db.seed("knowledgeBase", [
    {
      rtos: "zephyr",
      category: "pattern",
      title: "Zephyr GPIO interrupt pattern",
      content: "k_work_submit from the ISR and defer blocking work to a workqueue.",
      tags: ["zephyr", "gpio", "isr", "workqueue"],
    },
    {
      rtos: "freertos",
      category: "pattern",
      title: "FreeRTOS static task pattern",
      content: "xTaskCreateStatic with a StaticTask_t buffer.",
      tags: ["freertos", "task"],
    },
  ]);
  return db;
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
    url: `http://127.0.0.1:${server.port}`,
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
    url: `http://127.0.0.1:${server.port}`,
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
    patches: [],
    requestBuild: true,
  });

beforeEach(() => {
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.BUILD_RUNNER_URL;
  delete process.env.BUILD_RUNNER_TOKEN;
  process.env.LLM_MAX_RETRIES = "0";
  process.env.LLM_TIMEOUT_MS = "5000";
});

afterEach(() => {
  delete process.env.LLM_MAX_RETRIES;
  delete process.env.LLM_TIMEOUT_MS;
  delete process.env.LLM_BASE_URL;
  delete process.env.BUILD_RUNNER_URL;
});

describe("P0.3 — LLM failure never fabricates code", () => {
  test("provider unreachable: explicit error, no file change, no build", async () => {
    const db = seedProject();
    process.env.LLM_BASE_URL = "http://127.0.0.1:1"; // nothing listens here

    const before = db.all("projectFiles");
    const result = await handlerOf(agent.runCycle)(
      makeCtx(db, USER, REGISTRY),
      { projectId: PROJECT, userMessage: "add an LED driver" },
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("LLM_UNREACHABLE");

    expect(db.all("projectFiles")).toEqual(before);
    expect(db.all("fileVersions").length).toBe(0);
    expect(db.all("runs").filter((run) => run.type === "build").length).toBe(0);

    const project = db.all("projects")[0]!;
    expect(project.status).toBe("unverified");

    const assistantMessages = db
      .all("messages")
      .filter((message) => message.role === "assistant");
    const assistant = assistantMessages[assistantMessages.length - 1];
    expect(String(assistant?.content)).toContain("no files were created or modified");
    expect(String(assistant?.content)).toContain("LLM_UNREACHABLE");
  });

  test("unusable model answer: no file change either", async () => {
    const db = seedProject();
    const llm = startLlm(() => "I am sorry, I cannot produce JSON today.");
    process.env.LLM_BASE_URL = llm.url;

    try {
      const before = db.all("projectFiles");
      const result = await handlerOf(agent.runCycle)(
        makeCtx(db, USER, REGISTRY),
        { projectId: PROJECT, userMessage: "add an LED driver" },
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe("LLM_BAD_RESPONSE");
      expect(db.all("projectFiles")).toEqual(before);
      expect(db.all("fileVersions").length).toBe(0);
    } finally {
      llm.stop();
    }
  });

  test("a patch that does not apply is rejected as PATCH_FAILED and nothing is written", async () => {
    const db = seedProject();
    const llm = startLlm(() =>
      JSON.stringify({
        summary: "edit main",
        creates: [],
        patches: [
          {
            path: "src/main.c",
            diff: [
              "--- a/src/main.c",
              "+++ b/src/main.c",
              "@@ -1,3 +1,3 @@",
              " int totally_different(void) {",
              "+    init();",
              " }",
            ].join("\n"),
          },
        ],
        requestBuild: true,
      }),
    );
    process.env.LLM_BASE_URL = llm.url;

    try {
      const before = db.all("projectFiles");
      const result = await handlerOf(agent.runCycle)(
        makeCtx(db, USER, REGISTRY),
        { projectId: PROJECT, userMessage: "change main" },
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe("PATCH_FAILED");
      expect(db.all("projectFiles")).toEqual(before);
      expect(db.all("fileVersions").length).toBe(0);
    } finally {
      llm.stop();
    }
  });
});

describe("P0.2 / P1.3 — real build evidence and repair loop", () => {
  test("no runner configured: files change, build is NOT_AVAILABLE, project is never verified", async () => {
    const db = seedProject();
    const llm = startLlm(() => createPlan("src/led.c"));
    process.env.LLM_BASE_URL = llm.url;

    try {
      const result = await handlerOf(agent.runCycle)(
        makeCtx(db, USER, REGISTRY),
        { projectId: PROJECT, userMessage: "add an LED driver" },
      );

      expect(result.ok).toBe(true);
      expect(result.status).toBe("BUILD_NOT_AVAILABLE");

      expect(db.all("projectFiles").some((file) => file.path === "src/led.c")).toBe(true);

      const buildRun = db.all("runs").find((run) => run.type === "build");
      expect(buildRun?.verification).toBe("NOT_AVAILABLE");
      expect(buildRun?.verdict).toBe("UNKNOWN");
      expect(String(buildRun?.reason)).toContain("RUNNER_NOT_CONFIGURED");

      expect(db.all("projects")[0]!.status).toBe("unverified");
      expect(db.all("projects")[0]!.status).not.toBe("ready");
    } finally {
      llm.stop();
    }
  });

  test("real runner success verifies the project and records the evidence", async () => {
    const db = seedProject();
    const llm = startLlm(() => createPlan("src/led.c"));
    const runner = startRunner(() => realSuccess());
    process.env.LLM_BASE_URL = llm.url;
    process.env.BUILD_RUNNER_URL = runner.url;

    try {
      const result = await handlerOf(agent.runCycle)(
        makeCtx(db, USER, REGISTRY),
        { projectId: PROJECT, userMessage: "add an LED driver" },
      );

      expect(result.ok).toBe(true);
      expect(result.status).toBe("SUCCESS");

      const buildRun = db.all("runs").find((run) => run.type === "build");
      expect(buildRun?.verification).toBe("REAL");
      expect(buildRun?.verdict).toBe("SUCCESS");
      expect(buildRun?.exitCode).toBe(0);
      expect(buildRun?.command).toBe("west build -b nucleo_l476rg -d build -p auto");
      expect(buildRun?.artifacts).toEqual(["build/zephyr/zephyr.elf"]);

      expect(db.all("projects")[0]!.status).toBe("verified");

      const version = db.all("fileVersions").find((row) => row.path === "src/led.c");
      expect(version?.author).toBe("agent");
      expect(version?.buildVerdict).toBe("SUCCESS");

      // knowledge retrieval is real and logged as evidence
      const retrievalRun = db.all("runs").find((run) => run.type === "retrieval");
      expect(retrievalRun).toBeDefined();
      expect(String(retrievalRun?.stdout)).toContain("[kb]");
      expect(runner.attempts).toEqual([1]);
    } finally {
      llm.stop();
      runner.stop();
    }
  });

  test("a runner claiming SUCCESS without a real process does not verify anything", async () => {
    const db = seedProject();
    const llm = startLlm((call) => createPlan(`src/led_${call}.c`));
    const runner = startRunner(() =>
      realSuccess({ verification: "SIMULATED", verdict: "SUCCESS", exitCode: null }),
    );
    process.env.LLM_BASE_URL = llm.url;
    process.env.BUILD_RUNNER_URL = runner.url;

    try {
      const result = await handlerOf(agent.runCycle)(
        makeCtx(db, USER, REGISTRY),
        { projectId: PROJECT, userMessage: "add an LED driver" },
      );

      // The claim is downgraded to UNKNOWN, so it never counts as a success:
      // the loop retries as if the build had failed.
      const buildRuns = db.all("runs").filter((run) => run.type === "build");
      expect(buildRuns.length).toBeGreaterThan(0);
      expect(buildRuns.every((run) => run.verdict === "UNKNOWN")).toBe(true);
      expect(String(buildRuns[0]!.reason)).toContain("claimed SUCCESS without a real successful process");
      expect(db.all("projects")[0]!.status).toBe("unverified");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("REPAIR_LIMIT_REACHED");
    } finally {
      llm.stop();
      runner.stop();
    }
  });

  test("repair loop: real compiler error is fed back and the rebuild succeeds", async () => {
    const db = seedProject();
    const llm = startLlm((call) => createPlan(`src/attempt_${call}.c`));
    const runner = startRunner((attempt) => (attempt === 1 ? realFailure : realSuccess()));
    process.env.LLM_BASE_URL = llm.url;
    process.env.BUILD_RUNNER_URL = runner.url;

    try {
      const result = await handlerOf(agent.runCycle)(
        makeCtx(db, USER, REGISTRY),
        { projectId: PROJECT, userMessage: "add an init step" },
      );

      expect(result.ok).toBe(true);
      expect(result.status).toBe("SUCCESS");
      expect(result.attempts).toBe(2);
      expect(llm.calls()).toBe(2);

      const buildRuns = db.all("runs").filter((run) => run.type === "build");
      expect(buildRuns).toHaveLength(2);
      expect(buildRuns.some((run) => run.verdict === "FAILURE")).toBe(true);
      expect(buildRuns.some((run) => run.verdict === "SUCCESS")).toBe(true);
    } finally {
      llm.stop();
      runner.stop();
    }
  });

  test("repair limit: stops after 3 attempts with BUILD FAILED / REPAIR LIMIT REACHED", async () => {
    const db = seedProject();
    const llm = startLlm((call) => createPlan(`src/attempt_${call}.c`));
    const runner = startRunner(() => realFailure);
    process.env.LLM_BASE_URL = llm.url;
    process.env.BUILD_RUNNER_URL = runner.url;

    try {
      const result = await handlerOf(agent.runCycle)(
        makeCtx(db, USER, REGISTRY),
        { projectId: PROJECT, userMessage: "add an init step" },
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe("REPAIR_LIMIT_REACHED");
      expect(result.attempts).toBe(3);
      expect(llm.calls()).toBe(3);
      expect(String(result.message)).toContain("BUILD FAILED — REPAIR LIMIT REACHED");
      expect(db.all("projects")[0]!.status).toBe("failed");

      // The compiler output reached the model on the repair attempts.
      const buildRuns = db.all("runs").filter((run) => run.type === "build");
      expect(buildRuns).toHaveLength(3);
      expect(String(buildRuns[0]!.stderr)).toContain("implicit declaration");
    } finally {
      llm.stop();
      runner.stop();
    }
  });

  test("standing rebuild action reports NOT_AVAILABLE instead of faking a build", async () => {
    const db = seedProject();
    const result = await handlerOf(agent.runBuild)(makeCtx(db, USER, REGISTRY), {
      projectId: PROJECT,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("RUNNER_NOT_CONFIGURED");
    expect(result.build.verification).toBe("NOT_AVAILABLE");
    expect(db.all("runs")[0]?.verification).toBe("NOT_AVAILABLE");
    expect(db.all("projects")[0]!.status).toBe("unverified");
  });
});
