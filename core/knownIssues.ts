/**
 * `known_issues.yaml`: exact error texts observed in earlier runs, with a hint
 * the model can use on the next repair attempt.
 *
 * The catalogue is input, not evidence: a matching hint never changes a build
 * verdict, and an entry is only a note about an error that was really observed.
 * Parsing is strict so a typo does not silently turn a hint into a different
 * error.
 */
export interface KnownIssue {
  /** Exact error text to match (substring of the compiler/linker output). */
  error: string;
  /** Advice injected into the model prompt. */
  hint: string;
}

export type KnownIssuesParseResult =
  | { ok: true; issues: KnownIssue[] }
  | { ok: false; errors: string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseKnownIssues(text: string): KnownIssuesParseResult {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    const yaml = (Bun as unknown as { YAML?: { parse(source: string): unknown } }).YAML;
    if (!yaml) return { ok: false, errors: ["YAML support requires Bun >= 1.2.21"] };
    parsed = yaml.parse(text);
  } catch (error) {
    return {
      ok: false,
      errors: [`known_issues.yaml: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  // An empty file is a valid, empty catalogue.
  if (parsed === null || parsed === undefined) return { ok: true, issues: [] };
  if (isObject(parsed) && Array.isArray(parsed.issues)) parsed = parsed.issues;
  if (!Array.isArray(parsed)) {
    return { ok: false, errors: ["known_issues.yaml: must be a list of { error, hint } entries"] };
  }

  const issues: KnownIssue[] = [];
  const seen = new Set<string>();
  parsed.forEach((entry, index) => {
    const at = `known_issues[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (key !== "error" && key !== "hint") errors.push(`${at}.${key}: unknown field`);
    }
    if (typeof entry.error !== "string" || entry.error.trim() === "") {
      errors.push(`${at}.error: must be a non-empty string`);
    }
    if (typeof entry.hint !== "string" || entry.hint.trim() === "") {
      errors.push(`${at}.hint: must be a non-empty string`);
    }
    if (errors.length > 0) return;
    const error = entry.error as string;
    if (seen.has(error)) {
      errors.push(`${at}.error: duplicate exact error text`);
      return;
    }
    seen.add(error);
    issues.push({ error, hint: entry.hint as string });
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, issues };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function formatKnownIssues(issues: readonly KnownIssue[]): string {
  const lines = [
    "# py-bench known issues",
    "# Exact error texts observed in earlier runs. A hint is not evidence.",
  ];
  if (issues.length === 0) {
    lines.push("[]");
  } else {
    for (const issue of issues) {
      lines.push(`- error: ${quote(issue.error)}`);
      lines.push(`  hint: ${quote(issue.hint)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Exact-text de-duplication, preserving the first (usually curated) hint. */
export function mergeKnownIssues(
  existing: readonly KnownIssue[],
  additions: readonly KnownIssue[],
): KnownIssue[] {
  const byError = new Map<string, KnownIssue>();
  for (const issue of [...existing, ...additions]) {
    const error = issue.error.trim();
    if (error === "" || issue.hint.trim() === "") continue;
    if (!byError.has(error)) byError.set(error, { error, hint: issue.hint.trim() });
  }
  return [...byError.values()];
}

/** A factual hint for an error that was observed but not verified as fixed. */
export function failedRunHint(observedAt: string, reason: string): string {
  const cleaned = reason.replace(/\s+/g, " ").trim();
  return `Observed on ${observedAt}; no verified repair is recorded. ${cleaned}`.trim();
}
