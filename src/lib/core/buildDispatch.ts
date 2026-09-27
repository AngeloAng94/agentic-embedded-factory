/**
 * Build job dispatch.
 *
 * The web app cannot execute native toolchains inside Convex, so a build is a
 * job sent to a runner:
 *
 *   WEB → Build Job → Runner (HTTP) → container/worker → real Zephyr toolchain
 *
 * When no runner is configured the job is honestly reported as NOT_AVAILABLE.
 * The runner answer is never trusted blindly: a success claim without a real
 * process is downgraded to UNKNOWN by `normalizeRunnerResult`.
 */

import type { BuildResult, Verdict, Verification } from "./types";
import { emptyBuildResult } from "./types";

export interface RunnerConfig {
  url: string | null;
  token: string | null;
  timeoutMs: number;
}

export type DispatchResult =
  | { ok: true; result: BuildResult; runner: string }
  | {
      ok: false;
      code:
        | "RUNNER_NOT_CONFIGURED"
        | "RUNNER_UNREACHABLE"
        | "RUNNER_TIMEOUT"
        | "RUNNER_HTTP_ERROR"
        | "RUNNER_BAD_RESPONSE";
      message: string;
    };

export interface RunnerBuildRequest {
  projectName: string;
  rtos: string;
  board?: string | null;
  command?: string | null;
  files: { path: string; content: string }[];
  timeoutMs?: number;
  attempt?: number;
}

const DEFAULT_RUNNER_TIMEOUT_MS = 15 * 60 * 1000;

export function resolveRunnerConfig(env: Record<string, string | undefined>): RunnerConfig {
  const url = env.BUILD_RUNNER_URL?.trim() ?? "";
  return {
    url: url === "" ? null : url.replace(/\/+$/, ""),
    token: env.BUILD_RUNNER_TOKEN?.trim() ?? null,
    timeoutMs: Number(env.BUILD_RUNNER_TIMEOUT_MS ?? DEFAULT_RUNNER_TIMEOUT_MS),
  };
}

export function normalizeRunnerResult(raw: unknown, attempt = 1): BuildResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const verification = record.verification;
  if (verification !== "REAL" && verification !== "SIMULATED" && verification !== "NOT_AVAILABLE") {
    return null;
  }

  let verdict = (
    record.verdict === "SUCCESS" || record.verdict === "FAILURE" || record.verdict === "UNKNOWN"
      ? record.verdict
      : undefined
  ) as Verdict | undefined;

  const exitCode = typeof record.exitCode === "number" ? record.exitCode : null;
  if (verdict === undefined) {
    verdict = exitCode === null ? "UNKNOWN" : exitCode === 0 ? "SUCCESS" : "FAILURE";
  }

  const result: BuildResult = {
    verification: verification as Verification,
    verdict,
    command: typeof record.command === "string" ? record.command : null,
    toolchain: typeof record.toolchain === "string" ? record.toolchain : null,
    exitCode,
    durationMs: typeof record.durationMs === "number" ? record.durationMs : null,
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    artifacts: Array.isArray(record.artifacts)
      ? record.artifacts.filter((value): value is string => typeof value === "string")
      : [],
    reason: typeof record.reason === "string" ? record.reason : null,
    attempt,
  };

  // Integrity guard: only a real, zero-exit process may claim SUCCESS.
  if (result.verdict === "SUCCESS" && (result.verification !== "REAL" || result.exitCode !== 0)) {
    result.verdict = "UNKNOWN";
    result.reason = `runner claimed SUCCESS without a real successful process (${
      result.reason ?? "no reason given"
    })`;
  }
  if (result.verification === "NOT_AVAILABLE" && result.verdict === "SUCCESS") {
    result.verdict = "UNKNOWN";
  }

  return result;
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export async function dispatchBuild(
  config: RunnerConfig,
  request: RunnerBuildRequest,
  options: { fetchImpl?: FetchLike; log?: (message: string) => void } = {},
): Promise<DispatchResult> {
  const log = options.log ?? (() => {});
  if (!config.url) {
    return {
      ok: false,
      code: "RUNNER_NOT_CONFIGURED",
      message:
        "No build runner configured. Set BUILD_RUNNER_URL to a runner endpoint (see runner/README) or export the project and build it locally.",
    };
  }

  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const endpoint = `${config.url}/build`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? config.timeoutMs);

  try {
    log(`[build] dispatching to ${endpoint} (rtos=${request.rtos}, files=${request.files.length})`);
    const response = await doFetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const text = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        code: "RUNNER_HTTP_ERROR",
        message: `runner returned HTTP ${response.status}: ${text.slice(0, 300)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, code: "RUNNER_BAD_RESPONSE", message: "runner did not return JSON" };
    }

    const result = normalizeRunnerResult(parsed, request.attempt ?? 1);
    if (!result) {
      return {
        ok: false,
        code: "RUNNER_BAD_RESPONSE",
        message: "runner answer does not match the build result contract",
      };
    }

    log(
      `[build] runner answered in ${Date.now() - started}ms: verification=${result.verification} verdict=${result.verdict} exit=${result.exitCode}`,
    );
    return { ok: true, result, runner: config.url };
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      code: aborted ? "RUNNER_TIMEOUT" : "RUNNER_UNREACHABLE",
      message: aborted
        ? "runner did not answer before the timeout"
        : `runner unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function notAvailableFromDispatch(
  code: string,
  message: string,
  attempt = 1,
): BuildResult {
  const result = emptyBuildResult("NOT_AVAILABLE", `build runner: ${code} — ${message}`);
  result.attempt = attempt;
  return result;
}
