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

export interface AgentPatch {
  path: string;
  diff: string;
}

export interface AgentPlan {
  summary: string;
  creates: AgentCreate[];
  patches: AgentPatch[];
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
  "patches": [{ "path": "src/main.c", "diff": "--- a/src/main.c\\n+++ b/src/main.c\\n@@ -1,4 +1,6 @@\\n context\\n-removed\\n+added" }],
  "requestBuild": true,
  "answerOnly": false
}

Rules:
- Existing files MUST be edited with "patches" (unified diff with 3 lines of context).
  Context lines must match the current file byte for byte: a wrong patch is REJECTED.
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
}): string {
  const fileBlock = input.files
    .map((file) => `--- BEGIN ${file.path} ---\n${file.content}\n--- END ${file.path} ---`)
    .join("\n\n");

  const sections: string[] = [];
  sections.push(`PROJECT: ${input.project.name}`);
  sections.push(`RTOS: ${input.project.rtos}`);
  sections.push(`BOARD: ${input.project.board ?? "unspecified"}`);
  sections.push(`MCU: ${input.project.mcu ?? "unspecified"}`);
  if (input.attempt > 1) {
    sections.push(`REPAIR ATTEMPT: ${input.attempt} of ${MAX_REPAIR_ATTEMPTS}`);
  }
  if (input.knowledge.trim() !== "") {
    sections.push(`RELEVANT KNOWLEDGE BASE FRAGMENTS:\n${input.knowledge}`);
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

  const patches: AgentPatch[] = [];
  const rawPatches = Array.isArray(record.patches) ? record.patches : [];
  for (const entry of rawPatches) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== "string") continue;
    const diff =
      typeof item.diff === "string"
        ? item.diff
        : typeof item.patch === "string"
          ? item.patch
          : null;
    if (!diff) continue;
    patches.push({ path: item.path, diff });
  }

  const plan: AgentPlan = {
    summary,
    creates,
    patches,
    requestBuild: record.requestBuild === undefined ? true : Boolean(record.requestBuild),
    answerOnly: Boolean(record.answerOnly),
  };

  if (summary === "" && creates.length === 0 && patches.length === 0 && !plan.answerOnly) {
    return {
      ok: false,
      code: "PLAN_EMPTY",
      reason: "the model answered with neither a summary, a create, a patch nor answerOnly",
    };
  }
  if (!plan.answerOnly && creates.length === 0 && patches.length === 0) {
    plan.answerOnly = true;
  }

  return { ok: true, plan };
}

export function describePlan(plan: AgentPlan): string {
  const parts: string[] = [];
  if (plan.creates.length > 0)
    parts.push(`${plan.creates.length} file(s) created: ${plan.creates.map((c) => c.path).join(", ")}`);
  if (plan.patches.length > 0)
    parts.push(`${plan.patches.length} patch(es): ${plan.patches.map((p) => p.path).join(", ")}`);
  if (parts.length === 0) parts.push("no file change");
  return parts.join(" · ");
}
