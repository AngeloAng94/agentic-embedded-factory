import { afterEach, describe, expect, test } from "bun:test";
import { runAgentTurn } from "../../runner/lib/turn";

const MAIN_C = ["int main(void) {", "    return 0;", "}", ""].join("\n");

const baseFiles = [
  { path: "CMakeLists.txt", content: "project(demo)\n" },
  { path: "prj.conf", content: "CONFIG_MAIN_STACK_SIZE=2048\n" },
  { path: "src/main.c", content: MAIN_C },
];

function startLlm(answerFor: (call: number) => string) {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      calls += 1;
      return Response.json({ response: answerFor(calls) });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls: () => calls, stop: () => server.stop(true) };
}

afterEach(() => {
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MAX_RETRIES;
  delete process.env.LLM_TIMEOUT_MS;
});

const env = () => ({ ...process.env, LLM_MAX_RETRIES: "0", LLM_TIMEOUT_MS: "5000" });

describe("shared local agent turn (runner + desktop)", () => {
  test("an unreachable provider returns an explicit error and produces no write", async () => {
    const outcome = await runAgentTurn({
      projectName: "demo",
      rtos: "zephyr",
      userMessage: "add an LED driver",
      files: baseFiles,
      env: { ...env(), LLM_BASE_URL: "http://127.0.0.1:1" },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("LLM_UNREACHABLE");
      expect(outcome.message).toContain("no files were created or modified");
    }
  });

  test("validated patches are returned with the diff, invalid ones never apply", async () => {
    const llm = startLlm(() =>
      JSON.stringify({
        summary: "wire up init",
        creates: [{ path: "src/led.c", content: "void led_init(void) {}\n" }],
        patches: [
          {
            path: "src/main.c",
            diff: [
              "--- a/src/main.c",
              "+++ b/src/main.c",
              "@@ -1,3 +1,4 @@",
              " int main(void) {",
              "+    led_init();",
              "     return 0;",
              " }",
            ].join("\n"),
          },
        ],
        requestBuild: true,
      }),
    );

    try {
      const outcome = await runAgentTurn({
        projectName: "demo",
        rtos: "zephyr",
        userMessage: "add an LED driver",
        files: baseFiles,
        knowledge: [
          {
            _id: "kb:1",
            rtos: "zephyr",
            category: "pattern",
            title: "Zephyr GPIO pattern",
            content: "use device_is_ready before using a device",
            tags: ["zephyr", "gpio"],
          },
        ],
        env: { ...env(), LLM_BASE_URL: llm.url },
      });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.writes).toHaveLength(2);
        const patch = outcome.writes.find((write) => write.kind === "patch");
        expect(patch?.path).toBe("src/main.c");
        expect(patch?.content).toContain("led_init();");
        expect(patch?.previousContent).toBe(MAIN_C);
        expect(patch?.patch).toContain("@@");
        expect(outcome.status).toBe("CHANGES_APPLIED");
        expect(outcome.requestBuild).toBe(true);
        expect(outcome.knowledgeLog).toContain("[kb]");
        expect(outcome.safety.engine).toBe("lexical-structural");
      }
    } finally {
      llm.stop();
    }
  });

  test("a patch with wrong context is PATCH_FAILED and nothing is written", async () => {
    const llm = startLlm(() =>
      JSON.stringify({
        summary: "broken",
        creates: [],
        patches: [
          {
            path: "src/main.c",
            diff: [
              "--- a/src/main.c",
              "+++ b/src/main.c",
              "@@ -1,3 +1,3 @@",
              " int nope(void) {",
              "+    led_init();",
              " }",
            ].join("\n"),
          },
        ],
        requestBuild: true,
      }),
    );

    try {
      const outcome = await runAgentTurn({
        projectName: "demo",
        rtos: "zephyr",
        userMessage: "change main",
        files: baseFiles,
        env: { ...env(), LLM_BASE_URL: llm.url },
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("PATCH_FAILED");
        expect(outcome.detail?.[0]?.code).toBe("PATCH_FAILED");
        expect(outcome.message).toContain("nothing was written");
      }
    } finally {
      llm.stop();
    }
  });

  test("whole-file rewrites of existing files are refused", async () => {
    const llm = startLlm(() =>
      JSON.stringify({
        summary: "rewrite main",
        creates: [{ path: "src/main.c", content: "int main(void) { return 1; }\n" }],
        patches: [],
        requestBuild: false,
      }),
    );

    try {
      const outcome = await runAgentTurn({
        projectName: "demo",
        rtos: "zephyr",
        userMessage: "rewrite main.c",
        files: baseFiles,
        env: { ...env(), LLM_BASE_URL: llm.url },
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("PATCH_FAILED");
        expect(outcome.detail?.[0]?.code).toBe("CREATE_OVER_EXISTING");
      }
    } finally {
      llm.stop();
    }
  });

  test("files outside the sandbox are rejected", async () => {
    const llm = startLlm(() =>
      JSON.stringify({
        summary: "escape",
        creates: [{ path: "../evil.c", content: "int x;\n" }],
        patches: [],
        requestBuild: false,
      }),
    );

    try {
      const outcome = await runAgentTurn({
        projectName: "demo",
        rtos: "zephyr",
        userMessage: "write outside",
        files: baseFiles,
        env: { ...env(), LLM_BASE_URL: llm.url },
      });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.writes).toHaveLength(0);
        expect(outcome.rejected[0]?.path).toBe("../evil.c");
      }
    } finally {
      llm.stop();
    }
  });
});
