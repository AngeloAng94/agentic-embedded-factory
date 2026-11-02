#!/usr/bin/env bun
/**
 * Explicit human approval for pending known issues.
 *
 * A run never edits `known_issues.yaml`; it only appends observations to
 * `.pokayoke/known_issues.pending.yaml`. This command is the deliberate step
 * that moves selected proposals into the approved catalogue:
 *
 *   bun run known-issues:approve --all
 *   bun run known-issues:approve --index 1
 *   bun run known-issues:approve --run-id run-123
 *
 * `--hint` can replace the proposal context with a curated hint. Without it,
 * the observed context is retained as the catalogue hint.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  approveKnownIssueProposals,
  formatKnownIssueProposals,
  formatKnownIssues,
  parseKnownIssueProposals,
  parseKnownIssues,
  type KnownIssueProposalSelector,
} from "../../core/knownIssues";

interface ApprovalArgs {
  dir: string;
  catalogPath: string;
  pendingPath: string;
  selector: KnownIssueProposalSelector | null;
  hint: string | null;
  json: boolean;
}

function parseArgs(argv: string[]): ApprovalArgs {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = "true";
    }
  }

  if (flags.index !== undefined) {
    const index = Number(flags.index);
    if (!Number.isInteger(index) || index < 1) {
      throw new Error("--index must be a positive integer");
    }
  }
  const dir = path.resolve(flags.dir ?? process.cwd());
  const selectors = [
    flags.all === "true" ? { all: true as const } : null,
    flags.index !== undefined ? { index: Number(flags.index) } : null,
    flags["run-id"] !== undefined ? { runId: flags["run-id"] } : null,
  ].filter((selector): selector is KnownIssueProposalSelector => selector !== null);
  if (selectors.length > 1) {
    throw new Error("choose exactly one selector: --all, --run-id or --index");
  }

  return {
    dir,
    catalogPath: path.resolve(dir, flags.catalog ?? "known_issues.yaml"),
    pendingPath: path.resolve(
      dir,
      flags.pending ?? path.join(".pokayoke", "known_issues.pending.yaml"),
    ),
    selector: selectors[0] ?? null,
    hint: flags.hint ?? null,
    json: flags.json === "true",
  };
}

function emit(payload: unknown, json: boolean, human: string[]): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${human.join("\n")}\n`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.selector) {
    throw new Error("an explicit selector is required: --all, --run-id <id> or --index <n>");
  }
  if (!existsSync(args.pendingPath)) {
    throw new Error(`no pending proposals at ${args.pendingPath}`);
  }

  const pendingParsed = parseKnownIssueProposals(readFileSync(args.pendingPath, "utf8"));
  if (!pendingParsed.ok) {
    throw new Error(pendingParsed.errors.join("; "));
  }
  const catalogParsed = existsSync(args.catalogPath)
    ? parseKnownIssues(readFileSync(args.catalogPath, "utf8"))
    : { ok: true as const, issues: [] };
  if (!catalogParsed.ok) {
    throw new Error(catalogParsed.errors.join("; "));
  }

  const approved = approveKnownIssueProposals({
    catalog: catalogParsed.issues,
    pending: pendingParsed.proposals,
    selector: args.selector,
    hint: args.hint ?? undefined,
  });
  if (!approved.ok) throw new Error(approved.reason);

  mkdirSync(path.dirname(args.catalogPath), { recursive: true });
  writeFileSync(args.catalogPath, formatKnownIssues(approved.catalog), "utf8");
  writeFileSync(
    args.pendingPath,
    formatKnownIssueProposals(approved.remaining),
    "utf8",
  );

  emit(
    {
      ok: true,
      approved: approved.approved.length,
      remaining: approved.remaining.length,
      catalog: args.catalogPath,
      pending: args.pendingPath,
    },
    args.json,
    [
      `approved ${approved.approved.length} proposal(s); ${approved.remaining.length} remain pending`,
      `catalogue: ${args.catalogPath}`,
      `pending:   ${args.pendingPath}`,
    ],
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
