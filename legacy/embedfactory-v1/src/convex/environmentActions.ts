"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/auth";
import { probeLlm, resolveLlmConfig } from "../lib/core/llmClient";
import { probeRunnerHealth, resolveRunnerConfig } from "../lib/core/buildDispatch";
import {
  DEFAULT_REFERENCE_BOARD,
  formatDoctorReport,
  freertosStatus,
  parseDoctorReport,
  resolveLlmStatus,
  resolveRunnerStatus,
  zephyrStatusFromDoctor,
  zephyrStatusUnavailable,
  type ConnectionState,
  type LlmStatus,
  type RtosStatus,
  type RunnerState,
  type RunnerStatus,
} from "../lib/core/environmentStatus";
import type { ZephyrRecord } from "./environment";

/**
 * Environment control plane — the probe side.
 *
 * Every function here performs a *real* request and stores exactly what came
 * back. There is no simulated path: if the LLM or the runner cannot be reached
 * the stored state is CONNECTION_FAILED / UNAVAILABLE / NOT_CONFIGURED, which is
 * what the UI then shows.
 *
 * Secrets: the API key and the runner token are read from `process.env` inside
 * this node process and are never put into a return value or a stored payload —
 * only the derived `apiKeyConfigured` / `tokenConfigured` booleans are.
 */

/**
 * Logs endpoint/provider/model and never a credential: `probeLlm` and
 * `probeRunnerHealth` only log the URL, the provider and the model, never the
 * request headers that carry the key or the token.
 */
function log(line: string): void {
  console.log(`[environment] ${line}`);
}

export interface LlmTestResult {
  state: ConnectionState;
  message: string;
  endpoint: string | null;
  latencyMs: number | null;
  model: string | null;
  checkedAt: number;
  llm: LlmStatus;
}

export interface RunnerTestResult {
  state: RunnerState;
  message: string | null;
  latencyMs: number | null;
  tools: Record<string, boolean> | null;
  zephyrBase: string | null;
  checkedAt: number;
  runner: RunnerStatus;
}

export interface DiagnosticsResult {
  runner: RunnerStatus;
  zephyr: RtosStatus;
  checkedAt: number;
}

/**
 * Settings → AI/LLM → "Test connection": one real generation request with the
 * configured provider/model. CONNECTED means it really answered.
 */
export const testLlm = action({
  args: {},
  handler: async (ctx): Promise<LlmTestResult> => {
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const now = Date.now();
    const resolved = resolveLlmConfig(process.env);

    if (!resolved.ok) {
      const llm = resolveLlmStatus(process.env, {
        state: "NOT_CONFIGURED",
        message: resolved.reason,
      });
      await ctx.runMutation(internal.environment.saveChecks, {
        userId,
        llm: JSON.stringify(llm),
        llmCheckedAt: now,
      });
      return {
        state: "NOT_CONFIGURED",
        message: resolved.reason,
        endpoint: null,
        latencyMs: null,
        model: null,
        checkedAt: now,
        llm,
      };
    }

    const probe = await probeLlm(resolved.config, { log });

    // Feed the *real* probe result back through the shared resolver so the
    // stored payload carries the same shape (and the same invalidation rules)
    // as everything else.
    const llm = resolveLlmStatus(process.env, {
      provider: resolved.config.provider,
      baseUrl: resolved.config.baseUrl,
      model: resolved.config.model,
      state: probe.state,
      message: probe.message,
      latencyMs: probe.latencyMs,
    });
    await ctx.runMutation(internal.environment.saveChecks, {
      userId,
      llm: JSON.stringify(llm),
      llmCheckedAt: now,
    });

    return {
      state: probe.state,
      message: probe.message,
      endpoint: probe.endpoint,
      latencyMs: probe.latencyMs,
      model: probe.state === "CONNECTED" ? probe.model : resolved.config.model,
      checkedAt: now,
      llm,
    };
  },
});

/**
 * Settings → Build runner → "Test runner": a real `GET /health`. A 401/403 is
 * AUTHENTICATION_FAILED, a transport error is UNAVAILABLE; nothing is inferred.
 */
export const testRunner = action({
  args: {},
  handler: async (ctx): Promise<RunnerTestResult> => {
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const now = Date.now();
    const config = resolveRunnerConfig(process.env);
    const probe = await probeRunnerHealth(config, { log });

    const runner = resolveRunnerStatus(process.env, {
      url: config.url,
      tokenConfigured: config.token !== null,
      state: probe.state,
      message: probe.message,
      latencyMs: probe.latencyMs,
      tools: probe.tools,
      zephyrBase: probe.zephyrBase,
    });
    await ctx.runMutation(internal.environment.saveChecks, {
      userId,
      runner: JSON.stringify(runner),
      runnerCheckedAt: now,
    });

    return {
      state: runner.state,
      message: runner.message,
      latencyMs: runner.latencyMs,
      tools: runner.tools,
      zephyrBase: runner.zephyrBase,
      checkedAt: now,
      runner,
    };
  },
});

/**
 * Environment → "Run diagnostics": `GET /health` + `GET /doctor` on the runner.
 *
 * The doctor report is the *only* source of Zephyr/toolchain evidence, because
 * only the machine that owns the toolchain can inspect it. When the runner is
 * unreachable or does not answer `/doctor`, Zephyr becomes UNKNOWN /
 * NOT_AVAILABLE with the reason attached — never READY.
 */
export const runDiagnostics = action({
  args: {},
  handler: async (ctx): Promise<DiagnosticsResult> => {
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const now = Date.now();
    const config = resolveRunnerConfig(process.env);
    const probe = await probeRunnerHealth(config, { includeDoctor: true, log });

    const runner = resolveRunnerStatus(process.env, {
      url: config.url,
      tokenConfigured: config.token !== null,
      state: probe.state,
      message: probe.message,
      latencyMs: probe.latencyMs,
      tools: probe.tools,
      zephyrBase: probe.zephyrBase,
    });

    const board = DEFAULT_REFERENCE_BOARD;
    const report = parseDoctorReport(probe.doctor);
    let zephyr: RtosStatus;

    if (probe.state !== "CONNECTED") {
      zephyr = zephyrStatusUnavailable(
        `The build runner is ${probe.state.replace(/_/g, " ")}${
          probe.message ? ` — ${probe.message}` : ""
        }, so the Zephyr toolchain could not be probed on the build machine.`,
        board,
      );
    } else if (report) {
      zephyr = {
        ...zephyrStatusFromDoctor(report, { checkedAt: now }),
        doctorReport: formatDoctorReport(report),
        checkedAt: now,
      };
    } else {
      zephyr = zephyrStatusUnavailable(
        "The runner answered /health but did not return a doctor report (GET /doctor failed), so Zephyr availability is unknown.",
        board,
      );
    }

    const record: ZephyrRecord = { runnerUrl: runner.url, status: zephyr };
    await ctx.runMutation(internal.environment.saveChecks, {
      userId,
      runner: JSON.stringify(runner),
      zephyr: JSON.stringify(record),
      freertos: JSON.stringify(freertosStatus()),
      runnerCheckedAt: now,
      diagnosticsAt: now,
    });

    return { runner, zephyr, checkedAt: now };
  },
});
