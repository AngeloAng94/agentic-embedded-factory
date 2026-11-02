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
  type AgentEdit,
} from "../core/agentProtocol";
import { applyBlockEdits } from "../core/blockPatch";
import { formatUnifiedDiff } from "../core/diff";
import { isPathAllowed, MAX_FILE_BYTES } from "../core/pathSafety";
import { MAX_REPAIR_ATTEMPTS } from "../core/buildStatus";
import {
  formatKnowledgeBlock,
  retrieveKnowledge,
  type KbDocument,
  type RetrievalResult,
} from "../core/knowledge";
import { LLM_UNAVAILABLE_MESSAGE } from "../core/llmClient";
import { analyzeProject } from "../core/safety";
import type { BuildResult } from "../core/types";
import { LlmClientRuntime, type ModelRuntime } from "./modelRuntime";

export interface TurnFile {
  path: string;
  content: string;
}

export interface TurnWrite {
  path: string;
  content: string;
  previousContent: string | null;
  /** Unified diff generated from the change: for display/export, not input. */
  patch: string | null;
  kind: "create" | "block-edit";
  /** Block replaced by a block edit, null for a create. */
  block: string | null;
}

export interface TurnRequest {
  projectName: string;
  rtos: string;
  board?: string | null;
  mcu?: string | null;
  userMessage: string;
  files: TurnFile[];
  knowledge?: KbDocument[];
  /** Blocks declared in the product profile; an edit outside them is rejected. */
  anchors?: string[];
  /** Previous real build evidence, used on repair turns. */
  buildResult?: BuildResult | null;
  attempt?: number;
  env?: Record<string, string | undefined>;
  /** Injected by the caller; absent keeps the existing LLM client. */
  modelRuntime?: ModelRuntime;
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
      /** Same retrieval the prompt was built from, for the run record. */
      retrieval: RetrievalResult;
      llm: {
        provider: string;
        model: string;
        attempts: number;
        durationMs: number;
        endpoint: string | null;
        fake: boolean;
      };
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
        | "MODEL_RUNTIME_UNAVAILABLE"
        | "MODEL_RUNTIME_FAKE_DISABLED"
        | "MODEL_RUNTIME_ERROR"
        | "LLM_BAD_RESPONSE"
        | "PLAN_EMPTY"
        | "PATCH_FAILED";
      message: string;
      detail?: { path: string; code: string; reason: string }[];
      knowledgeLog: string;
      retrieval: RetrievalResult;
    };

export async function runAgentTurn(request: TurnRequest): Promise<TurnOutcome> {
  const env = request.env ?? process.env;
  const knowledgeDocs = request.knowledge ?? [];
  const retrieval = retrieveKnowledge(knowledgeDocs, {
    rtos: request.rtos === "freertos" ? "freertos" : "zephyr",
    userRequest: request.userMessage,
  });

  const runtime = request.modelRuntime ?? new LlmClientRuntime({ env });
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
    anchors: request.anchors ?? [],
  });

  const llm = await runtime.generate({
    system: AGENT_SYSTEM_PROMPT,
    prompt,
  });
  if (!llm.ok) {
    return {
      ok: false,
      code: llm.code,
      message: `${LLM_UNAVAILABLE_MESSAGE}\n\nCode: ${llm.code}\nProvider: ${
        llm.endpoint ?? runtime.provider
      }\nReason: ${llm.message}`,
      knowledgeLog: retrieval.log,
      retrieval,
    };
  }

  const parsed = parseAgentResponse(llm.text);
  if (!parsed.ok) {
    return {
      ok: false,
      code: parsed.code,
      message: `${parsed.reason} — no files were created or modified.`,
      knowledgeLog: retrieval.log,
      retrieval,
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
    writes.push({
      path: create.path,
      content: create.content,
      previousContent: null,
      patch: null,
      kind: "create",
      block: null,
    });
  }

  // Block-scoped edits: only the body between [AI_START_<block>] and
  // [AI_END_<block>] can change. All of them are applied at once or not at all.
  const safeEdits: AgentEdit[] = [];
  for (const edit of plan.edits) {
    if (!isPathAllowed(edit.path)) {
      rejected.push({ path: edit.path, reason: "path outside the project sandbox" });
      continue;
    }
    if (writes.some((write) => write.kind === "create" && write.path === edit.path)) {
      failed.push({
        path: edit.path,
        code: "DUPLICATE_OPERATION",
        reason: "the same plan creates and edits this file",
      });
      continue;
    }
    safeEdits.push(edit);
  }

  if (safeEdits.length > 0) {
    const outcome = applyBlockEdits(request.files, safeEdits, request.anchors ?? []);
    if (!outcome.ok) {
      for (const failure of outcome.failed) {
        failed.push({
          path: failure.path,
          code: failure.code,
          reason: `block ${failure.block}: ${failure.reason}`,
        });
      }
    } else {
      for (const applied of outcome.applied) {
        writes.push({
          path: applied.path,
          content: applied.content,
          previousContent: applied.previousContent,
          patch: formatUnifiedDiff(applied.path, applied.previousContent, applied.content),
          kind: "block-edit",
          block: applied.block,
        });
      }
    }
  }

  if (failed.length > 0) {
    return {
      ok: false,
      code: "PATCH_FAILED",
      message: `PATCH_FAILED — nothing was written (${describePlan(plan)})`,
      detail: failed,
      knowledgeLog: retrieval.log,
      retrieval,
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
    retrieval,
    llm: {
      provider: llm.provider,
      model: llm.model,
      attempts: llm.attempts,
      durationMs: llm.durationMs,
      endpoint: llm.endpoint,
      fake: llm.fake,
    },
    safety,
  };
}

export { MAX_REPAIR_ATTEMPTS };
