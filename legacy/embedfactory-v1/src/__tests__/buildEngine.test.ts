import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectArtifacts,
  gitInitCommit,
  resolveExecutable,
  runProjectBuild,
} from "../lib/core/buildEngine";
import { buildProjectArchive } from "../lib/core/projectExport";
import { callLlm, resolveLlmConfig } from "../lib/core/llmClient";

const COMPILER = resolveExecutable("cc") ? "cc" : resolveExecutable("gcc") ? "gcc" : null;
const PYTHON = resolveExecutable("python3");

const tempDirs: string[] = [];

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "embedfactory-test-"));
  tempDirs.push(dir);
  for (const [filePath, content] of Object.entries(files)) {
    const target = path.join(dir, filePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("real build engine", () => {
  test.skipIf(COMPILER === null)(
    "executes a real compiler and captures exit code, output, duration and artifacts",
    async () => {
      const dir = tempProject({
        "src/main.c": "int main(void) { return 0; }\n",
        "build/.gitkeep": "",
      });

      const result = await runProjectBuild({
        dir,
        rtos: "freertos",
        commandOverride: `${COMPILER} src/main.c -o build/firmware.elf`,
      });

      expect(result.verification).toBe("REAL");
      expect(result.verdict).toBe("SUCCESS");
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.command).toContain("firmware.elf");
      expect(result.artifacts).toContain("build/firmware.elf");
      expect(existsSync(path.join(dir, "build/firmware.elf"))).toBe(true);
      expect(result.toolchain).toContain(COMPILER!);
    },
  );

  test.skipIf(COMPILER === null)(
    "reports a real compiler failure with the real stderr",
    async () => {
      const dir = tempProject({
        "src/main.c": "int main(void) { return undefined_symbol; }\n",
      });

      const result = await runProjectBuild({
        dir,
        rtos: "freertos",
        commandOverride: `${COMPILER} src/main.c -o build/firmware.elf`,
      });

      expect(result.verification).toBe("REAL");
      expect(result.verdict).toBe("FAILURE");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toContain("error");
      expect(result.artifacts).toEqual([]);
    },
  );

  test("a missing toolchain is NOT_AVAILABLE, never a fabricated success", async () => {
    const dir = tempProject({ "src/main.c": "int main(void) { return 0; }\n" });

    const result = await runProjectBuild({
      dir,
      rtos: "zephyr",
      board: "nucleo_l476rg",
      commandOverride: "definitely-not-installed-tool build",
    });

    expect(result.verification).toBe("NOT_AVAILABLE");
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.exitCode).toBeNull();
    expect(result.reason).toContain("toolchain unavailable");
  });

  test("west is requested for Zephyr and reported as unavailable when missing", async () => {
    const dir = tempProject({ "src/main.c": "int main(void) { return 0; }\n" });
    const result = await runProjectBuild({ dir, rtos: "zephyr", board: "nucleo_l476rg" });

    if (resolveExecutable("west")) {
      expect(result.command).toContain("west build");
    } else {
      expect(result.verification).toBe("NOT_AVAILABLE");
      expect(result.command).toContain("west build");
      expect(result.reason).toContain("west");
    }
  });

  test("artifact collection only reports real files", async () => {
    const dir = tempProject({
      "build/zephyr/zephyr.elf": "not-really-elf",
      "build/notes.txt": "ignore me",
    });
    const artifacts = collectArtifacts(dir);
    expect(artifacts).toEqual(["build/zephyr/zephyr.elf"]);
  });
});

describe("runner CLI", () => {
  const runnerPath = path.resolve(import.meta.dir, "../../runner/index.ts");

  test.skipIf(COMPILER === null)("build --json returns the real result contract", () => {
    const dir = tempProject({
      "src/main.c": "int main(void) { return 0; }\n",
      "build/.gitkeep": "",
    });

    const proc = Bun.spawnSync({
      cmd: [
        process.execPath,
        runnerPath,
        "build",
        "--dir",
        dir,
        "--rtos",
        "freertos",
        "--command",
        `${COMPILER} src/main.c -o build/firmware.elf`,
        "--json",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = new TextDecoder().decode(proc.stdout);
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    expect(payload.verification).toBe("REAL");
    expect(payload.verdict).toBe("SUCCESS");
    expect(payload.exitCode).toBe(0);
    expect(proc.exitCode).toBe(0);
  });

  test.skipIf(COMPILER === null)("a failing build exits non-zero and reports FAILURE", () => {
    const dir = tempProject({ "src/main.c": "int main(void) { return nope; }\n" });

    const proc = Bun.spawnSync({
      cmd: [
        process.execPath,
        runnerPath,
        "build",
        "--dir",
        dir,
        "--command",
        `${COMPILER} src/main.c -o build/firmware.elf`,
        "--json",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const payload = JSON.parse(new TextDecoder().decode(proc.stdout)) as Record<string, unknown>;
    expect(payload.verdict).toBe("FAILURE");
    expect(String(payload.stderr)).toContain("error");
    expect(proc.exitCode).not.toBe(0);
  });

  test("a missing toolchain is reported as NOT_AVAILABLE by the CLI", () => {
    const dir = tempProject({ "src/main.c": "int main(void) { return 0; }\n" });
    const proc = Bun.spawnSync({
      cmd: [
        process.execPath,
        runnerPath,
        "build",
        "--dir",
        dir,
        "--command",
        "definitely-not-installed-tool build",
        "--json",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const payload = JSON.parse(new TextDecoder().decode(proc.stdout)) as Record<string, unknown>;
    expect(payload.verification).toBe("NOT_AVAILABLE");
    expect(payload.verdict).toBe("UNKNOWN");
    expect(proc.exitCode).not.toBe(0);
  });
});

describe("project export", () => {
  test("produces a real zip with manifest and generated documentation", async () => {
    const project = {
      name: "demo_project",
      rtos: "zephyr" as const,
      board: "nucleo_l476rg",
      mcu: "stm32l476",
      description: "blink an LED",
    };
    const files = [
      { path: "CMakeLists.txt", content: "project(demo_project)\n" },
      { path: "prj.conf", content: "CONFIG_MAIN_STACK_SIZE=2048\n" },
      { path: "src/main.c", content: "int main(void) { return 0; }\n" },
    ];

    const { bytes, manifest, entries } = buildProjectArchive(project, files, {
      verification: "REAL · SUCCESS",
    });

    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0x50); // "PK"
    expect(manifest.fileCount).toBe(3);
    expect(manifest.buildCommand).toContain("west build");
    expect(entries.map((entry) => entry.path)).toContain("embedfactory.manifest.json");
    expect(entries.map((entry) => entry.path)).toContain("BUILD.md");
    expect(entries.map((entry) => entry.path)).toContain(".gitignore");

    if (!PYTHON) return; // zip integrity is checked when python3 is available

    const zipPath = path.join(tempProject({}), "demo.zip");
    writeFileSync(zipPath, bytes);
    const script = [
      "import sys, zipfile, json",
      "z = zipfile.ZipFile(sys.argv[1])",
      "bad = z.testzip()",
      "data = json.loads(z.read('embedfactory.manifest.json').decode())",
      "print(json.dumps({'names': sorted(z.namelist()), 'bad': bad, 'rtos': data['rtos'], 'verification': data['verification']}))",
    ].join("\n");

    const proc = Bun.spawnSync({ cmd: [PYTHON, "-c", script, zipPath], stdout: "pipe" });
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
      names: string[];
      bad: string | null;
      rtos: string;
      verification: string;
    };

    expect(payload.bad).toBeNull();
    expect(payload.names).toContain("src/main.c");
    expect(payload.names).toContain("embedfactory.manifest.json");
    expect(payload.rtos).toBe("zephyr");
    expect(payload.verification).toBe("REAL · SUCCESS");
  });
});

describe("git integration", () => {
  test("reports a structured outcome and never throws", async () => {
    const dir = tempProject({ "src/main.c": "int main(void) { return 0; }\n" });
    const outcome = await gitInitCommit(dir, "test commit");

    if (outcome.ok) {
      expect(outcome.steps.map((step) => step.command)).toEqual([
        "git init",
        "git add -A",
        'git commit -m "test commit"',
      ]);
      expect(existsSync(path.join(dir, ".git"))).toBe(true);
    } else {
      expect(["TOOLCHAIN_NOT_AVAILABLE", "GIT_FAILED"]).toContain(outcome.code);
      expect(outcome.message.length).toBeGreaterThan(0);
    }
  });
});

describe("LLM client", () => {
  test("configuration comes from the environment and fails loudly when unusable", () => {
    expect(resolveLlmConfig({}).ok).toBe(true);

    const remoteWithoutKey = resolveLlmConfig({
      LLM_PROVIDER: "openai",
      LLM_BASE_URL: "https://api.example.com/v1",
    });
    expect(remoteWithoutKey.ok).toBe(false);
    if (!remoteWithoutKey.ok) expect(remoteWithoutKey.code).toBe("LLM_NOT_CONFIGURED");

    const remoteWithKey = resolveLlmConfig({
      LLM_PROVIDER: "openai",
      LLM_BASE_URL: "https://api.example.com/v1/",
      LLM_API_KEY: "secret",
      LLM_MODEL: "gpt-4o-mini",
    });
    expect(remoteWithKey.ok).toBe(true);
    if (remoteWithKey.ok) {
      expect(remoteWithKey.config.baseUrl).toBe("https://api.example.com/v1");
      expect(remoteWithKey.config.apiKey).toBe("secret");
    }

    const noUrl = resolveLlmConfig({ LLM_PROVIDER: "openai", LLM_BASE_URL: "" });
    expect(noUrl.ok).toBe(false);
  });

  test("calls an Ollama-compatible endpoint and returns the completion", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () =>
        Response.json({ response: JSON.stringify({ summary: "ok", creates: [], patches: [] }) }),
    });
    const config = resolveLlmConfig({
      LLM_PROVIDER: "ollama",
      LLM_BASE_URL: `http://127.0.0.1:${server.port}`,
      LLM_MODEL: "test-model",
    });

    try {
      expect(config.ok).toBe(true);
      if (!config.ok) return;
      const result = await callLlm(config.config, "prompt");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toContain("summary");
        expect(result.model).toBe("test-model");
        expect(result.attempts).toBe(1);
      }
    } finally {
      server.stop(true);
    }
  });

  test("retries a 5xx and reports HTTP errors with the attempt count", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        calls += 1;
        if (calls === 1) return new Response("boom", { status: 500 });
        return Response.json({ response: "{}" });
      },
    });

    const config = resolveLlmConfig({
      LLM_PROVIDER: "ollama",
      LLM_BASE_URL: `http://127.0.0.1:${server.port}`,
      LLM_MAX_RETRIES: "1",
    });
    const alwaysFailing = Bun.serve({
      port: 0,
      fetch: async () => new Response("nope", { status: 500 }),
    });

    try {
      if (!config.ok) throw new Error("config should be valid");
      const retried = await callLlm(config.config, "prompt");
      expect(retried.ok).toBe(true);
      expect(retried.attempts).toBe(2);

      const failingConfig = resolveLlmConfig({
        LLM_PROVIDER: "ollama",
        LLM_BASE_URL: `http://127.0.0.1:${alwaysFailing.port}`,
        LLM_MAX_RETRIES: "1",
      });
      if (!failingConfig.ok) throw new Error("config should be valid");
      const failed = await callLlm(failingConfig.config, "prompt");
      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        expect(failed.code).toBe("LLM_HTTP_ERROR");
        expect(failed.attempts).toBe(2);
      }
    } finally {
      server.stop(true);
      alwaysFailing.stop(true);
    }
  });

  test("an unreachable provider produces LLM_UNREACHABLE and no text", async () => {
    const config = resolveLlmConfig({
      LLM_PROVIDER: "ollama",
      LLM_BASE_URL: "http://127.0.0.1:1",
      LLM_MAX_RETRIES: "0",
      LLM_TIMEOUT_MS: "2000",
    });
    if (!config.ok) throw new Error("config should be valid");

    const result = await callLlm(config.config, "prompt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("LLM_UNREACHABLE");
  });
});

describe("templates", () => {
  test("generated projects are explained as unverified until built", async () => {
    const { makeSkeleton } = await import("../convex/templates");
    const files = makeSkeleton("zephyr", "demo");
    const readme = files.find((file) => file.path === "README.md");
    expect(readme?.content).toContain("not built yet");
    expect(files.map((file) => file.path)).toContain("prj.conf");
  });
});

describe("repository hygiene", () => {
  test("no simulated build engine remains in the Convex functions", () => {
    const files = [
      "src/convex/agent.ts",
      "src/convex/orchestrator.ts",
      "src/convex/runs.ts",
      "src/convex/projects.ts",
    ];
    for (const file of files) {
      const content = readFileSync(path.resolve(import.meta.dir, "../..", file), "utf8");
      expect(content).not.toContain("runBuildSimulationImpl");
      expect(content).not.toContain("Build succeeded.");
      expect(content).not.toContain("All tests passed.");
    }
    expect(existsSync(path.resolve(import.meta.dir, "../convex/buildSimulation.ts"))).toBe(false);
  });
});
