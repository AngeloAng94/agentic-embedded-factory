import type { BuildResult, ProjectLike } from "./types";
import { formatBuildReport, MAX_REPAIR_ATTEMPTS } from "./buildStatus";

/**
 * The wire protocol between EmbedFactory and the language model.
 *
 * The model answers with a single JSON object describing a *plan* made of
 * patches (unified diffs) and file creations. Whole-file rewrites of existing
 * files are rejected downstream, so the model cannot silently clobber code.
 */

export interface AgentCreate {
  path: string;
  content: string;
}

export interface AgentEdit {
  path: string;
  /** Block declared in the product profile, e.g. APP for [AI_START_APP]. */
  block: string;
  /** Complete new body of the block, without marker lines. */
  content: string;
}

export interface AgentPlan {
  summary: string;
  creates: AgentCreate[];
  edits: AgentEdit[];
  requestBuild: boolean;
  /** True when the model only answered a question. */
  answerOnly: boolean;
}

export type PlanParseResult =
  | { ok: true; plan: AgentPlan }
  | { ok: false; code: "LLM_BAD_RESPONSE" | "PLAN_EMPTY"; reason: string };

export const AGENT_SYSTEM_PROMPT = `You are an embedded firmware engineer working inside a repository.
You MUST answer with a single JSON object and nothing else (no markdown fence, no prose).

JSON shape:
{
  "summary": "short explanation of what you changed and why",
  "creates": [{ "path": "src/foo.c", "content": "complete new file content" }],
  "edits": [{ "path": "src/main.c", "block": "APP", "content": "new body of the block" }],
  "requestBuild": true,
  "answerOnly": false
}

Rules:
- Existing files are edited ONLY with "edits", inside the marked block:
    // [AI_START_APP]
    ...body replaced by your "content"...
    // [AI_END_APP]
  "content" is the complete new body of that block. Never include the marker lines.
- The block must be one of the EDITABLE BLOCKS listed in the prompt: an undeclared
  block is rejected and nothing is written.
- Code outside the markers is not yours: it cannot be changed and any marker you
  emit is rejected.
- Unified diffs are NOT accepted.
- Use "creates" only for files that do not exist yet.
- Never use paths outside: src/, include/, drivers/, app/, tests/, boards/, scripts/,
  or the root files CMakeLists.txt, prj.conf, Kconfig, west.yml, README.md, .gitignore.
- Prefer static allocation; avoid malloc/free in real-time paths.
- Keep ISRs short and use FromISR APIs; never block inside an ISR.
- If the user only asked a question, set "answerOnly": true and leave the arrays empty.
- ${MAX_REPAIR_ATTEMPTS} automatic repair attempts are allowed after a failed build.`;

export function buildTurnPrompt(input: {
  project: ProjectLike;
  files: { path: string; content: string }[];
  knowledge: string;
  userRequest: string;
  buildResult?: BuildResult | null;
  attempt: number;
  previousPatches?: string[];
  /** Block names the model may edit, from the product profile. */
  anchors?: string[];
  /** Known issues/parser diagnosis to include with the compiler error. */
  repairContext?: string;
}): string {
  const fileBlock = input.files
    .map((file) => `--- BEGIN ${file.path} ---\n${file.content}\n--- END ${file.path} ---`)
    .join("\n\n");

  const sections: string[] = [];
  sections.push(`PROJECT: ${input.project.name}`);
  sections.push(`RTOS: ${input.project.rtos}`);
  sections.push(`BOARD: ${input.project.board ?? "unspecified"}`);
  sections.push(`MCU: ${input.project.mcu ?? "unspecified"}`);
  sections.push(`EDITABLE BLOCKS: ${input.anchors && input.anchors.length > 0 ? input.anchors.join(", ") : "(none)"}`);
  if (input.attempt > 1) {
    sections.push(`REPAIR ATTEMPT: ${input.attempt} of ${MAX_REPAIR_ATTEMPTS}`);
  }
  if (input.knowledge.trim() !== "") {
    sections.push(`RELEVANT KNOWLEDGE BASE FRAGMENTS:\n${input.knowledge}`);
  }
  if (input.repairContext?.trim()) {
    sections.push(`KNOWN ISSUES / REPAIR CONTEXT:\n${input.repairContext.trim()}`);
  }
  sections.push(`CURRENT FILES:\n${fileBlock || "(empty repository)"}`);
  if (input.previousPatches && input.previousPatches.length > 0) {
    sections.push(`PREVIOUSLY APPLIED PATCHES:\n${input.previousPatches.join("\n\n")}`);
  }
  if (input.buildResult) {
    sections.push(
      `LAST BUILD RESULT (real compiler output, fix the errors):\n${formatBuildReport(input.buildResult)}`,
    );
  }
  sections.push(`USER REQUEST:\n${input.userRequest}`);
  if (input.buildResult && input.buildResult.verdict === "FAILURE") {
    sections.push(
      "The build failed. Produce patches that fix the compiler errors above. Do not restate the whole file.",
    );
  }
  return sections.join("\n\n");
}

/** Extracts the first balanced JSON object from a model answer. */
export function extractJsonObject(text: string): string | null {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export function parseAgentResponse(text: string): PlanParseResult {
  const json = extractJsonObject(text);
  if (!json) {
    return {
      ok: false,
      code: "LLM_BAD_RESPONSE",
      reason: "no JSON object found in the model answer",
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      code: "LLM_BAD_RESPONSE",
      reason: `invalid JSON in the model answer: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (typeof raw !== "object" || raw === null) {
    return { ok: false, code: "LLM_BAD_RESPONSE", reason: "JSON root is not an object" };
  }

  const record = raw as Record<string, unknown>;
  const summary =
    typeof record.summary === "string" && record.summary.trim() !== ""
      ? record.summary
      : typeof record.message === "string" && record.message.trim() !== ""
        ? record.message
        : "";

  const creates: AgentCreate[] = [];
  const rawCreates = Array.isArray(record.creates)
    ? record.creates
    : Array.isArray(record.files)
      ? record.files
      : [];
  for (const entry of rawCreates) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== "string" || typeof item.content !== "string") continue;
    creates.push({ path: item.path, content: item.content });
  }

  const edits: AgentEdit[] = [];
  const rawEdits = Array.isArray(record.edits) ? record.edits : [];
  for (const entry of rawEdits) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (
      typeof item.path !== "string" ||
      typeof item.block !== "string" ||
      typeof item.content !== "string"
    ) {
      continue;
    }
    edits.push({ path: item.path, block: item.block, content: item.content });
  }

  // Unified diffs were replaced by block edits: refuse them loudly instead of
  // silently ignoring a plan the model thought it had sent.
  const retiredPatches = Array.isArray(record.patches) ? record.patches : [];
  if (retiredPatches.length > 0) {
    return {
      ok: false,
      code: "LLM_BAD_RESPONSE",
      reason:
        'unified diffs are not accepted: edit an existing file with "edits" inside a [AI_START_<block>] marker',
    };
  }

  const plan: AgentPlan = {
    summary,
    creates,
    edits,
    requestBuild: record.requestBuild === undefined ? true : Boolean(record.requestBuild),
    answerOnly: Boolean(record.answerOnly),
  };

  if (summary === "" && creates.length === 0 && edits.length === 0 && !plan.answerOnly) {
    return {
      ok: false,
      code: "PLAN_EMPTY",
      reason: "the model answered with neither a summary, a create, an edit nor answerOnly",
    };
  }
  if (!plan.answerOnly && creates.length === 0 && edits.length === 0) {
    plan.answerOnly = true;
  }

  return { ok: true, plan };
}

export function describePlan(plan: AgentPlan): string {
  const parts: string[] = [];
  if (plan.creates.length > 0)
    parts.push(`${plan.creates.length} file(s) created: ${plan.creates.map((c) => c.path).join(", ")}`);
  if (plan.edits.length > 0)
    parts.push(
      `${plan.edits.length} block edit(s): ${plan.edits.map((edit) => `${edit.path}#${edit.block}`).join(", ")}`,
    );
  if (parts.length === 0) parts.push("no file change");
  return parts.join(" · ");
}
