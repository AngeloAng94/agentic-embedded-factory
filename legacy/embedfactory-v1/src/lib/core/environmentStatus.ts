/**
 * The single source of truth for EmbedFactory environment status.
 *
 * Everything the control plane shows — AI, build runner, Zephyr, FreeRTOS,
 * toolchain, board — is normalized here from the *existing* core:
 *
 *   llmClient.resolveLlmConfig        → LLM configuration (never the secret)
 *   buildDispatch.resolveRunnerConfig → build runner configuration
 *   toolchainDoctor.runDoctor         → real Zephyr/toolchain evidence
 *   buildStatus / types               → REAL · SIMULATED · NOT_AVAILABLE,
 *                                       SUCCESS · FAILURE · UNKNOWN
 *
 * Pure and browser-safe: no `node:*` import, no network. The web UI, the Convex
 * backend and the tests all consume these same helpers, so there is exactly one
 * taxonomy and one place where a state is derived.
 *
 * Rule: nothing here may report READY / CONNECTED without evidence. A state we
 * cannot prove is UNKNOWN or NOT_CONFIGURED, never a success.
 */

import { resolveLlmConfig } from "./llmClient";
import { resolveRunnerConfig } from "./buildDispatch";
import type { Rtos, Verdict, Verification } from "./types";

/* ------------------------------------------------------------------ doctor */

export type DoctorStatus = "PASS" | "MISSING";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  required: boolean;
  detail: string;
}

/** Result of `bun runner/index.ts doctor` (or `GET /doctor` on the runner). */
export interface DoctorReport {
  environment: "READY" | "NOT_READY";
  ready: boolean;
  board: string;
  checks: DoctorCheck[];
  missing: string[];
  zephyrBase: string | null;
  zephyrSdk: string | null;
  zephyrSdkVersion: string | null;
  boardsSupported: string[] | null;
  generatedAt: string;
}

/** A board that upstream Zephyr really ships a definition for. */
export const DEFAULT_REFERENCE_BOARD = "nucleo_l476rg";

const DOCTOR_LABEL_WIDTH = 17;

/**
 * Renders a doctor report for display (runner CLI, Convex payload, Environment
 * page) — one implementation, one format.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("EmbedFactory Environment");
  lines.push("");
  for (const entry of report.checks) {
    const label = entry.label.padEnd(DOCTOR_LABEL_WIDTH, " ");
    const status = entry.status === "PASS" ? "PASS" : "MISSING";
    lines.push(`${label} ${status.padEnd(7, " ")} ${entry.detail}`);
  }
  lines.push("");
  lines.push(`${"Environment".padEnd(DOCTOR_LABEL_WIDTH, " ")} ${report.environment}`);
  lines.push(`${"Board".padEnd(DOCTOR_LABEL_WIDTH, " ")} ${report.board}`);
  if (!report.ready) {
    lines.push("");
    lines.push("Missing:");
    for (const item of report.missing) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

/** Validates a payload received over HTTP before trusting it as a report. */
export function parseDoctorReport(raw: unknown): DoctorReport | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.ready !== "boolean" || !Array.isArray(record.checks)) return null;

  const checks: DoctorCheck[] = [];
  for (const entry of record.checks) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.label !== "string") continue;
    checks.push({
      id: item.id,
      label: item.label,
      status: item.status === "PASS" ? "PASS" : "MISSING",
      required: item.required === true,
      detail: typeof item.detail === "string" ? item.detail : "",
    });
  }

  return {
    environment: record.ready ? "READY" : "NOT_READY",
    ready: record.ready,
    board: typeof record.board === "string" ? record.board : DEFAULT_REFERENCE_BOARD,
    checks,
    missing: Array.isArray(record.missing)
      ? record.missing.filter((item): item is string => typeof item === "string")
      : [],
    zephyrBase: typeof record.zephyrBase === "string" ? record.zephyrBase : null,
    zephyrSdk: typeof record.zephyrSdk === "string" ? record.zephyrSdk : null,
    zephyrSdkVersion: typeof record.zephyrSdkVersion === "string" ? record.zephyrSdkVersion : null,
    boardsSupported: Array.isArray(record.boardsSupported)
      ? record.boardsSupported.filter((item): item is string => typeof item === "string")
      : null,
    generatedAt:
      typeof record.generatedAt === "string" ? record.generatedAt : new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------- state */

/** Reachability of the configured AI provider. */
export type ConnectionState = "CONNECTED" | "CONNECTION_FAILED" | "NOT_CONFIGURED" | "UNKNOWN";

/** Reachability of the build runner. */
export type RunnerState =
  | "CONNECTED"
  | "NOT_CONFIGURED"
  | "UNAVAILABLE"
  | "AUTHENTICATION_FAILED"
  | "UNKNOWN";

/** Whether a capability can actually be used right now. */
export type CapabilityState =
  | "READY"
  | "NOT_READY"
  | "NOT_CONFIGURED"
  | "NOT_AVAILABLE"
  | "UNKNOWN";

/** Semantic tone for the UI; the component maps it to classes. */
export type StatusTone = "ok" | "warn" | "error" | "idle";

export interface LlmStatus {
  configured: boolean;
  /**
   * True only when at least one `LLM_*` variable is really set on the server.
   * `configured` can be true with no variables at all, because the client has
   * built-in ollama defaults — the UI must not present those defaults as a
   * deliberate configuration.
   */
  explicit: boolean;
  provider: string;
  baseUrl: string | null;
  model: string | null;
  /** Never the key itself. */
  apiKeyConfigured: boolean;
  timeoutMs: number | null;
  maxRetries: number | null;
  temperature: number | null;
  state: ConnectionState;
  message: string | null;
  latencyMs: number | null;
  checkedAt: number | null;
}

export interface RunnerStatus {
  configured: boolean;
  url: string | null;
  /** Never the token itself. */
  tokenConfigured: boolean;
  state: RunnerState;
  message: string | null;
  latencyMs: number | null;
  checkedAt: number | null;
  tools: Record<string, boolean> | null;
  zephyrBase: string | null;
}

export interface RtosStatus {
  rtos: Rtos;
  state: CapabilityState;
  /** SDK / kernel version when it is really known. */
  version: string | null;
  /** Toolchain summary, e.g. "Zephyr SDK 0.16.5 · arm-zephyr-eabi". */
  toolchain: string | null;
  /** Can this machine actually build firmware for this RTOS? */
  buildCapability: CapabilityState;
  /** Concrete reasons, e.g. the doctor's missing list. */
  diagnostics: string[];
  checks: DoctorCheck[];
  board: string | null;
  boardsSupported: string[] | null;
  /** Raw `doctor` output, kept as evidence for the Environment page. */
  doctorReport: string | null;
  checkedAt: number | null;
  message: string | null;
}

export interface EnvironmentStatus {
  llm: LlmStatus;
  runner: RunnerStatus;
  zephyr: RtosStatus;
  freertos: RtosStatus;
  /** Aggregate of the Zephyr toolchain probe (west/cmake/sdk/arm/...). */
  toolchain: CapabilityState;
  checkedAt: number | null;
}

export interface ProjectEnvironmentStatus {
  projectId: string;
  ai: { state: ConnectionState; provider: string; model: string | null; message: string | null };
  build: {
    state: CapabilityState;
    runner: RunnerState;
    message: string | null;
    lastBuild: {
      verification: Verification;
      verdict: Verdict;
      exitCode: number | null;
      reason: string | null;
      attempt: number | null;
    } | null;
  };
  rtos: { rtos: Rtos; state: CapabilityState; message: string | null };
  board: { board: string | null; state: CapabilityState; message: string | null };
}

/* ---------------------------------------------------------------- secrets */

/** Renders a secret as Configured / Not configured. Never returns the value. */
export function secretLabel(configured: boolean): string {
  return configured ? "Configured" : "Not configured";
}

/**
 * Defensive mask for anything that might carry a credential, used before any
 * value is placed into a response payload or a log line.
 */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 3)}••••${value.slice(-2)}`;
}

/* ------------------------------------------------------------ env catalogue */

export interface EnvVarDoc {
  name: string;
  group: "ai" | "runner";
  secret: boolean;
  required: boolean;
  description: string;
  example: string;
}

/**
 * Every environment variable the product really reads. The Settings page and
 * `.env.example` both describe this same list, so documentation and UI cannot
 * drift apart.
 */
export const ENV_VAR_DOCS: EnvVarDoc[] = [
  {
    name: "LLM_PROVIDER",
    group: "ai",
    secret: false,
    required: false,
    description:
      "Generation provider: `ollama` (default) or `openai` for any OpenAI-compatible endpoint.",
    example: "ollama",
  },
  {
    name: "LLM_BASE_URL",
    group: "ai",
    secret: false,
    required: false,
    description: "Base URL of the provider. Required for a remote OpenAI-compatible endpoint.",
    example: "http://localhost:11434",
  },
  {
    name: "LLM_API_KEY",
    group: "ai",
    secret: true,
    required: false,
    description:
      "API key for a remote provider. Required when LLM_PROVIDER=openai and the host is not local.",
    example: "sk-...",
  },
  {
    name: "LLM_MODEL",
    group: "ai",
    secret: false,
    required: false,
    description:
      "Model used for every agent turn. Defaults to `llama3` (ollama) or `gpt-4o-mini` (openai).",
    example: "llama3",
  },
  {
    name: "LLM_TIMEOUT_MS",
    group: "ai",
    secret: false,
    required: false,
    description: "Per-request timeout in milliseconds (default 60000).",
    example: "60000",
  },
  {
    name: "LLM_MAX_RETRIES",
    group: "ai",
    secret: false,
    required: false,
    description: "Retries for 5xx and network errors (default 1).",
    example: "1",
  },
  {
    name: "LLM_TEMPERATURE",
    group: "ai",
    secret: false,
    required: false,
    description: "Sampling temperature (default 0.2).",
    example: "0.2",
  },
  {
    name: "BUILD_RUNNER_URL",
    group: "runner",
    secret: false,
    required: false,
    description:
      "HTTP endpoint of the local runner (`bun runner/index.ts serve`). Without it, builds are reported as NOT_AVAILABLE.",
    example: "http://127.0.0.1:8790",
  },
  {
    name: "BUILD_RUNNER_TOKEN",
    group: "runner",
    secret: true,
    required: false,
    description:
      "Shared secret sent as `Authorization: Bearer ...`. Must match the runner's `--token`.",
    example: "a-long-random-string",
  },
];

export function envVarsFor(group: EnvVarDoc["group"]): EnvVarDoc[] {
  return ENV_VAR_DOCS.filter((entry) => entry.group === group);
}

/* -------------------------------------------------------- state derivation */

/**
 * LLM configuration exactly as the server resolves it, with the key replaced by
 * a boolean. `state` stays UNKNOWN until a real probe has been run.
 */
export function resolveLlmStatus(
  env: Record<string, string | undefined>,
  previous?: Partial<LlmStatus> | null,
): LlmStatus {
  const resolved = resolveLlmConfig(env);
  const provider = env.LLM_PROVIDER?.toLowerCase() === "openai" ? "openai" : "ollama";
  // Did the operator actually set anything, or are these the built-in defaults?
  const explicit = Boolean(
    env.LLM_PROVIDER || env.LLM_BASE_URL || env.LLM_MODEL || env.LLM_API_KEY,
  );

  if (!resolved.ok) {
    return {
      configured: false,
      explicit,
      provider,
      baseUrl: env.LLM_BASE_URL?.trim() || null,
      model: env.LLM_MODEL?.trim() || null,
      apiKeyConfigured: Boolean(env.LLM_API_KEY),
      timeoutMs: null,
      maxRetries: null,
      temperature: null,
      state: previous?.state === "CONNECTION_FAILED" ? "CONNECTION_FAILED" : "NOT_CONFIGURED",
      message: previous?.message ?? resolved.reason,
      latencyMs: previous?.latencyMs ?? null,
      checkedAt: previous?.checkedAt ?? null,
    };
  }

  // A stored probe only stays valid while the configuration it probed is
  // unchanged. Otherwise the state falls back to UNKNOWN — never a stale OK.
  const probeState =
    previous?.state === "CONNECTED" || previous?.state === "CONNECTION_FAILED"
      ? previous.state
      : null;
  const sameConfig =
    previous != null &&
    previous.provider === resolved.config.provider &&
    previous.baseUrl === resolved.config.baseUrl &&
    previous.model === resolved.config.model;

  return {
    configured: true,
    explicit,
    provider: resolved.config.provider,
    baseUrl: resolved.config.baseUrl,
    model: resolved.config.model,
    apiKeyConfigured: Boolean(resolved.config.apiKey),
    timeoutMs: resolved.config.timeoutMs,
    maxRetries: resolved.config.maxRetries,
    temperature: resolved.config.temperature,
    state: probeState && sameConfig ? probeState : "UNKNOWN",
    message:
      probeState && sameConfig ? (previous?.message ?? null) : "Not tested yet — run Test connection.",
    latencyMs: probeState && sameConfig ? (previous?.latencyMs ?? null) : null,
    checkedAt: probeState && sameConfig ? (previous?.checkedAt ?? null) : null,
  };
}

/** Build runner configuration; the token is never returned. */
export function resolveRunnerStatus(
  env: Record<string, string | undefined>,
  previous?: Partial<RunnerStatus> | null,
): RunnerStatus {
  const config = resolveRunnerConfig(env);
  if (config.url === null) {
    return {
      configured: false,
      url: null,
      tokenConfigured: config.token !== null,
      state: "NOT_CONFIGURED",
      message: "BUILD_RUNNER_URL is not set, so native toolchains cannot run from this deployment.",
      latencyMs: null,
      checkedAt: null,
      tools: null,
      zephyrBase: null,
    };
  }

  // Same rule as the LLM probe: a stored answer is only valid while it still
  // describes the runner we would talk to now.
  const probeState =
    previous?.state && previous.state !== "NOT_CONFIGURED" && previous.state !== "UNKNOWN"
      ? previous.state
      : null;
  const sameConfig =
    previous != null &&
    previous.url === config.url &&
    previous.tokenConfigured === (config.token !== null);

  return {
    configured: true,
    url: config.url,
    tokenConfigured: config.token !== null,
    state: probeState && sameConfig ? probeState : "UNKNOWN",
    message:
      probeState && sameConfig ? (previous?.message ?? null) : "Not tested yet — run Test runner.",
    latencyMs: probeState && sameConfig ? (previous?.latencyMs ?? null) : null,
    checkedAt: probeState && sameConfig ? (previous?.checkedAt ?? null) : null,
    tools: probeState && sameConfig ? (previous?.tools ?? null) : null,
    zephyrBase: probeState && sameConfig ? (previous?.zephyrBase ?? null) : null,
  };
}

/** Turns a real `doctor` report into the Zephyr capability status. */
export function zephyrStatusFromDoctor(
  report: DoctorReport,
  previous?: Partial<RtosStatus> | null,
): RtosStatus {
  const sdk = report.zephyrSdkVersion ? `Zephyr SDK ${report.zephyrSdkVersion}` : null;
  const arm = report.checks.find((check) => check.id === "arm_toolchain");
  const toolchain = [sdk, arm && arm.status === "PASS" ? "arm-zephyr-eabi" : null]
    .filter(Boolean)
    .join(" · ");

  return {
    rtos: "zephyr",
    state: report.ready ? "READY" : "NOT_READY",
    version: report.zephyrSdkVersion,
    toolchain: toolchain === "" ? null : toolchain,
    buildCapability: report.ready ? "READY" : "NOT_READY",
    diagnostics: report.ready ? [] : report.missing.map((item) => `missing: ${item}`),
    checks: report.checks,
    board: report.board,
    boardsSupported: report.boardsSupported,
    doctorReport: previous?.doctorReport ?? null,
    checkedAt: previous?.checkedAt ?? null,
    message: report.ready ? null : `Doctor reports NOT_READY — missing: ${report.missing.join(", ")}`,
  };
}

/**
 * Zephyr could not be probed at all. The reason is always explicit; we never
 * guess that the toolchain exists.
 */
export function zephyrStatusUnavailable(
  reason: string,
  board: string,
  previous?: Partial<RtosStatus> | null,
): RtosStatus {
  return {
    rtos: "zephyr",
    state: "UNKNOWN",
    version: previous?.version ?? null,
    toolchain: previous?.toolchain ?? null,
    buildCapability: "NOT_AVAILABLE",
    diagnostics: [reason],
    checks: [],
    board,
    boardsSupported: previous?.boardsSupported ?? null,
    doctorReport: previous?.doctorReport ?? null,
    checkedAt: previous?.checkedAt ?? null,
    message: reason,
  };
}

/**
 * FreeRTOS diagnostics are not implemented yet. Reporting NOT_CONFIGURED with
 * an explicit reason is the honest answer — never READY.
 */
export function freertosStatus(previous?: Partial<RtosStatus> | null): RtosStatus {
  return {
    rtos: "freertos",
    state: "NOT_CONFIGURED",
    version: null,
    toolchain: null,
    buildCapability: "NOT_AVAILABLE",
    diagnostics: [
      "No FreeRTOS diagnostic is implemented yet: the doctor only probes the Zephyr toolchain, so FreeRTOS cannot be reported as ready.",
    ],
    checks: [],
    board: null,
    boardsSupported: null,
    doctorReport: previous?.doctorReport ?? null,
    checkedAt: previous?.checkedAt ?? null,
    message: "Not configured — no FreeRTOS doctor exists yet.",
  };
}

/** READY only when every required check really passed. */
export function toolchainStateFor(runner: RunnerStatus, zephyr: RtosStatus): CapabilityState {
  if (zephyr.state === "READY") return "READY";
  if (zephyr.state === "NOT_READY") return "NOT_READY";
  return runner.configured ? "UNKNOWN" : "NOT_CONFIGURED";
}

export function environmentStatus(input: {
  llm: LlmStatus;
  runner: RunnerStatus;
  zephyr: RtosStatus;
  freertos?: RtosStatus;
  checkedAt?: number | null;
}): EnvironmentStatus {
  const freertos = input.freertos ?? freertosStatus();
  return {
    llm: input.llm,
    runner: input.runner,
    zephyr: input.zephyr,
    freertos,
    toolchain: toolchainStateFor(input.runner, input.zephyr),
    checkedAt: input.checkedAt ?? null,
  };
}

/* ------------------------------------------------------- project readiness */

/** Board verification: never READY unless the doctor really listed it. */
export function boardStateFor(
  board: string | null,
  zephyr: RtosStatus,
): { state: CapabilityState; message: string | null } {
  if (!board) {
    return { state: "NOT_CONFIGURED", message: "No board is set on this project." };
  }
  if (zephyr.boardsSupported && zephyr.boardsSupported.length > 0) {
    return zephyr.boardsSupported.includes(board)
      ? { state: "READY", message: `"${board}" is recognised by west on the runner.` }
      : {
          state: "NOT_READY",
          message: `"${board}" is not among the ${zephyr.boardsSupported.length} boards reported by west.`,
        };
  }
  return {
    state: "UNKNOWN",
    message: `UNKNOWN / NOT VERIFIED — the board list was never read (no runner or no diagnostics run), so "${board}" cannot be confirmed.`,
  };
}

export function buildStateFor(
  runner: RunnerStatus,
  rtos: RtosStatus,
): { state: CapabilityState; message: string | null } {
  if (!runner.configured) {
    return {
      state: "NOT_AVAILABLE",
      message:
        "No build runner configured: start `bun runner/index.ts serve` and set BUILD_RUNNER_URL.",
    };
  }
  if (runner.state === "AUTHENTICATION_FAILED") {
    return { state: "NOT_AVAILABLE", message: "The runner rejected BUILD_RUNNER_TOKEN." };
  }
  if (runner.state === "UNAVAILABLE") {
    return { state: "NOT_AVAILABLE", message: runner.message ?? "The runner is unreachable." };
  }
  if (runner.state !== "CONNECTED") {
    return { state: "UNKNOWN", message: "The runner has not been tested yet — run diagnostics." };
  }
  if (rtos.buildCapability === "READY") return { state: "READY", message: null };
  if (rtos.buildCapability === "NOT_READY") {
    return {
      state: "NOT_READY",
      message: rtos.message ?? "The toolchain for this RTOS is incomplete.",
    };
  }
  return {
    state: "NOT_AVAILABLE",
    message: rtos.message ?? `No real build capability for ${rtos.rtos} on this machine.`,
  };
}

/* ------------------------------------------------------------------- labels */

export function connectionTone(state: ConnectionState): StatusTone {
  switch (state) {
    case "CONNECTED":
      return "ok";
    case "CONNECTION_FAILED":
      return "error";
    case "NOT_CONFIGURED":
      return "idle";
    default:
      return "warn";
  }
}

export function runnerTone(state: RunnerState): StatusTone {
  switch (state) {
    case "CONNECTED":
      return "ok";
    case "AUTHENTICATION_FAILED":
    case "UNAVAILABLE":
      return "error";
    case "NOT_CONFIGURED":
      return "idle";
    default:
      return "warn";
  }
}

export function capabilityTone(state: CapabilityState): StatusTone {
  switch (state) {
    case "READY":
      return "ok";
    case "NOT_READY":
      return "error";
    case "NOT_CONFIGURED":
      return "idle";
    case "NOT_AVAILABLE":
      return "warn";
    default:
      return "warn";
  }
}

/** Compact labels used across the control plane: no underscores in the UI. */
export function connectionLabel(state: ConnectionState): string {
  return state.replace(/_/g, " ");
}

export function runnerLabel(state: RunnerState): string {
  return state.replace(/_/g, " ");
}

export function capabilityLabel(state: CapabilityState): string {
  return state.replace(/_/g, " ");
}

/* -------------------------------------------------------------- first run */

export interface OnboardingStep {
  id: "ai" | "runner" | "zephyr" | "freertos";
  title: string;
  state: CapabilityState;
  detail: string;
  href: string;
}

/**
 * The first-run checklist. It never blocks the user: every step reports what is
 * missing and links to the place where it can be fixed.
 */
export function onboardingSteps(status: EnvironmentStatus): OnboardingStep[] {
  return [
    {
      id: "ai",
      title: "Connect AI",
      state:
        status.llm.state === "CONNECTED"
          ? "READY"
          : status.llm.state === "CONNECTION_FAILED"
            ? "NOT_READY"
            : status.llm.configured && status.llm.explicit
              ? "UNKNOWN"
              : "NOT_CONFIGURED",
      detail: status.llm.configured
        ? status.llm.explicit
          ? `${status.llm.provider} · ${status.llm.model ?? "model not set"} — not tested yet`
          : `No LLM_* variable is set: the agent would use the built-in default ${status.llm.provider} at ${status.llm.baseUrl ?? "?"}.`
        : (status.llm.message ?? "LLM_BASE_URL / LLM_PROVIDER are not set on the server."),
      href: "/settings",
    },
    {
      id: "runner",
      title: "Check build runner",
      state:
        status.runner.state === "CONNECTED"
          ? "READY"
          : status.runner.state === "NOT_CONFIGURED"
            ? "NOT_CONFIGURED"
            : "NOT_READY",
      detail: status.runner.configured
        ? (status.runner.message ?? status.runner.url ?? "runner configured")
        : "No runner: native toolchains cannot run from the web app.",
      href: "/environment",
    },
    {
      id: "zephyr",
      title: "Zephyr toolchain",
      state: status.zephyr.state,
      detail:
        status.zephyr.state === "READY"
          ? (status.zephyr.toolchain ?? "toolchain verified")
          : (status.zephyr.message ?? "Run diagnostics to probe the Zephyr toolchain."),
      href: "/environment",
    },
    {
      id: "freertos",
      title: "FreeRTOS",
      state: status.freertos.state,
      detail: status.freertos.message ?? "Not configured.",
      href: "/environment",
    },
  ];
}

export const ENVIRONMENT_HONESTY_NOTE =
  "A status is only READY or CONNECTED after a real check. Anything unproven stays UNKNOWN or NOT_CONFIGURED.";
