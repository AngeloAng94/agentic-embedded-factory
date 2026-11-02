/**
 * Unified diff parsing + application.
 *
 * The agent must edit files with patches, not by rewriting whole files.
 * A patch is validated *before* anything is written; when it cannot be applied
 * exactly, the caller receives `PATCH_FAILED` and the file on disk is untouched.
 */

export type PatchFailure = { ok: false; code: "PATCH_FAILED"; reason: string };
export type PatchSuccess = { ok: true; content: string };
export type PatchOutcome = PatchSuccess | PatchFailure;

interface HunkLine {
  kind: "context" | "add" | "del";
  text: string;
  /** 1-based line number in the hunk, used for error messages. */
  line: number;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

export interface ParsedDiff {
  filePath: string | null;
  hunks: Hunk[];
}

function stripPrefix(path: string): string {
  const trimmed = path.trim().replace(/^"(.*)"$/, "$1");
  if (trimmed === "/dev/null") return "/dev/null";
  return trimmed.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(
  diff: string,
): { ok: true; parsed: ParsedDiff } | PatchFailure {
  if (typeof diff !== "string" || diff.trim() === "") {
    return { ok: false, code: "PATCH_FAILED", reason: "empty diff" };
  }

  const rawLines = diff.replace(/\r\n/g, "\n").split("\n");
  const hunks: Hunk[] = [];
  let filePath: string | null = null;
  let index = 0;

  while (index < rawLines.length && !rawLines[index].startsWith("@@")) {
    const line = rawLines[index];
    if (line.startsWith("+++")) {
      const candidate = stripPrefix(line.slice(3));
      if (candidate !== "/dev/null") filePath = candidate;
    }
    index += 1;
  }

  while (index < rawLines.length) {
    const header = rawLines[index];
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (!match) {
      index += 1;
      continue;
    }

    const hunk: Hunk = {
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
      lines: [],
    };

    index += 1;
    while (index < rawLines.length) {
      const line = rawLines[index];
      if (line.startsWith("@@") || line.startsWith("--- ") || line.startsWith("+++ "))
        break;
      if (line.startsWith("\\")) {
        // "\ No newline at end of file" marker: informational only.
        index += 1;
        continue;
      }
      if (line === "" && hunk.lines.length === 0) break;
      const prefix = line[0];
      if (prefix === " " || prefix === "-" || prefix === "+") {
        hunk.lines.push({
          kind: prefix === " " ? "context" : prefix === "-" ? "del" : "add",
          text: line.slice(1),
          line: index + 1,
        });
      } else if (prefix === "\t") {
        hunk.lines.push({ kind: "context", text: line.slice(1), line: index + 1 });
      }
      index += 1;
    }
    hunks.push(hunk);
  }

  if (hunks.length === 0) {
    return {
      ok: false,
      code: "PATCH_FAILED",
      reason: "diff contains no @@ hunk",
    };
  }

  return { ok: true, parsed: { filePath, hunks } };
}

export function applyUnifiedDiff(original: string, diff: string): PatchOutcome {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) return parsed;

  const { hunks } = parsed.parsed;
  const sourceLines = original.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (start < cursor) {
      return {
        ok: false,
        code: "PATCH_FAILED",
        reason: `hunk at line ${hunk.oldStart} overlaps a previous hunk`,
      };
    }
    if (start > sourceLines.length) {
      return {
        ok: false,
        code: "PATCH_FAILED",
        reason: `hunk starts at line ${hunk.oldStart} but the file only has ${sourceLines.length} lines`,
      };
    }

    while (cursor < start) {
      output.push(sourceLines[cursor]);
      cursor += 1;
    }

    for (const entry of hunk.lines) {
      if (entry.kind === "add") {
        output.push(entry.text);
        continue;
      }
      const actual = sourceLines[cursor];
      if (actual === undefined) {
        return {
          ok: false,
          code: "PATCH_FAILED",
          reason: `expected "${truncate(entry.text)}" at line ${cursor + 1} but the file ended`,
        };
      }
      if (actual !== entry.text) {
        return {
          ok: false,
          code: "PATCH_FAILED",
          reason: `context mismatch at line ${cursor + 1}: expected "${truncate(entry.text)}" found "${truncate(actual)}"`,
        };
      }
      if (entry.kind === "context") output.push(actual);
      cursor += 1;
    }
  }

  while (cursor < sourceLines.length) {
    output.push(sourceLines[cursor]);
    cursor += 1;
  }

  return { ok: true, content: output.join("\n") };
}

function truncate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

/**
 * Produces a valid unified diff between two revisions of the same file.
 * Not minimal (single hunk with common prefix/suffix trimming) but exact.
 */
export function formatUnifiedDiff(
  path: string,
  before: string,
  after: string,
): string {
  const beforeLines = before.replace(/\r\n/g, "\n").split("\n");
  const afterLines = after.replace(/\r\n/g, "\n").split("\n");

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const context = 3;
  const start = Math.max(0, prefix - context);
  const beforeEnd = beforeLines.length - suffix + context;
  const afterEnd = afterLines.length - suffix + context;

  const removed = beforeLines.slice(start, Math.min(beforeEnd, beforeLines.length));
  const added = afterLines.slice(start, Math.min(afterEnd, afterLines.length));

  const hunkLines: string[] = [];
  let index = 0;
  while (
    index < removed.length &&
    index < added.length &&
    removed[index] === added[index]
  ) {
    hunkLines.push(` ${removed[index]}`);
    index += 1;
  }
  let tail = 0;
  while (
    tail < removed.length - index &&
    tail < added.length - index &&
    removed[removed.length - 1 - tail] === added[added.length - 1 - tail]
  ) {
    tail += 1;
  }
  const delCount = removed.length - index - tail;
  const addCount = added.length - index - tail;
  for (let i = 0; i < delCount; i += 1) hunkLines.push(`-${removed[index + i]}`);
  for (let i = 0; i < addCount; i += 1) hunkLines.push(`+${added[index + i]}`);
  for (let i = 0; i < tail; i += 1)
    hunkLines.push(` ${removed[removed.length - tail + i]}`);

  const oldCount = removed.length;
  const newCount = added.length;
  const oldStart = oldCount === 0 ? start : start + 1;
  const newStart = newCount === 0 ? start : start + 1;

  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...hunkLines,
  ].join("\n");
}
