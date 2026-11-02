/**
 * A single agent turn, executed locally.
 *
 * Used by `runner/index.ts turn` (CLI + desktop). It performs the same steps as
 * the Convex action, with the same core modules:
 *
 *   knowledge retrieval → LLM → validated patches (all-or-nothing) → optional real build
 *
 * Nothing is written to disk here: the caller receives the resulting file
 * contents plus the patch that produced them, so every surface (web, desktop)
 * persists the exact same validated result.
 */

import {
  AGENT_SYSTEM_PROMPT,
  buildTurnPrompt,
  describePlan,
  parseAgentResponse,
} from "../../src/lib/core/agentProtocol";
import { applyUnifiedDiff, parseUnifiedDiff } from "../../src/lib/core/diff";
import { isPathAllowed, MAX_FILE_BYTES } from "../../src/lib/core/pathSafety";
import { MAX_REPAIR_ATTEMPTS } from "../../src/lib/core/buildStatus";
import { formatKnowledgeBlock, retrieveKnowledge, type KbDocument } from "../../src/lib/core/knowledge";
import { LLM_UNAVAILABLE_MESSAGE, callLlm, resolveLlmConfig } from "../../src/lib/core/llmClient";
import { analyzeProject } from "../../src/lib/core/safety";
import type { BuildResult } from "../../src/lib/core/types";

export interface TurnFile {
  path: string;
  content: string;
}

export interface TurnWrite {
  path: string;
  content: string;
  previousContent: string | null;
  patch: string | null;
  kind: "create" | "patch";
}

export interface TurnRequest {
  projectName: string;
  rtos: string;
  board?: string | null;
  mcu?: string | null;
  userMessage: string;
  files: TurnFile[];
  knowledge?: KbDocument[];
  /** Previous real build evidence, used on repair turns. */
  buildResult?: BuildResult | null;
  attempt?: number;
  env?: Record<string, string | undefined>;
}

export type TurnOutcome =
  | {
      ok: true;
      status: "ANSWER_ONLY" | "CHANGES_APPLIED";
      summary: string;
      writes: TurnWrite[];
      failed: { path: string; code: string; reason: string }[];
      rejected: { path: string; reason: string }[];
      requestBuild: boolean;
      knowledgeLog: string;
      llm: { model: string; attempts: number; durationMs: number; endpoint: string };
      safety: ReturnType<typeof analyzeProject>;
    }
  | {
      ok: false;
      code:
        | "LLM_NOT_CONFIGURED"
        | "LLM_UNREACHABLE"
        | "LLM_TIMEOUT"
        | "LLM_HTTP_ERROR"
        | "LLM_EMPTY_RESPONSE"
        | "LLM_BAD_RESPONSE"
        | "PLAN_EMPTY"
        | "PATCH_FAILED";
      message: string;
      detail?: { path: string; code: string; reason: string }[];
      knowledgeLog: string;
    };

export async function runAgentTurn(request: TurnRequest): Promise<TurnOutcome> {
  const env = request.env ?? process.env;
  const knowledgeDocs = request.knowledge ?? [];
  const retrieval = retrieveKnowledge(knowledgeDocs, {
    rtos: request.rtos === "freertos" ? "freertos" : "zephyr",
    userRequest: request.userMessage,
  });

  const llmConfig = resolveLlmConfig(env);
  if (!llmConfig.ok) {
    return {
      ok: false,
      code: "LLM_NOT_CONFIGURED",
      message: llmConfig.reason,
      knowledgeLog: retrieval.log,
    };
  }

  const attempt = request.attempt ?? 1;
  const prompt = buildTurnPrompt({
    project: {
      name: request.projectName,
      rtos: request.rtos === "freertos" ? "freertos" : "zephyr",
      board: request.board ?? null,
      mcu: request.mcu ?? null,
    },
    files: request.files,
    knowledge: formatKnowledgeBlock(retrieval.docs),
    userRequest: request.userMessage,
    buildResult: request.buildResult ?? null,
    attempt,
  });

  const llm = await callLlm(llmConfig.config, `${AGENT_SYSTEM_PROMPT}\n\n${prompt}`);
  if (!llm.ok) {
    return {
      ok: false,
      code: llm.code,
      message: `${LLM_UNAVAILABLE_MESSAGE}\n\nCode: ${llm.code}\nProvider: ${
        llm.endpoint ?? "n/a"
      }\nReason: ${llm.message}`,
      knowledgeLog: retrieval.log,
    };
  }

  const parsed = parseAgentResponse(llm.text);
  if (!parsed.ok) {
    return {
      ok: false,
      code: parsed.code,
      message: `${parsed.reason} — no files were created or modified.`,
      knowledgeLog: retrieval.log,
    };
  }

  const plan = parsed.plan;
  const byPath = new Map(request.files.map((file) => [file.path, file.content]));
  const writes: TurnWrite[] = [];
  const failed: { path: string; code: string; reason: string }[] = [];
  const rejected: { path: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const create of plan.creates) {
    if (!isPathAllowed(create.path)) {
      rejected.push({ path: create.path, reason: "path outside the project sandbox" });
      continue;
    }
    if (seen.has(create.path)) {
      failed.push({ path: create.path, code: "DUPLICATE_OPERATION", reason: "path touched twice" });
      continue;
    }
    seen.add(create.path);
    if (create.content.length > MAX_FILE_BYTES) {
      failed.push({ path: create.path, code: "FILE_TOO_LARGE", reason: "content too large" });
      continue;
    }
    const existing = byPath.get(create.path);
    if (existing !== undefined && existing !== create.content) {
      failed.push({
        path: create.path,
        code: "CREATE_OVER_EXISTING",
        reason: "file exists: send a unified diff patch instead",
      });
      continue;
    }
    if (existing === create.content) continue;
    writes.push({ path: create.path, content: create.content, previousContent: null, patch: null, kind: "create" });
  }

  for (const patch of plan.patches) {
    if (!isPathAllowed(patch.path)) {
      rejected.push({ path: patch.path, reason: "path outside the project sandbox" });
      continue;
    }
    if (seen.has(patch.path)) {
      failed.push({ path: patch.path, code: "DUPLICATE_OPERATION", reason: "path touched twice" });
      continue;
    }
    seen.add(patch.path);

    const current = byPath.get(patch.path);
    if (current === undefined) {
      failed.push({
        path: patch.path,
        code: "PATCH_TARGET_MISSING",
        reason: "patch targets a file that does not exist: send it as a create",
      });
      continue;
    }
    const parsedDiff = parseUnifiedDiff(patch.diff);
    if (!parsedDiff.ok) {
      failed.push({ path: patch.path, code: "PATCH_FAILED", reason: parsedDiff.reason });
      continue;
    }
    if (parsedDiff.parsed.filePath && parsedDiff.parsed.filePath !== patch.path) {
      failed.push({
        path: patch.path,
        code: "PATCH_PATH_MISMATCH",
        reason: `diff header targets ${parsedDiff.parsed.filePath}`,
      });
      continue;
    }
    const outcome = applyUnifiedDiff(current, patch.diff);
    if (!outcome.ok) {
      failed.push({ path: patch.path, code: "PATCH_FAILED", reason: outcome.reason });
      continue;
    }
    if (outcome.content === current) continue;
    writes.push({
      path: patch.path,
      content: outcome.content,
      previousContent: current,
      patch: patch.diff,
      kind: "patch",
    });
  }

  if (failed.length > 0) {
    return {
      ok: false,
      code: "PATCH_FAILED",
      message: `PATCH_FAILED — nothing was written (${describePlan(plan)})`,
      detail: failed,
      knowledgeLog: retrieval.log,
    };
  }

  const resultingFiles = [
    ...request.files.map((file) => {
      const write = writes.find((entry) => entry.path === file.path);
      return write ? { path: file.path, content: write.content } : file;
    }),
    ...writes.filter((write) => write.kind === "create").map((write) => ({ path: write.path, content: write.content })),
  ];

  const safety = analyzeProject(resultingFiles, request.rtos);

  return {
    ok: true,
    status: writes.length === 0 ? "ANSWER_ONLY" : "CHANGES_APPLIED",
    summary: plan.summary,
    writes,
    failed,
    rejected,
    requestBuild: plan.requestBuild && !plan.answerOnly,
    knowledgeLog: retrieval.log,
    llm: {
      model: llm.model,
      attempts: llm.attempts,
      durationMs: llm.durationMs,
      endpoint: llm.endpoint,
    },
    safety,
  };
}

export { MAX_REPAIR_ATTEMPTS };
