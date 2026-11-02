import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeAgentSdkRuntime,
  FakeModelRuntime,
  LlmClientRuntime,
  createModelRuntime,
  createModelRuntimeFromProfile,
  type ClaudeAgentSdkQuery,
} from "../agent/modelRuntime";
import { runAgentTurn } from "../agent/turn";
import { loadProfile } from "../core/profile";

const PROFILE = [
  "prodotto: RUNTIME-TEST",
  "chip:",
  "  famiglia: stm32",
  "  regioni:",
  "    - { nome: FLASH, tipo: flash, origine: 0x08000000, dimensione: 65536 }",
  "    - { nome: RAM, tipo: ram, origine: 0x20000000, dimensione: 16384 }",
  'build: { sistema: cmake, toolchain: arm-none-eabi-gcc, comando: "cmake --build build" }',
  "flash: { tool: STM32_Programmer_CLI, interfaccia: swd }",
  "debug: { gdb_server: st, access_port: 0 }",
  "llm: { provider: fake, model: fake-model }",
  "ancore: [APP]",
  "criteri: []",
  "tentativi_max: 1",
  "",
].join("\n");

const PLAN = JSON.stringify({
  summary: "create a driver",
  creates: [{ path: "src/led.c", content: "void led_init(void) {}\n" }],
  edits: [],
  requestBuild: false,
});

const files = [
  { path: "CMakeLists.txt", content: "project(demo)\n" },
  { path: "src/main.c", content: "int main(void) { return 0; }\n" },
];

function fakeProfile() {
  const result = loadProfile(PROFILE);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.profile;
}

describe("ModelRuntime", () => {
  test("the fake runtime is explicitly marked and drives the normal validated turn", async () => {
    const fake = new FakeModelRuntime([PLAN]);
    expect(fake.fake).toBe(true);
    expect(fake.simulated).toBe(true);
    expect(fake.describe()).toContain("FAKE");

    const outcome = await runAgentTurn({
      projectName: "demo",
      rtos: "zephyr",
      userMessage: "add an LED driver",
      files,
      modelRuntime: fake,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.writes.map((write) => write.path)).toEqual(["src/led.c"]);
      expect(outcome.llm.provider).toBe("fake");
      expect(outcome.llm.fake).toBe(true);
      expect(outcome.llm.endpoint).toBeNull();
    }
    expect(fake.callCount).toBe(1);
  });

  test("the profile selects the provider; fake needs an explicit opt-in", () => {
    const profile = fakeProfile();

    const blocked = createModelRuntimeFromProfile(profile);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("MODEL_RUNTIME_FAKE_DISABLED");

    const selected = createModelRuntimeFromProfile(profile, {
      allowFake: true,
      fakeResponses: [PLAN],
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.runtime.provider).toBe("fake");
      expect(selected.runtime.fake).toBe(true);
    }

    const claude = createModelRuntime(
      { provider: "claude-agent-sdk", model: "claude-test" },
      { env: {} },
    );
    expect(claude.ok).toBe(true);
    if (claude.ok) expect(claude.runtime.provider).toBe("claude-agent-sdk");

    const llmClient = createModelRuntime(undefined);
    expect(llmClient.ok).toBe(true);
    if (llmClient.ok) expect(llmClient.runtime.provider).toBe("llmClient");
  });

  test("the LLM client runtime uses the existing Ollama/OpenAI client", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { prompt?: string; stream?: boolean };
        expect(body.stream).toBe(false);
        expect(String(body.prompt)).toContain("SYSTEM RULES");
        return Response.json({ response: PLAN });
      },
    });

    try {
      const runtime = new LlmClientRuntime({
        env: {
          LLM_PROVIDER: "ollama",
          LLM_BASE_URL: `http://127.0.0.1:${server.port}`,
          LLM_MAX_RETRIES: "0",
          LLM_TIMEOUT_MS: "5000",
        },
        model: "test-model",
      });
      const result = await runtime.generate({
        system: "SYSTEM RULES",
        prompt: "make a driver",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.provider).toBe("llmClient");
        expect(result.fake).toBe(false);
        expect(result.model).toBe("test-model");
        expect(result.text).toContain("create a driver");
      }
    } finally {
      server.stop(true);
    }
  });

  test("Claude Agent SDK without a key fails explicitly, without spawning a process", async () => {
    const runtime = new ClaudeAgentSdkRuntime({ env: { ANTHROPIC_API_KEY: "" } });
    const result = await runtime.generate({ system: "system", prompt: "prompt" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("LLM_NOT_CONFIGURED");
      expect(result.message).toContain("ANTHROPIC_API_KEY");
      expect(result.fake).toBe(false);
      expect(result.attempts).toBe(0);
    }
  });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  test.skipIf(!anthropicKey)("Claude Agent SDK parses the final result when a key is available", async () => {
    const queryImpl: ClaudeAgentSdkQuery = () =>
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: PLAN,
        } as unknown as SDKMessage;
      })();

    const runtime = new ClaudeAgentSdkRuntime({
      env: { ANTHROPIC_API_KEY: anthropicKey },
      model: "claude-test",
      queryImpl,
    });
    const result = await runtime.generate({ system: "system", prompt: "prompt" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe("claude-agent-sdk");
      expect(result.fake).toBe(false);
      expect(result.text).toBe(PLAN);
      expect(result.endpoint).toBeNull();
    }
  });
});
