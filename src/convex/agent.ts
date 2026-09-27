"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";
import { MAX_REPAIR_ATTEMPTS, formatBuildReport } from "../lib/core/buildStatus";
import {
  dispatchBuild,
  notAvailableFromDispatch,
  resolveRunnerConfig,
} from "../lib/core/buildDispatch";
import { callLlm, LLM_UNAVAILABLE_MESSAGE, resolveLlmConfig } from "../lib/core/llmClient";
import {
  AGENT_SYSTEM_PROMPT,
  buildTurnPrompt,
  describePlan,
  parseAgentResponse,
} from "../lib/core/agentProtocol";
import { retrieveKnowledge, formatKnowledgeBlock } from "../lib/core/knowledge";
import { analyzeProject } from "../lib/core/safety";
import type { BuildResult } from "../lib/core/types";
import {
  toBuildResult,
  type AgentCycleResult,
  type ApplyPlanOutcome,
  type GitInitActionResult,
  type ProjectContextPayload,
  type RunBuildActionResult,
} from "./lib/contracts";

/**
 * The agent loop, server side.
 *
 *   user prompt → knowledge retrieval → LLM → validated patch → real build
 *   → real compiler error → LLM → patch → real build (max 3 attempts)
 *
 * The API key never leaves this process and there is no fallback generator:
 * when the provider is unreachable the turn fails with an explicit error and
 * NOTHING is written to the project.
 */

const ACTION_TIME_BUDGET_MS = 8 * 60 * 1000;
const LLM_TIMEOUT_MS = 120_000;

function formatSafetyLog(
  report: ReturnType<typeof analyzeProject>,
): string {
  const lines = [
    `engine: ${report.engine} (${report.rtos})`,
    `summary: ${report.summary.pass} PASS / ${report.summary.warning} WARNING / ${report.summary.fail} FAIL`,
    "limitations: " + report.limitations.join("; "),
    "",
  ];
  for (const finding of report.findings) {
    const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
    lines.push(`[${finding.status}] ${finding.rule} (${finding.severity}) ${location} — ${finding.explanation}`);
    if (finding.snippet) lines.push(`        ${finding.snippet}`);
  }
  return lines.join("\n");
}

export const runCycle = action({
  args: {
    projectId: v.id("projects"),
    userMessage: v.string(),
    maxRepairAttempts: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<AgentCycleResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const context: ProjectContextPayload = await ctx.runQuery(
      internal.agentStore.projectContext,
      {
        projectId: args.projectId,
        userId: userId as Id<"users">,
      },
    );

    const agentRunId = `${args.projectId}:${Date.now().toString(36)}`;
    const startedAt = Date.now();
    const maxAttempts = Math.min(Math.max(args.maxRepairAttempts ?? MAX_REPAIR_ATTEMPTS, 1), 4);

    const log: string[] = [];

    await ctx.runMutation(internal.messages.insertInternal, {
      projectId: args.projectId,
      role: "user",
      content: args.userMessage,
    });

    // ---- knowledge retrieval (everything it injects is logged as evidence) --
    const documents = await ctx.runQuery(internal.knowledgeBase.allDocuments, {});
    const retrieval = retrieveKnowledge(documents, {
      rtos: context.project.rtos,
      userRequest: args.userMessage,
    });
    log.push(retrieval.log);
    await ctx.runMutation(internal.runs.insert, {
      projectId: args.projectId,
      type: "retrieval",
      stdout: retrieval.log,
      summary: `${retrieval.docs.length} fragment(s) injected (${retrieval.usedTokens}/${retrieval.budgetTokens} tokens)`,
      reason: "knowledge base retrieval evidence",
    });

    // ---- LLM configuration -------------------------------------------------
    const llmConfig = resolveLlmConfig(process.env);
    if (!llmConfig.ok) {
      const message = `**Agent unavailable — no files were changed.**

${llmConfig.reason}

${LLM_UNAVAILABLE_MESSAGE}`;
      await ctx.runMutation(internal.messages.insertInternal, {
        projectId: args.projectId,
        role: "assistant",
        content: message,
        toolCalls: JSON.stringify({ error: llmConfig.code }),
      });
      return { ok: false as const, code: llmConfig.code, message: llmConfig.reason };
    }

    let files = context.files;
    let buildResult: BuildResult | null = null;
    let attempt = 1;

    for (; attempt <= maxAttempts; attempt += 1) {
      if (Date.now() - startedAt > ACTION_TIME_BUDGET_MS) {
        const message = `## BUILD FAILED — REPAIR LIMIT REACHED

The action time budget was exhausted after ${attempt - 1} attempt(s).`;
        await ctx.runMutation(internal.messages.insertInternal, {
          projectId: args.projectId,
          role: "assistant",
          content: message,
        });
        return {
          ok: false as const,
          code: "TIME_BUDGET_EXHAUSTED" as const,
          message: "action time budget exhausted",
          attempts: attempt - 1,
          build: buildResult,
        };
      }

      const prompt = buildTurnPrompt({
        project: {
          name: context.project.name,
          rtos: context.project.rtos,
          board: context.project.board,
          mcu: context.project.mcu,
          description: context.project.description,
        },
        files,
        knowledge: formatKnowledgeBlock(retrieval.docs),
        userRequest: args.userMessage,
        buildResult:
          attempt > 1
            ? buildResult
            : context.lastBuild
              ? toBuildResult(context.lastBuild)
              : null,
        attempt,
      });

      const llm = await callLlm(
        {
          ...llmConfig.config,
          timeoutMs: Math.min(llmConfig.config.timeoutMs, LLM_TIMEOUT_MS),
        },
        `${AGENT_SYSTEM_PROMPT}\n\n${prompt}`,
        { log: (line) => log.push(line) },
      );

      if (!llm.ok) {
        const message = `**${LLM_UNAVAILABLE_MESSAGE}**

Code: \`${llm.code}\`
Provider: \`${llm.endpoint ?? "n/a"}\` (model \`${llmConfig.config.model}\`)
Reason: ${llm.message}`;
        await ctx.runMutation(internal.messages.insertInternal, {
          projectId: args.projectId,
          role: "assistant",
          content: message,
          toolCalls: JSON.stringify({ error: llm.code, llmLog: log }),
        });
        return { ok: false as const, code: llm.code, message: llm.message, attempts: attempt };
      }

      const parsed = parseAgentResponse(llm.text);
      if (!parsed.ok) {
        const message = `**The model answer could not be used — no files were changed.**

Code: \`${parsed.code}\`
Reason: ${parsed.reason}`;
        await ctx.runMutation(internal.messages.insertInternal, {
          projectId: args.projectId,
          role: "assistant",
          content: message,
          toolCalls: JSON.stringify({ error: parsed.code, llmLog: log }),
        });
        return { ok: false as const, code: parsed.code, message: parsed.reason, attempts: attempt };
      }

      const plan = parsed.plan;
      const hasOps = plan.creates.length > 0 || plan.patches.length > 0;

      if (!hasOps && !plan.requestBuild) {
        await ctx.runMutation(internal.messages.insertInternal, {
          projectId: args.projectId,
          role: "assistant",
          content: plan.summary || "No change requested.",
          toolCalls: JSON.stringify({ answerOnly: true, kbLog: retrieval.log }),
        });
        return {
          ok: true as const,
          status: "ANSWER_ONLY" as const,
          attempts: attempt,
          message: plan.summary,
          build: null,
          knowledge: retrieval.log,
        };
      }

      let appliedSummary = "no file change";
      if (hasOps) {
        const applied: ApplyPlanOutcome = await ctx.runMutation(internal.agentStore.applyPlan, {
          projectId: args.projectId,
          agentRunId,
          summary: plan.summary || "agent change",
          attempt,
          creates: plan.creates,
          patches: plan.patches,
        });

        if (applied.applied.length === 0) {
          const details = [
            ...applied.failed.map((item) => `- \`${item.path}\` → **${item.code}**: ${item.reason}`),
            ...applied.rejected.map((item) => `- \`${item.path}\` → rejected: ${item.reason}`),
            ...applied.unchanged.map((path) => `- \`${path}\` → already up to date`),
          ].join("\n");
          const message = `**PATCH_FAILED — nothing was written.**

${plan.summary}

${details || "- the plan contained no applicable operation"}`;
          await ctx.runMutation(internal.messages.insertInternal, {
            projectId: args.projectId,
            role: "assistant",
            content: message,
            toolCalls: JSON.stringify({
              error: "PATCH_FAILED",
              failed: applied.failed,
              rejected: applied.rejected,
              kbLog: retrieval.log,
            }),
          });
          return {
            ok: false as const,
            code: "PATCH_FAILED" as const,
            message: "no operation could be applied; the project is unchanged",
            detail: applied.failed,
            attempts: attempt,
          };
        }

        appliedSummary = `${applied.applied.length} file(s) written (${applied.applied
          .map((item) => `${item.path} v${item.version}`)
          .join(", ")})`;

        files = await ctx.runQuery(internal.agentStore.listFiles, {
          projectId: args.projectId,
        });

        // Real, deterministic safety analysis on the new content.
        const safety = analyzeProject(
          files.map((file) => ({ path: file.path, content: file.content })),
          context.project.rtos,
        );
        await ctx.runMutation(internal.runs.insert, {
          projectId: args.projectId,
          type: "safety",
          verification: "REAL",
          verdict: safety.summary.fail > 0 ? "FAILURE" : "SUCCESS",
          stdout: formatSafetyLog(safety),
          summary: `${safety.summary.pass} PASS / ${safety.summary.warning} WARNING / ${safety.summary.fail} FAIL (${safety.engine})`,
          reason: "static analysis of the current sources",
        });
      }

      if (!plan.requestBuild) {
        await ctx.runMutation(internal.messages.insertInternal, {
          projectId: args.projectId,
          role: "assistant",
          content: `${plan.summary}\n\n_${appliedSummary}. No build requested._`,
          toolCalls: JSON.stringify({ kbLog: retrieval.log, applied: appliedSummary }),
        });
        return {
          ok: true as const,
          status: "CHANGES_APPLIED" as const,
          attempts: attempt,
          message: plan.summary,
          build: null,
          knowledge: retrieval.log,
          applied: appliedSummary,
        };
      }

      // ---- build -----------------------------------------------------------
      const runner = resolveRunnerConfig(process.env);
      const dispatch = await dispatchBuild(
        runner,
        {
          projectName: context.project.name,
          rtos: context.project.rtos,
          board: context.project.board,
          files,
          attempt,
        },
        { log: (line) => log.push(line) },
      );

      if (!dispatch.ok) {
        const build = notAvailableFromDispatch(dispatch.code, dispatch.message, attempt);
        const runId = await ctx.runMutation(internal.runs.insert, {
          projectId: args.projectId,
          type: "build",
          verification: build.verification,
          verdict: build.verdict,
          command: build.command ?? undefined,
          reason: build.reason ?? undefined,
          attempt,
          stdout: "",
          stderr: "",
          summary: `${build.verification} · ${build.verdict}`,
          patchSummary: appliedSummary,
        });
        await ctx.runMutation(internal.agentStore.attachBuildToVersions, {
          projectId: args.projectId,
          agentRunId,
          buildRunId: runId,
          verdict: "UNKNOWN",
        });

        const message = `**Build NOT AVAILABLE — \`${dispatch.code}\`**

${dispatch.message}

The changes are saved but **not verified**: no compiler was invoked.
${appliedSummary}`;
        await ctx.runMutation(internal.messages.insertInternal, {
          projectId: args.projectId,
          role: "assistant",
          content: message,
          toolCalls: JSON.stringify({ code: dispatch.code, build, kbLog: retrieval.log }),
        });
        return {
          ok: true as const,
          status: "BUILD_NOT_AVAILABLE" as const,
          attempts: attempt,
          message,
          build,
          knowledge: retrieval.log,
          applied: appliedSummary,
        };
      }

      buildResult = dispatch.result;
      const runId = await ctx.runMutation(internal.runs.insert, {
        projectId: args.projectId,
        type: "build",
        verification: dispatch.result.verification,
        verdict: dispatch.result.verdict,
        command: dispatch.result.command ?? undefined,
        toolchain: dispatch.result.toolchain ?? undefined,
        exitCode: dispatch.result.exitCode ?? undefined,
        durationMs: dispatch.result.durationMs ?? undefined,
        stdout: dispatch.result.stdout.slice(0, 40_000),
        stderr: dispatch.result.stderr.slice(0, 40_000),
        artifacts: dispatch.result.artifacts,
        reason: dispatch.result.reason ?? undefined,
        attempt,
        summary: `${dispatch.result.verification} · ${dispatch.result.verdict}`,
        patchSummary: appliedSummary,
      });
      await ctx.runMutation(internal.agentStore.attachBuildToVersions, {
        projectId: args.projectId,
        agentRunId,
        buildRunId: runId,
        verdict: dispatch.result.verdict,
      });

      if (dispatch.result.verdict === "SUCCESS") {
        const message = `## BUILD SUCCESS (real toolchain)

${formatBuildReport(dispatch.result)}

### Change

${plan.summary}

${describePlan(plan)} — ${appliedSummary}`;
        await ctx.runMutation(internal.messages.insertInternal, {
          projectId: args.projectId,
          role: "assistant",
          content: message,
          toolCalls: JSON.stringify({
            build: dispatch.result,
            kbLog: retrieval.log,
            llm: { model: llm.model, attempts: llm.attempts, durationMs: llm.durationMs },
          }),
        });
        return {
          ok: true as const,
          status: "SUCCESS" as const,
          attempts: attempt,
          message,
          build: dispatch.result,
          knowledge: retrieval.log,
          applied: appliedSummary,
        };
      }

      // A real failure: the next iteration feeds the compiler output to the LLM.
      log.push(
        `[repair] attempt ${attempt} failed with exit code ${dispatch.result.exitCode}; feeding compiler output to the model`,
      );
    }

    const failureMessage = `## BUILD FAILED — REPAIR LIMIT REACHED

${buildResult ? formatBuildReport(buildResult) : "No build result was produced."}

The project is left in \`unverified\`/\`failed\` state. Attempts used: ${Math.min(
      attempt - 1,
      maxAttempts,
    )}/${maxAttempts}.`;
    await ctx.runMutation(internal.messages.insertInternal, {
      projectId: args.projectId,
      role: "assistant",
      content: failureMessage,
      toolCalls: JSON.stringify({ error: "REPAIR_LIMIT_REACHED", build: buildResult, llmLog: log }),
    });
    return {
      ok: false as const,
      code: "REPAIR_LIMIT_REACHED" as const,
      message: failureMessage,
      attempts: Math.min(attempt - 1, maxAttempts),
      build: buildResult,
    };
  },
});

export const runBuild = action({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<RunBuildActionResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const context: ProjectContextPayload = await ctx.runQuery(
      internal.agentStore.projectContext,
      {
        projectId: args.projectId,
        userId: userId as Id<"users">,
      },
    );

    const runner = resolveRunnerConfig(process.env);
    const dispatch = await dispatchBuild(runner, {
      projectName: context.project.name,
      rtos: context.project.rtos,
      board: context.project.board,
      files: context.files,
      attempt: 1,
    });

    if (!dispatch.ok) {
      const build = notAvailableFromDispatch(dispatch.code, dispatch.message, 1);
      await ctx.runMutation(internal.runs.insert, {
        projectId: args.projectId,
        type: "build",
        verification: build.verification,
        verdict: build.verdict,
        reason: build.reason ?? undefined,
        attempt: 1,
        summary: `${build.verification} · ${build.verdict}`,
      });
      return { ok: false as const, code: dispatch.code, message: dispatch.message, build };
    }

    const runId = await ctx.runMutation(internal.runs.insert, {
      projectId: args.projectId,
      type: "build",
      verification: dispatch.result.verification,
      verdict: dispatch.result.verdict,
      command: dispatch.result.command ?? undefined,
      toolchain: dispatch.result.toolchain ?? undefined,
      exitCode: dispatch.result.exitCode ?? undefined,
      durationMs: dispatch.result.durationMs ?? undefined,
      stdout: dispatch.result.stdout.slice(0, 40_000),
      stderr: dispatch.result.stderr.slice(0, 40_000),
      artifacts: dispatch.result.artifacts,
      reason: dispatch.result.reason ?? undefined,
      attempt: 1,
      summary: `${dispatch.result.verification} · ${dispatch.result.verdict}`,
    });

    await ctx.runMutation(internal.messages.insertInternal, {
      projectId: args.projectId,
      role: "assistant",
      content: formatBuildReport(dispatch.result),
      toolCalls: JSON.stringify({ buildRunId: runId, build: dispatch.result }),
    });

    return { ok: true as const, code: "BUILD_DISPATCHED" as const, build: dispatch.result };
  },
});

export const requestGitInit = action({
  args: {
    projectId: v.id("projects"),
    message: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<GitInitActionResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const context: ProjectContextPayload = await ctx.runQuery(
      internal.agentStore.projectContext,
      {
        projectId: args.projectId,
        userId: userId as Id<"users">,
      },
    );

    const runner = resolveRunnerConfig(process.env);
    if (!runner.url) {
      return {
        ok: false as const,
        code: "RUNNER_NOT_CONFIGURED" as const,
        message:
          "Git needs a local process. Configure BUILD_RUNNER_URL (bun runner/index.ts serve) to run `git init` + commit on your machine, or use the desktop app / the exported ZIP.",
      };
    }

    try {
      const response = await fetch(`${runner.url}/git`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(runner.token ? { Authorization: `Bearer ${runner.token}` } : {}),
        },
        body: JSON.stringify({
          projectName: context.project.name,
          files: context.files,
          message: args.message ?? `Initial commit from EmbedFactory (${context.project.name})`,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; message?: string; steps?: { command: string; exitCode: number }[] }
        | null;

      if (!response.ok || !payload) {
        return {
          ok: false as const,
          code: "RUNNER_HTTP_ERROR" as const,
          message: `runner returned HTTP ${response.status}`,
        };
      }

      return {
        ok: Boolean(payload.ok),
        code: payload.ok ? ("GIT_OK" as const) : ("GIT_FAILED" as const),
        message: payload.message ?? "",
        steps: payload.steps ?? [],
      };
    } catch (error) {
      return {
        ok: false as const,
        code: "RUNNER_UNREACHABLE" as const,
        message: `runner unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
