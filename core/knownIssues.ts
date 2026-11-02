/**
 * `known_issues.yaml`: exact error texts observed in earlier runs, with a hint
 * the model can use on the next repair attempt.
 *
 * The catalogue is input, not evidence: a matching hint never changes a build
 * verdict, and an entry is only a note about an error that was really observed.
 * Parsing is strict so a typo does not silently turn a hint into a different
 * error.
 *
 * A run never edits the catalogue. It can only append a proposal to
 * `known_issues.pending.yaml`; moving a proposal into this catalogue requires
 * the explicit human approval command in `tools/knownIssues/index.ts`.
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

export interface KnownIssueProposal {
  /** Exact error text observed in the failed run. */
  error: string;
  /** Factual context: attempt, command/result and stop reason. */
  context: string;
  /** The run that observed the error. */
  runId: string;
}

export type KnownIssueProposalsParseResult =
  | { ok: true; proposals: KnownIssueProposal[] }
  | { ok: false; errors: string[] };

export type KnownIssueProposalSelector =
  | { all: true }
  | { index: number }
  | { runId: string };

export type KnownIssueApprovalResult =
  | {
      ok: true;
      catalog: KnownIssue[];
      remaining: KnownIssueProposal[];
      approved: KnownIssueProposal[];
    }
  | { ok: false; reason: string };

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
    "# Only explicit human approval adds entries; failed runs append proposals to known_issues.pending.yaml.",
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

export function parseKnownIssueProposals(text: string): KnownIssueProposalsParseResult {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    const yaml = (Bun as unknown as { YAML?: { parse(source: string): unknown } }).YAML;
    if (!yaml) return { ok: false, errors: ["YAML support requires Bun >= 1.2.21"] };
    parsed = yaml.parse(text);
  } catch (error) {
    return {
      ok: false,
      errors: [
        `known_issues.pending.yaml: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  if (parsed === null || parsed === undefined) return { ok: true, proposals: [] };
  if (isObject(parsed) && Array.isArray(parsed.proposals)) parsed = parsed.proposals;
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      errors: ["known_issues.pending.yaml: must be a list of { error, context, run_id } entries"],
    };
  }

  const proposals: KnownIssueProposal[] = [];
  const seen = new Set<string>();
  parsed.forEach((entry, index) => {
    const at = `known_issues.pending[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (key !== "error" && key !== "context" && key !== "run_id" && key !== "runId") {
        errors.push(`${at}.${key}: unknown field`);
      }
    }
    if (entry.run_id !== undefined && entry.runId !== undefined) {
      errors.push(`${at}: use either run_id or runId, not both`);
    }
    const runId = entry.run_id ?? entry.runId;
    if (typeof entry.error !== "string" || entry.error.trim() === "") {
      errors.push(`${at}.error: must be a non-empty string`);
    }
    if (typeof entry.context !== "string" || entry.context.trim() === "") {
      errors.push(`${at}.context: must be a non-empty string`);
    }
    if (typeof runId !== "string" || runId.trim() === "") {
      errors.push(`${at}.run_id: must be a non-empty string`);
    }
    if (errors.length > 0) return;
    const proposal = {
      error: entry.error as string,
      context: entry.context as string,
      runId: runId as string,
    };
    const key = `${proposal.runId}\u0000${proposal.error}`;
    if (seen.has(key)) {
      errors.push(`${at}: duplicate proposal for the same run and exact error`);
      return;
    }
    seen.add(key);
    proposals.push(proposal);
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, proposals };
}

export function formatKnownIssueProposals(proposals: readonly KnownIssueProposal[]): string {
  const lines = [
    "# py-bench pending known issues",
    "# Proposals only: these entries are NOT used until a human approves them.",
    "# Approve with: bun run known-issues:approve --all",
  ];
  if (proposals.length === 0) {
    lines.push("[]");
  } else {
    for (const proposal of proposals) {
      lines.push(`- error: ${quote(proposal.error)}`);
      lines.push(`  context: ${quote(proposal.context)}`);
      lines.push(`  run_id: ${quote(proposal.runId)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** De-duplicates proposals by run and exact error, preserving the first context. */
export function mergeKnownIssueProposals(
  existing: readonly KnownIssueProposal[],
  additions: readonly KnownIssueProposal[],
): KnownIssueProposal[] {
  const byKey = new Map<string, KnownIssueProposal>();
  for (const proposal of [...existing, ...additions]) {
    const error = proposal.error.trim();
    const context = proposal.context.trim();
    const runId = proposal.runId.trim();
    if (error === "" || context === "" || runId === "") continue;
    const key = `${runId}\u0000${error}`;
    if (!byKey.has(key)) byKey.set(key, { error, context, runId });
  }
  return [...byKey.values()];
}

/**
 * Explicit approval: selects pending proposals, merges them into the catalogue
 * and returns the proposals that were not approved. It is never called by the
 * orchestrator or the model.
 */
export function approveKnownIssueProposals(input: {
  catalog: readonly KnownIssue[];
  pending: readonly KnownIssueProposal[];
  selector: KnownIssueProposalSelector;
  hint?: string;
}): KnownIssueApprovalResult {
  const selected: KnownIssueProposal[] = [];
  const remaining: KnownIssueProposal[] = [];
  input.pending.forEach((proposal, index) => {
    const matches =
      "all" in input.selector
        ? true
        : "index" in input.selector
          ? input.selector.index === index + 1
          : proposal.runId === input.selector.runId;
    if (matches) selected.push(proposal);
    else remaining.push(proposal);
  });
  if (selected.length === 0) {
    const reason =
      "index" in input.selector
        ? `no pending proposal at index ${input.selector.index}`
        : "runId" in input.selector
          ? `no pending proposal for run ${input.selector.runId}`
          : "there are no pending proposals";
    return { ok: false, reason };
  }
  const hint = input.hint?.trim();
  const additions = selected.map((proposal) => ({
    error: proposal.error,
    hint: hint || proposal.context.trim(),
  }));
  return {
    ok: true,
    catalog: mergeKnownIssues(input.catalog, additions),
    remaining,
    approved: selected,
  };
}
