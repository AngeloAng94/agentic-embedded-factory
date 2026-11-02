/**
 * Block-scoped patching.
 *
 * The model may only replace the text between
 *
 *   // [AI_START_<BLOCK>]
 *   ...
 *   // [AI_END_<BLOCK>]
 *
 * for a block declared in the product profile. Everything outside those markers
 * is copied byte for byte, the marker lines themselves are never rewritten, and
 * a plan with a single invalid edit writes nothing (all-or-nothing).
 */

export type BlockPatchCode =
  | "BLOCK_NOT_DECLARED"
  | "ANCHOR_MISSING"
  | "BLOCK_NESTED"
  | "MARKER_IN_CONTENT"
  | "DUPLICATE_EDIT"
  | "EMPTY_BLOCK"
  | "FILE_NOT_FOUND";

export interface BlockEdit {
  path: string;
  block: string;
  content: string;
}

export interface RuleFile {
  path: string;
  content: string;
}

export interface AppliedBlock {
  path: string;
  block: string;
  content: string;
  previousContent: string;
}

export type BlockEditResult =
  | { ok: true; content: string }
  | { ok: false; code: BlockPatchCode; reason: string };

export type BlockPlanResult =
  | { ok: true; files: RuleFile[]; applied: AppliedBlock[] }
  | { ok: false; failed: { path: string; block: string; code: BlockPatchCode; reason: string }[] };

const MARKER_LINE = /^[ \t]*\/\/[ \t]*\[AI_(START|END)_[A-Z0-9_]+\][ \t]*\r?$/;
const ANY_MARKER = /\[[ \t]*AI_(START|END)_[A-Z0-9_]+[ \t]*\]/;

function markerLine(kind: "START" | "END", block: string): RegExp {
  return new RegExp(`^[ \\t]*//[ \\t]*\\[AI_${kind}_${block}\\][ \\t]*\\r?$`);
}

/** Reads the current body of one declared block, or null when it is not unique. */
export function blockBody(current: string, block: string): string | null {
  const lines = current.split("\n");
  const startRe = markerLine("START", block);
  const endRe = markerLine("END", block);
  const starts = lines.filter((line) => startRe.test(line)).length;
  const ends = lines.filter((line) => endRe.test(line)).length;
  if (starts !== 1 || ends !== 1) return null;
  const start = lines.findIndex((line) => startRe.test(line));
  const end = lines.findIndex((line) => endRe.test(line));
  if (start < 0 || end <= start) return null;
  return lines.slice(start + 1, end).join("\n");
}

/** Applies one edit to one file. Pure: the input string is never mutated. */
export function applyBlockEdit(current: string, block: string, content: string): BlockEditResult {
  if (block.trim() === "") {
    return { ok: false, code: "BLOCK_NOT_DECLARED", reason: "empty block name" };
  }
  // An existing empty block (START and END back to back, as after scaffolding)
  // is perfectly writable: only an empty *new* body is refused, because that
  // would silently delete code.
  if (content.trim() === "") {
    return {
      ok: false,
      code: "EMPTY_BLOCK",
      reason: "the new block body is empty: send the code you want, not an empty string",
    };
  }
  if (ANY_MARKER.test(content)) {
    return {
      ok: false,
      code: "MARKER_IN_CONTENT",
      reason: "content must not contain [AI_START_…]/[AI_END_…] markers: the markers are owned by the file",
    };
  }

  // Line based on purpose: every line outside the block is copied unchanged,
  // including its original line ending.
  const lines = current.split("\n");
  const startRe = markerLine("START", block);
  const endRe = markerLine("END", block);
  const starts: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, index) => {
    if (startRe.test(line)) starts.push(index);
    if (endRe.test(line)) ends.push(index);
  });

  if (starts.length !== 1 || ends.length !== 1) {
    return {
      ok: false,
      code: "ANCHOR_MISSING",
      reason: `expected exactly one [AI_START_${block}] and one [AI_END_${block}], found ${starts.length} start / ${ends.length} end`,
    };
  }

  const [start] = starts as [number];
  const [end] = ends as [number];
  if (end <= start) {
    return {
      ok: false,
      code: "ANCHOR_MISSING",
      reason: `[AI_END_${block}] comes before [AI_START_${block}]`,
    };
  }

  const region = lines.slice(start + 1, end);
  if (region.some((line) => MARKER_LINE.test(line))) {
    return {
      ok: false,
      code: "BLOCK_NESTED",
      reason: `block ${block} contains another AI marker: nested blocks are not allowed`,
    };
  }

  const crlf = current.includes("\r\n");    const body = content.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\n+$/, "");
  const bodyLines = body === "" ? [] : body.split("\n").map((line) => (crlf ? `${line}\r` : line));

  const next = [...lines.slice(0, start + 1), ...bodyLines, ...lines.slice(end)].join("\n");
  return { ok: true, content: next };
}

/**
 * Applies a whole plan. If any edit is invalid, nothing is applied: the caller
 * must not write a single file.
 */
export function applyBlockEdits(
  files: readonly RuleFile[],
  edits: readonly BlockEdit[],
  declaredAnchors: readonly string[],
): BlockPlanResult {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const applied: AppliedBlock[] = [];
  const failed: { path: string; block: string; code: BlockPatchCode; reason: string }[] = [];
  const seen = new Set<string>();

  for (const edit of edits) {
    if (!declaredAnchors.includes(edit.block)) {
      failed.push({
        path: edit.path,
        block: edit.block,
        code: "BLOCK_NOT_DECLARED",
        reason: `block ${edit.block} is not declared in the profile (declared: ${declaredAnchors.join(", ") || "none"})`,
      });
      continue;
    }
    const key = `${edit.path}\u0000${edit.block}`;
    if (seen.has(key)) {
      failed.push({
        path: edit.path,
        block: edit.block,
        code: "DUPLICATE_EDIT",
        reason: "the same block is edited twice in one plan",
      });
      continue;
    }
    seen.add(key);

    const current = byPath.get(edit.path);
    if (current === undefined) {
      failed.push({
        path: edit.path,
        block: edit.block,
        code: "FILE_NOT_FOUND",
        reason: "block edits only apply to existing files: send a create instead",
      });
      continue;
    }

    const outcome = applyBlockEdit(current, edit.block, edit.content);
    if (!outcome.ok) {
      failed.push({ path: edit.path, block: edit.block, code: outcome.code, reason: outcome.reason });
      continue;
    }

    byPath.set(edit.path, outcome.content);
    applied.push({
      path: edit.path,
      block: edit.block,
      content: outcome.content,
      previousContent: current,
    });
  }

  if (failed.length > 0) return { ok: false, failed };

  return {
    ok: true,
    applied,
    files: files.map((file) => ({ path: file.path, content: byPath.get(file.path) ?? file.content })),
  };
}
