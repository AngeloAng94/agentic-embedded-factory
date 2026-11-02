/**
 * The first repair ring: deterministic diagnoses for the compiler/linker errors
 * that can be recognized without a model.
 *
 * It deliberately does not edit source text directly. Every proposed change is
 * a block edit, validated by `applyBlockEdits` with the profile's declared
 * anchors. A fix that would need to touch an include line outside
 * `// [AI_START_*]` is refused and handed to the model with the reason.
 */
import {
  applyBlockEdits,
  blockBody,
  type AppliedBlock,
  type BlockEdit,
  type RuleFile,
} from "../core/blockPatch";

export type CompilerDiagnosticKind =
  | "missing-include"
  | "undefined-symbol"
  | "region-overflow"
  | "incompatible-type";

export interface CompilerDiagnostic {
  kind: CompilerDiagnosticKind;
  /** Exact source line or linker line that produced the diagnosis. */
  raw: string;
  /** Symbol or header the diagnostic names, when present. */
  name: string | null;
  detail: string;
}

export interface KnownIssue {
  /** Exact error text to match (substring of the compiler/linker output). */
  error: string;
  /** Advice injected into the model prompt. */
  hint: string;
}

export interface DeterministicRepairResult {
  applied: boolean;
  kind: CompilerDiagnosticKind | null;
  files: RuleFile[];
  appliedBlocks: AppliedBlock[];
  reason: string;
  diagnostic: CompilerDiagnostic | null;
}

const INCLUDE_RE = /fatal error:\s*([^:\n]+):\s*No such file or directory/i;
const INCLUDE_ALT_RE = /(?:fatal error:|error:)\s*([^:\n]+):\s*file not found/i;
const UNDEFINED_RE = /undefined reference to [`'"]?([^`'"\s]+)[`'"]?/i;
const UNDEFINED_SYMBOL_RE = /undefined symbol:?\s*[`'"]?([^`'"\s]+)[`'"]?/i;
const IMPLICIT_FUNCTION_RE = /implicit declaration of function [`'"]?([^`'"\s]+)[`'"]?/i;
const REGION_RE = /(?:region|section)\s+[`'"]?([^`'"\s]+)[`'"]?\s+(?:overflowed|will not fit)/i;
const OVERFLOW_RE = /overflowed by\s+(\d+)\s+bytes/i;
const INCOMPATIBLE_RE =
  /incompatible type|conflicting types|makes pointer from integer|from incompatible/i;

function cleanName(value: string | undefined): string | null {
  const name = value?.trim().replace(/[`'"]/g, "");
  return name && name.length > 0 ? name : null;
}

/**
 * Recognizes common errors in a deterministic priority order. The first
 * diagnostic is the one the repair ring reasons about; all are retained for
 * logging and tests.
 */
export function parseCompilerDiagnostics(
  stderr: string,
  stdout = "",
): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  const seen = new Set<string>();
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/);

  const push = (kind: CompilerDiagnosticKind, raw: string, name: string | null, detail: string) => {
    const key = `${kind}:${name ?? raw}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push({ kind, raw: raw.trim(), name, detail });
  };

  for (const line of lines) {
    const text = line.trim();
    if (text === "") continue;
    const include = INCLUDE_RE.exec(text) ?? INCLUDE_ALT_RE.exec(text);
    if (include) {
      const name = cleanName(include[1]);
      push("missing-include", text, name, `missing include ${name ?? "(unknown)"}`);
      continue;
    }
    const undefinedSymbol = UNDEFINED_RE.exec(text) ?? UNDEFINED_SYMBOL_RE.exec(text);
    if (undefinedSymbol) {
      const name = cleanName(undefinedSymbol[1]);
      push("undefined-symbol", text, name, `undefined symbol ${name ?? "(unknown)"}`);
      continue;
    }
    const implicit = IMPLICIT_FUNCTION_RE.exec(text);
    if (implicit) {
      const name = cleanName(implicit[1]);
      push("undefined-symbol", text, name, `implicit declaration of ${name ?? "(unknown)"}`);
      continue;
    }
    if (REGION_RE.test(text) || OVERFLOW_RE.test(text)) {
      const region = REGION_RE.exec(text);
      const overflow = OVERFLOW_RE.exec(text);
      push(
        "region-overflow",
        text,
        cleanName(region?.[1]),
        overflow ? `region overflowed by ${overflow[1]} bytes` : "a section does not fit its region",
      );
      continue;
    }
    if (INCOMPATIBLE_RE.test(text)) {
      push("incompatible-type", text, null, "incompatible C type in the compiler output");
    }
  }

  const priority: CompilerDiagnosticKind[] = [
    "missing-include",
    "undefined-symbol",
    "region-overflow",
    "incompatible-type",
  ];
  return diagnostics.sort((left, right) => {
    const byKind = priority.indexOf(left.kind) - priority.indexOf(right.kind);
    return byKind !== 0 ? byKind : left.raw.localeCompare(right.raw);
  });
}

/** Exact-text matching, as required for a known-issue catalogue. */
export function matchKnownIssues(
  errorText: string,
  issues: readonly KnownIssue[] | undefined,
): KnownIssue[] {
  if (!issues || issues.length === 0) return [];
  return issues.filter((issue) => issue.error.trim() !== "" && errorText.includes(issue.error));
}

function chooseEditableBlock(
  files: readonly RuleFile[],
  anchors: readonly string[],
): { path: string; block: string; body: string } | null {
  const candidates: { path: string; block: string; body: string }[] = [];
  for (const file of files) {
    for (const block of anchors) {
      const body = blockBody(file.content, block);
      if (body !== null) candidates.push({ path: file.path, block, body });
    }
  }
  return candidates.find((candidate) => candidate.block === "APP") ?? candidates[0] ?? null;
}

function notApplied(
  files: readonly RuleFile[],
  diagnostic: CompilerDiagnostic | null,
  reason: string,
): DeterministicRepairResult {
  return {
    applied: false,
    kind: diagnostic?.kind ?? null,
    files: files.map((file) => ({ ...file })),
    appliedBlocks: [],
    reason,
    diagnostic,
  };
}

/**
 * Returns a block-scoped fix only for an undefined symbol, using the first
 * declared editable block. It never creates a file or edits outside a block.
 * Other recognized errors are explained and left to the model.
 */
export function deterministicRepair(input: {
  files: readonly RuleFile[];
  anchors: readonly string[];
  diagnostics: readonly CompilerDiagnostic[];
  /** Symbols already attempted in this run, to avoid an endless stub loop. */
  attemptedSymbols?: readonly string[];
}): DeterministicRepairResult {
  const diagnostic = input.diagnostics[0] ?? null;
  if (!diagnostic) {
    return notApplied(input.files, null, "no recognized compiler/linker error for a deterministic repair");
  }

  if (diagnostic.kind === "missing-include") {
    return notApplied(
      input.files,
      diagnostic,
      `adding the missing include ${diagnostic.name ?? ""} would touch source outside the marked blocks; the model must make a declared block edit`,
    );
  }
  if (diagnostic.kind === "region-overflow") {
    return notApplied(
      input.files,
      diagnostic,
      "a region overflow needs a linker/layout change outside the editable blocks; the model must fix it",
    );
  }
  if (diagnostic.kind === "incompatible-type") {
    return notApplied(
      input.files,
      diagnostic,
      "an incompatible type cannot be fixed safely by a deterministic block edit; the model must fix it",
    );
  }

  const symbol = diagnostic.name;
  if (!symbol || !/^[A-Za-z_]\w*$/.test(symbol)) {
    return notApplied(input.files, diagnostic, "the undefined symbol name is not usable for a stub");
  }
  if (input.attemptedSymbols?.includes(symbol)) {
    return notApplied(
      input.files,
      diagnostic,
      `the deterministic stub for ${symbol} was already attempted and did not fix the build`,
    );
  }

  const target = chooseEditableBlock(input.files, input.anchors);
  if (!target) {
    return notApplied(
      input.files,
      diagnostic,
      `no declared editable block is available for the ${symbol} stub; the model must fix it`,
    );
  }

  const stub = `void ${symbol}(void) {}`;
  const content = target.body.trimEnd() === "" ? stub : `${target.body.trimEnd()}\n\n${stub}`;
  const edit: BlockEdit = { path: target.path, block: target.block, content };
  const patched = applyBlockEdits(input.files, [edit], input.anchors);
  if (!patched.ok) {
    return notApplied(
      input.files,
      diagnostic,
      `the deterministic ${symbol} stub was refused by blockPatch: ${patched.failed.map((failure) => failure.reason).join("; ")}`,
    );
  }

  return {
    applied: true,
    kind: diagnostic.kind,
    files: patched.files,
    appliedBlocks: patched.applied,
    reason: `added a deterministic stub for ${symbol} inside block ${target.block} of ${target.path}`,
    diagnostic,
  };
}
