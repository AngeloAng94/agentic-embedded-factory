import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REFERENCE_BOARD,
  ENV_VAR_DOCS,
  boardStateFor,
  buildStateFor,
  capabilityLabel,
  capabilityTone,
  connectionLabel,
  connectionTone,
  environmentStatus,
  envVarsFor,
  formatDoctorReport,
  freertosStatus,
  maskSecret,
  onboardingSteps,
  parseDoctorReport,
  resolveLlmStatus,
  resolveRunnerStatus,
  runnerLabel,
  runnerTone,
  secretLabel,
  toolchainStateFor,
  zephyrStatusFromDoctor,
  zephyrStatusUnavailable,
  type DoctorReport,
  type LlmStatus,
  type RunnerStatus,
} from "../core/environmentStatus";

/* --------------------------------------------------------------- helpers -- */

function doctorReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  const base: DoctorReport = {
    environment: "READY",
    ready: true,
    board: DEFAULT_REFERENCE_BOARD,
    checks: [
      { id: "west", label: "west", status: "PASS", required: true, detail: "West version: v1.2.0" },
      { id: "cmake", label: "cmake", status: "PASS", required: true, detail: "cmake version 3.28.3" },
      { id: "dtc", label: "dtc", status: "PASS", required: true, detail: "devicetree compiler found" },
      {
        id: "zephyr_sdk",
        label: "Zephyr SDK",
        status: "PASS",
        required: true,
        detail: "/opt/zephyr-sdk-0.16.5 (0.16.5)",
      },
      {
        id: "arm_toolchain",
        label: "arm-zephyr-eabi",
        status: "PASS",
        required: true,
        detail: "arm-zephyr-eabi-gcc 12.2.0",
      },
      {
        id: "board",
        label: "board",
        status: "PASS",
        required: true,
        detail: `"${DEFAULT_REFERENCE_BOARD}" recognised by west (312 boards)`,
      },
    ],
    missing: [],
    zephyrBase: "/home/me/zephyrproject/zephyr",
    zephyrSdk: "/opt/zephyr-sdk-0.16.5",
    zephyrSdkVersion: "0.16.5",
    boardsSupported: [DEFAULT_REFERENCE_BOARD, "native_sim", "qemu_cortex_m3"],
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
  return { ...base, ...overrides };
}

const CONNECTED_LLM: Partial<LlmStatus> = {
  provider: "ollama",
  baseUrl: "http://localhost:11434",
  model: "llama3",
  state: "CONNECTED",
  message: "ollama · llama3 answered in 42 ms",
  latencyMs: 42,
  checkedAt: 1_700_000_000_000,
};

/** The runner URL must be present in the environment for any stored probe to apply. */
const RUNNER_ENV = { BUILD_RUNNER_URL: "http://127.0.0.1:8790" };

const CONNECTED_RUNNER: Partial<RunnerStatus> = {
  url: "http://127.0.0.1:8790",
  tokenConfigured: false,
  state: "CONNECTED",
  message: null,
  latencyMs: 8,
  tools: { west: true, cmake: true },
  zephyrBase: "/home/me/zephyrproject/zephyr",
  checkedAt: 1_700_000_000_000,
};

/** The same runner, resolved against an environment that really declares its URL. */
const RUNNER_ENV_RESOLVED = resolveRunnerStatus(RUNNER_ENV, CONNECTED_RUNNER);

/* ------------------------------------------------------------------- AI --- */

describe("environment status — AI", () => {
  test("built-in defaults are never presented as a configuration", () => {
    const status = resolveLlmStatus({});
    // The client has ollama defaults, so it *is* usable in principle …
    expect(status.configured).toBe(true);
    // … but nothing was configured, and nothing was verified.
    expect(status.explicit).toBe(false);
    expect(status.state).toBe("UNKNOWN");
    expect(status.message).toContain("Not tested yet");
    expect(status.apiKeyConfigured).toBe(false);
  });

  test("openai without a key is NOT_CONFIGURED and names the variable", () => {
    const status = resolveLlmStatus({
      LLM_PROVIDER: "openai",
      LLM_BASE_URL: "https://api.example.com/v1",
    });
    expect(status.configured).toBe(false);
    expect(status.explicit).toBe(true);
    expect(status.state).toBe("NOT_CONFIGURED");
    expect(status.message).toContain("LLM_API_KEY");
  });

  test("a configured provider stays UNKNOWN until a real probe ran", () => {
    const status = resolveLlmStatus({ LLM_PROVIDER: "ollama", LLM_MODEL: "llama3" });
    expect(status.configured).toBe(true);
    expect(status.explicit).toBe(true);
    expect(status.state).toBe("UNKNOWN");
    expect(status.checkedAt).toBeNull();
  });

  test("a stored CONNECTED is reused while the configuration is unchanged", () => {
    const status = resolveLlmStatus({}, CONNECTED_LLM);
    expect(status.state).toBe("CONNECTED");
    expect(status.latencyMs).toBe(42);
    expect(status.checkedAt).toBe(1_700_000_000_000);
    expect(connectionTone(status.state)).toBe("ok");
  });

  test("a stored CONNECTED is void as soon as the model changes", () => {
    const status = resolveLlmStatus({ LLM_MODEL: "mistral" }, CONNECTED_LLM);
    expect(status.state).toBe("UNKNOWN");
    expect(status.checkedAt).toBeNull();
    expect(status.latencyMs).toBeNull();
    expect(status.message).toContain("Not tested yet");
  });

  test("the API key never appears in the resolved status", () => {
    const secret = "sk-live-do-not-leak";
    const status = resolveLlmStatus({
      LLM_PROVIDER: "openai",
      LLM_BASE_URL: "https://api.example.com/v1",
      LLM_API_KEY: secret,
    });
    expect(status.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(secret);
  });
});

/* -------------------------------------------------------------- secrets --- */

describe("environment status — secret handling", () => {
  test("a secret is only ever Configured / Not configured", () => {
    expect(secretLabel(true)).toBe("Configured");
    expect(secretLabel(false)).toBe("Not configured");
  });

  test("maskSecret never returns the original value", () => {
    const value = "sk-live-abcdef123456";
    const masked = maskSecret(value);
    expect(masked).not.toBe(value);
    expect(masked).not.toContain("abcdef");
    expect(masked).toContain("••••");
    expect(maskSecret("short")).toBe("••••");
    expect(maskSecret(null)).toBe("");
  });

  test("the documented catalogue covers every variable the product reads", () => {
    const names = ENV_VAR_DOCS.map((entry) => entry.name);
    for (const expected of [
      "LLM_PROVIDER",
      "LLM_BASE_URL",
      "LLM_API_KEY",
      "LLM_MODEL",
      "LLM_TIMEOUT_MS",
      "LLM_MAX_RETRIES",
      "LLM_TEMPERATURE",
      "BUILD_RUNNER_URL",
      "BUILD_RUNNER_TOKEN",
    ]) {
      expect(names).toContain(expected);
    }
    expect(ENV_VAR_DOCS.filter((entry) => entry.secret).map((entry) => entry.name).sort()).toEqual([
      "BUILD_RUNNER_TOKEN",
      "LLM_API_KEY",
    ]);
    expect(envVarsFor("ai").length).toBe(7);
    expect(envVarsFor("runner").length).toBe(2);
  });
});

/* --------------------------------------------------------------- runner --- */

describe("environment status — build runner", () => {
  test("no runner URL is NOT_CONFIGURED, never a success", () => {
    const status = resolveRunnerStatus({});
    expect(status.configured).toBe(false);
    expect(status.url).toBeNull();
    expect(status.state).toBe("NOT_CONFIGURED");
    expect(status.checkedAt).toBeNull();
    expect(capabilityTone("NOT_CONFIGURED")).toBe("idle");
  });

  test("a stored CONNECTED is reused for the same runner", () => {
    const status = resolveRunnerStatus(
      { BUILD_RUNNER_URL: "http://127.0.0.1:8790" },
      CONNECTED_RUNNER,
    );
    expect(status.state).toBe("CONNECTED");
    expect(status.tools?.west).toBe(true);
    expect(runnerLabel(status.state)).toBe("CONNECTED");
  });

  test("stored evidence is dropped when the token appears", () => {
    const status = resolveRunnerStatus(
      { BUILD_RUNNER_URL: "http://127.0.0.1:8790", BUILD_RUNNER_TOKEN: "s3cret" },
      CONNECTED_RUNNER,
    );
    expect(status.tokenConfigured).toBe(true);
    expect(status.state).toBe("UNKNOWN");
    expect(status.checkedAt).toBeNull();
  });

  test("stored evidence is dropped when the URL changes", () => {
    const status = resolveRunnerStatus(
      { BUILD_RUNNER_URL: "http://10.0.0.5:8790" },
      CONNECTED_RUNNER,
    );
    expect(status.state).toBe("UNKNOWN");
  });

  test("an authentication failure stays visible and blocks the build", () => {
    const status = resolveRunnerStatus(
      { BUILD_RUNNER_URL: "http://127.0.0.1:8790" },
      { ...CONNECTED_RUNNER, state: "AUTHENTICATION_FAILED", message: "runner rejected the token" },
    );
    expect(status.state).toBe("AUTHENTICATION_FAILED");
    expect(runnerTone(status.state)).toBe("error");
    const build = buildStateFor(status, zephyrStatusFromDoctor(doctorReport()));
    expect(build.state).toBe("NOT_AVAILABLE");
    expect(build.message).toContain("BUILD_RUNNER_TOKEN");
  });

  test("the runner token never appears in the resolved status", () => {
    const token = "runner-token-do-not-leak";
    const status = resolveRunnerStatus(
      { BUILD_RUNNER_URL: "http://127.0.0.1:8790", BUILD_RUNNER_TOKEN: token },
      CONNECTED_RUNNER,
    );
    expect(status.tokenConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(token);
  });
});

/* --------------------------------------------------------------- zephyr --- */

describe("environment status — Zephyr", () => {
  test("a READY doctor report produces READY evidence", () => {
    const zephyr = zephyrStatusFromDoctor(doctorReport());
    expect(zephyr.rtos).toBe("zephyr");
    expect(zephyr.state).toBe("READY");
    expect(zephyr.buildCapability).toBe("READY");
    expect(zephyr.diagnostics).toEqual([]);
    expect(zephyr.toolchain).toContain("0.16.5");
    expect(zephyr.toolchain).toContain("arm-zephyr-eabi");
    expect(zephyr.boardsSupported).toContain(DEFAULT_REFERENCE_BOARD);
    expect(capabilityTone(zephyr.state)).toBe("ok");
  });

  test("a NOT_READY doctor report keeps every missing check as evidence", () => {
    const report = doctorReport({
      ready: false,
      environment: "NOT_READY",
      missing: ["west", "ZEPHYR_BASE"],
      checks: [
        { id: "west", label: "west", status: "MISSING", required: true, detail: "not found in PATH" },
        {
          id: "zephyr_base",
          label: "ZEPHYR_BASE",
          status: "MISSING",
          required: true,
          detail: "ZEPHYR_BASE is not set",
        },
      ],
    });
    const zephyr = zephyrStatusFromDoctor(report);
    expect(zephyr.state).toBe("NOT_READY");
    expect(zephyr.buildCapability).toBe("NOT_READY");
    expect(zephyr.diagnostics).toEqual(["missing: west", "missing: ZEPHYR_BASE"]);
    expect(zephyr.message).toContain("NOT_READY");

    const build = buildStateFor(RUNNER_ENV_RESOLVED, zephyr);
    expect(build.state).toBe("NOT_READY");
  });

  test("a toolchain that could not be probed is UNKNOWN, not ready", () => {
    const zephyr = zephyrStatusUnavailable("no runner configured", DEFAULT_REFERENCE_BOARD);
    expect(zephyr.state).toBe("UNKNOWN");
    expect(zephyr.buildCapability).toBe("NOT_AVAILABLE");
    expect(zephyr.diagnostics).toEqual(["no runner configured"]);
    expect(zephyr.checks).toEqual([]);
  });

  test("FreeRTOS is NOT_CONFIGURED because no doctor exists for it", () => {
    const freertos = freertosStatus();
    expect(freertos.rtos).toBe("freertos");
    expect(freertos.state).toBe("NOT_CONFIGURED");
    expect(freertos.buildCapability).toBe("NOT_AVAILABLE");
    expect(freertos.diagnostics[0]).toContain("No FreeRTOS diagnostic is implemented yet");
    // Even with a healthy runner, FreeRTOS can never be READY today.
    const build = buildStateFor(resolveRunnerStatus({}, CONNECTED_RUNNER), freertos);
    expect(build.state).toBe("NOT_AVAILABLE");
  });

  test("the toolchain aggregate is only READY when Zephyr is READY", () => {
    expect(toolchainStateFor(resolveRunnerStatus({}), zephyrStatusFromDoctor(doctorReport()))).toBe(
      "READY",
    );
    expect(
      toolchainStateFor(
        resolveRunnerStatus({ BUILD_RUNNER_URL: "http://127.0.0.1:8790" }, CONNECTED_RUNNER),
        zephyrStatusUnavailable("not probed", DEFAULT_REFERENCE_BOARD),
      ),
    ).toBe("UNKNOWN");
    expect(
      toolchainStateFor(
        resolveRunnerStatus({}),
        zephyrStatusUnavailable("not probed", DEFAULT_REFERENCE_BOARD),
      ),
    ).toBe("NOT_CONFIGURED");
  });

  test("environmentStatus aggregates the four capabilities", () => {
    const status = environmentStatus({
      llm: resolveLlmStatus({}, CONNECTED_LLM),
      runner: resolveRunnerStatus({}, CONNECTED_RUNNER),
      zephyr: zephyrStatusFromDoctor(doctorReport()),
      checkedAt: 123,
    });
    expect(status.toolchain).toBe("READY");
    expect(status.freertos.state).toBe("NOT_CONFIGURED");
    expect(status.checkedAt).toBe(123);
  });
});

/* ---------------------------------------------------------------- board --- */

describe("environment status — board availability", () => {
  test("no board set is NOT_CONFIGURED", () => {
    const state = boardStateFor(null, zephyrStatusFromDoctor(doctorReport()));
    expect(state.state).toBe("NOT_CONFIGURED");
  });

  test("without a west board list the board stays UNKNOWN / NOT VERIFIED", () => {
    const zephyr = zephyrStatusFromDoctor(doctorReport({ boardsSupported: null }));
    const state = boardStateFor(DEFAULT_REFERENCE_BOARD, zephyr);
    expect(state.state).toBe("UNKNOWN");
    expect(state.message).toContain("UNKNOWN / NOT VERIFIED");
  });

  test("a board really listed by west is READY", () => {
    const state = boardStateFor("native_sim", zephyrStatusFromDoctor(doctorReport()));
    expect(state.state).toBe("READY");
  });

  test("a board that west did not list is NOT_READY", () => {
    const state = boardStateFor("made_up_board", zephyrStatusFromDoctor(doctorReport()));
    expect(state.state).toBe("NOT_READY");
    expect(state.message).toContain("made_up_board");
  });
});

/* ----------------------------------------------------------- onboarding --- */

describe("environment status — first run", () => {
  test("nothing configured results in a honest checklist", () => {
    const steps = onboardingSteps(
      environmentStatus({
        llm: resolveLlmStatus({}),
        runner: resolveRunnerStatus({}),
        zephyr: zephyrStatusUnavailable("no runner configured", DEFAULT_REFERENCE_BOARD),
      }),
    );

    expect(steps.map((step) => step.id)).toEqual(["ai", "runner", "zephyr", "freertos"]);
    // Never a READY without real evidence.
    expect(steps.every((step) => step.state !== "READY")).toBe(true);
    expect(steps[0]!.state).toBe("NOT_CONFIGURED");
    expect(steps[1]!.state).toBe("NOT_CONFIGURED");
    expect(steps[2]!.state).toBe("UNKNOWN");
    expect(steps[3]!.state).toBe("NOT_CONFIGURED");
    for (const step of steps) expect(step.detail.length).toBeGreaterThan(0);
  });

  test("everything really verified turns the checklist green", () => {
    const steps = onboardingSteps(
      environmentStatus({
        llm: resolveLlmStatus({}, CONNECTED_LLM),
        runner: RUNNER_ENV_RESOLVED,
        zephyr: zephyrStatusFromDoctor(doctorReport()),
      }),
    );
    expect(steps.find((step) => step.id === "ai")!.state).toBe("READY");
    expect(steps.find((step) => step.id === "runner")!.state).toBe("READY");
    expect(steps.find((step) => step.id === "zephyr")!.state).toBe("READY");
    expect(steps.find((step) => step.id === "freertos")!.state).toBe("NOT_CONFIGURED");
  });

  test("labels never contain underscores", () => {
    expect(capabilityLabel("NOT_AVAILABLE")).toBe("NOT AVAILABLE");
    expect(connectionLabel("CONNECTION_FAILED")).toBe("CONNECTION FAILED");
  });
});

/* ------------------------------------------------------- doctor reports --- */

describe("environment status — doctor payloads", () => {
  test("garbage is rejected instead of trusted", () => {
    expect(parseDoctorReport(null)).toBeNull();
    expect(parseDoctorReport("ready")).toBeNull();
    expect(parseDoctorReport({ ready: "yes", checks: [] })).toBeNull();
    expect(parseDoctorReport({ ready: true })).toBeNull();
  });

  test("a real payload is validated and normalized", () => {
    const parsed = parseDoctorReport({
      ready: false,
      board: DEFAULT_REFERENCE_BOARD,
      checks: [
        { id: "west", label: "west", status: "MISSING", required: true, detail: "not found" },
        { id: "junk" },
      ],
      missing: ["west", 42, null],
      boardsSupported: ["native_sim", 7],
      zephyrSdkVersion: "0.16.5",
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.environment).toBe("NOT_READY");
    expect(parsed!.checks.length).toBe(1);
    expect(parsed!.checks[0]!.id).toBe("west");
    expect(parsed!.missing).toEqual(["west"]);
    expect(parsed!.boardsSupported).toEqual(["native_sim"]);
    expect(parsed!.zephyrSdkVersion).toBe("0.16.5");
  });

  test("formatDoctorReport renders PASS/MISSING plus the environment lines", () => {
    const text = formatDoctorReport(doctorReport());
    expect(text).toContain("west");
    expect(text).toContain("PASS");
    expect(text).toContain("Environment");
    expect(text).toContain("READY");
    expect(text).toContain("Board");
  });
});

