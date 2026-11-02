import { afterEach, describe, expect, test } from "bun:test";
import { runAgentTurn } from "../agent/turn";

const MAIN_C = [
  "#include <stdint.h>",
  "",
  "// [AI_START_APP]",
  "int main(void) {",
  "    return 0;",
  "}",
  "// [AI_END_APP]",
  "",
].join("\n");

const APP_BODY = ["int main(void) {", "    led_init();", "    return 0;", "}"].join("\n");

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
  // Loopback only: no network, no Ollama installation required.
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

  test("block edits are applied inside the markers and the diff is returned", async () => {
    const llm = startLlm(() =>
      JSON.stringify({
        summary: "wire up init",
        creates: [{ path: "src/led.c", content: "void led_init(void) {}\n" }],
        edits: [{ path: "src/main.c", block: "APP", content: APP_BODY }],
        requestBuild: true,
      }),
    );

    try {
      const outcome = await runAgentTurn({
        projectName: "demo",
        rtos: "zephyr",
        userMessage: "add an LED driver",
        files: baseFiles,
        anchors: ["APP"],
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
        const edit = outcome.writes.find((write) => write.kind === "block-edit");
        expect(edit?.path).toBe("src/main.c");
        expect(edit?.block).toBe("APP");
        expect(edit?.content).toContain("led_init();");
        expect(edit?.previousContent).toBe(MAIN_C);
        expect(edit?.patch).toContain("@@");

        // Bytes outside the markers are untouched, markers included.
        expect(edit?.content.startsWith("#include <stdint.h>\n\n// [AI_START_APP]\n")).toBe(true);
        expect(edit?.content.endsWith("// [AI_END_APP]\n")).toBe(true);

        expect(outcome.status).toBe("CHANGES_APPLIED");
        expect(outcome.requestBuild).toBe(true);
        expect(outcome.knowledgeLog).toContain("[kb]");
        expect(outcome.safety.engine).toBe("lexical-structural");
      }
    } finally {
      llm.stop();
    }
  });

  test("an edit to an undeclared block is PATCH_FAILED and nothing is written", async () => {
    const llm = startLlm(() =>
      JSON.stringify({
        summary: "broken",
        creates: [],
        edits: [{ path: "src/main.c", block: "NOPE", content: "void other(void) {}" }],
        requestBuild: true,
      }),
    );

    try {
      const outcome = await runAgentTurn({
        projectName: "demo",
        rtos: "zephyr",
        userMessage: "change main",
        files: baseFiles,
        anchors: ["APP"],
        env: { ...env(), LLM_BASE_URL: llm.url },
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("PATCH_FAILED");
        expect(outcome.detail?.[0]?.code).toBe("BLOCK_NOT_DECLARED");
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
        edits: [],
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
        edits: [],
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
