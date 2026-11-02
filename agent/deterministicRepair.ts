/**
 * The first repair ring: deterministic diagnoses for the compiler/linker errors
 * that can be recognized without a model.
 *
 * It deliberately does not edit source text directly. Every proposed change is
 * a block edit, validated by `applyBlockEdits` with the profile's declared
 * anchors. A fix that would need to touch an include line outside
 * `// [AI_START_*]` is refused and handed to the model with the reason.
 *
 * Only behavior-preserving mechanical edits are applied:
 *   1. a standard function's missing header from a fixed table;
 *   2. a misspelled identifier with exactly one existing project declaration at
 *      one edit distance (insertion, deletion, substitution or transposition).
 *
 * In particular this ring never invents a function body: an empty stub makes the
 * linker happy without implementing the behavior, so it is never a success.
 */
import {
  applyBlockEdits,
  blockBody,
  type AppliedBlock,
  type BlockEdit,
  type RuleFile,
} from "../core/blockPatch";
import type { KnownIssue } from "../core/knownIssues";

export type { KnownIssue } from "../core/knownIssues";

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
  /** True only for a compiler "implicit declaration of function" diagnostic. */
  implicit?: boolean;
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

/**
 * Fixed table of standard C functions whose declaration is in a standard
 * header. This is not a guess based on the name suffix: only these names are
 * eligible for the deterministic include fix.
 */
const STANDARD_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  // stdio.h
  printf: "stdio.h",
  fprintf: "stdio.h",
  sprintf: "stdio.h",
  snprintf: "stdio.h",
  vprintf: "stdio.h",
  vfprintf: "stdio.h",
  vsnprintf: "stdio.h",
  scanf: "stdio.h",
  fscanf: "stdio.h",
  sscanf: "stdio.h",
  puts: "stdio.h",
  fputs: "stdio.h",
  gets: "stdio.h",
  fgets: "stdio.h",
  putchar: "stdio.h",
  fputc: "stdio.h",
  getchar: "stdio.h",
  fgetc: "stdio.h",
  fopen: "stdio.h",
  fclose: "stdio.h",
  fflush: "stdio.h",
  fread: "stdio.h",
  fwrite: "stdio.h",
  fseek: "stdio.h",
  ftell: "stdio.h",
  rewind: "stdio.h",
  remove: "stdio.h",
  rename: "stdio.h",
  perror: "stdio.h",
  // string.h
  strlen: "string.h",
  strcpy: "string.h",
  strncpy: "string.h",
  strcat: "string.h",
  strncat: "string.h",
  strcmp: "string.h",
  strncmp: "string.h",
  strchr: "string.h",
  strrchr: "string.h",
  strstr: "string.h",
  strtok: "string.h",
  strerror: "string.h",
  strdup: "string.h",
  memset: "string.h",
  memcpy: "string.h",
  memmove: "string.h",
  memcmp: "string.h",
  memchr: "string.h",
  // stdlib.h
  malloc: "stdlib.h",
  calloc: "stdlib.h",
  realloc: "stdlib.h",
  free: "stdlib.h",
  atoi: "stdlib.h",
  atol: "stdlib.h",
  atoll: "stdlib.h",
  strtol: "stdlib.h",
  strtoul: "stdlib.h",
  strtoll: "stdlib.h",
  strtoull: "stdlib.h",
  strtod: "stdlib.h",
  strtof: "stdlib.h",
  abs: "stdlib.h",
  labs: "stdlib.h",
  llabs: "stdlib.h",
  qsort: "stdlib.h",
  bsearch: "stdlib.h",
  rand: "stdlib.h",
  srand: "stdlib.h",
  exit: "stdlib.h",
  abort: "stdlib.h",
  getenv: "stdlib.h",
  system: "stdlib.h",
  // math.h
  sqrt: "math.h",
  sqrtf: "math.h",
  sin: "math.h",
  sinf: "math.h",
  cos: "math.h",
  cosf: "math.h",
  tan: "math.h",
  tanf: "math.h",
  asin: "math.h",
  acos: "math.h",
  atan: "math.h",
  atan2: "math.h",
  pow: "math.h",
  powf: "math.h",
  exp: "math.h",
  expf: "math.h",
  log: "math.h",
  logf: "math.h",
  log10: "math.h",
  floor: "math.h",
  floorf: "math.h",
  ceil: "math.h",
  ceilf: "math.h",
  round: "math.h",
  roundf: "math.h",
  fabs: "math.h",
  fabsf: "math.h",
  fmod: "math.h",
  fmin: "math.h",
  fmax: "math.h",
  // ctype.h
  isalnum: "ctype.h",
  isalpha: "ctype.h",
  isblank: "ctype.h",
  iscntrl: "ctype.h",
  isdigit: "ctype.h",
  isgraph: "ctype.h",
  islower: "ctype.h",
  isprint: "ctype.h",
  ispunct: "ctype.h",
  isspace: "ctype.h",
  isupper: "ctype.h",
  isxdigit: "ctype.h",
  tolower: "ctype.h",
  toupper: "ctype.h",
  // time.h
  time: "time.h",
  clock: "time.h",
  difftime: "time.h",
  mktime: "time.h",
  localtime: "time.h",
  gmtime: "time.h",
  strftime: "time.h",
  // assert.h / errno.h / stdint.h / inttypes.h
  assert: "assert.h",
  errno: "errno.h",
  strerror_r: "string.h",
  // POSIX-ish standard headers sometimes used on embedded hosts.
  read: "unistd.h",
  write: "unistd.h",
  close: "unistd.h",
  sleep: "unistd.h",
  usleep: "unistd.h",
  // stdbool.h and stddef.h expose only types/macros, not functions.
});

/** The fixed table is exported for tests and auditability. */
export const STANDARD_HEADER_FUNCTIONS: Readonly<Record<string, string>> = STANDARD_HEADERS;

const C_KEYWORDS = new Set([
  "auto",
  "break",
  "case",
  "char",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extern",
  "float",
  "for",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "register",
  "restrict",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "struct",
  "switch",
  "typedef",
  "union",
  "unsigned",
  "void",
  "volatile",
  "while",
  "_Alignas",
  "_Alignof",
  "_Atomic",
  "_Bool",
  "_Complex",
  "_Generic",
  "_Imaginary",
  "_Noreturn",
  "_Static_assert",
  "_Thread_local",
]);

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

  const push = (
    kind: CompilerDiagnosticKind,
    raw: string,
    name: string | null,
    detail: string,
    implicit = false,
  ) => {
    const key = `${kind}:${name ?? raw}:${implicit ? "implicit" : ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push({ kind, raw: raw.trim(), name, detail, ...(implicit ? { implicit } : {}) });
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
    const implicit = IMPLICIT_FUNCTION_RE.exec(text);
    if (implicit) {
      const name = cleanName(implicit[1]);
      push(
        "undefined-symbol",
        text,
        name,
        `implicit declaration of ${name ?? "(unknown)"}`,
        true,
      );
      continue;
    }
    const undefinedSymbol = UNDEFINED_RE.exec(text) ?? UNDEFINED_SYMBOL_RE.exec(text);
    if (undefinedSymbol) {
      const name = cleanName(undefinedSymbol[1]);
      push("undefined-symbol", text, name, `undefined symbol ${name ?? "(unknown)"}`);
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

function blocksContaining(
  files: readonly RuleFile[],
  anchors: readonly string[],
  identifier: string,
): { path: string; block: string; body: string }[] {
  const re = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const candidates: { path: string; block: string; body: string }[] = [];
  for (const file of files) {
    for (const block of anchors) {
      const body = blockBody(file.content, block);
      if (body !== null && re.test(codeOnly(body))) candidates.push({ path: file.path, block, body });
    }
  }
  return candidates;
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

function codeOnly(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\r\n]*/g, " ")
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ");
}

function headerAlreadyIncluded(files: readonly RuleFile[], header: string): boolean {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*#\\s*include\\s*[<"]${escaped}[>"]`, "m");
  return files.some((file) => re.test(codeOnly(file.content)));
}

function declaredSymbols(files: readonly RuleFile[]): Set<string> {
  const names = new Set<string>();
  // Function declarations and definitions need a return/type token before the
  // name, so a plain call such as `led_ini();` is not mistaken for a declaration.
  const functions =
    /(?:^|[;}\n])\s*(?:(?:static|extern|inline|const|volatile|unsigned|signed|struct\s+\w+|[A-Za-z_]\w*)\s+|\*+\s*)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:;|\{)/g;
  // Macros and simple object declarations are symbols too. A typo in either is
  // just as mechanical to correct as a function name.
  const macros = /^\s*#\s*define\s+([A-Za-z_]\w*)/gm;
  const objects =
    /(?:^|[;{}\n])\s*(?:(?:extern|static|const|volatile|unsigned|signed|long|short)\s+)*(?:struct\s+\w+|enum\s+\w+|[A-Za-z_]\w*)\s+(?:\*+\s*)*([A-Za-z_]\w*)\s*(?:=|;|\[|,)/g;
  for (const file of files) {
    const code = codeOnly(file.content);
    for (const re of [functions, macros, objects]) {
      for (const match of code.matchAll(re)) {
        const name = match[1];
        if (name && !C_KEYWORDS.has(name)) names.add(name);
      }
    }
  }
  return names;
}

/** True when `a` and `b` are one insertion, deletion, substitution or adjacent swap apart. */
export function isSingleEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;

  if (a.length === b.length) {
    const differences: number[] = [];
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) differences.push(index);
      if (differences.length > 2) return false;
    }
    if (differences.length === 1) return true;
    if (differences.length !== 2) return false;
    const [left, right] = differences as [number, number];
    return right === left + 1 && a[left] === b[right] && a[right] === b[left];
  }

  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let index = 0;
  while (index < shorter.length && shorter[index] === longer[index]) index += 1;
  return shorter.slice(index) === longer.slice(index + 1);
}

type CandidateResult =
  | { kind: "one"; name: string }
  | { kind: "none" }
  | { kind: "ambiguous" };

function singleEditCandidate(symbol: string, files: readonly RuleFile[]): CandidateResult {
  const candidates = [...declaredSymbols(files)]
    .filter((name) => name !== symbol && isSingleEditApart(symbol, name))
    .sort();
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length > 1) return { kind: "ambiguous" };
  return { kind: "one", name: candidates[0]! };
}

function includeFix(
  input: {
    files: readonly RuleFile[];
    anchors: readonly string[];
    diagnostic: CompilerDiagnostic;
  },
): DeterministicRepairResult {
  const symbol = input.diagnostic.name;
  if (!symbol || input.diagnostic.implicit !== true) {
    return notApplied(
      input.files,
      input.diagnostic,
      "a missing header can only be added deterministically for an implicit declaration of a known standard function",
    );
  }
  const header = STANDARD_HEADERS[symbol];
  if (!header) {
    return notApplied(
      input.files,
      input.diagnostic,
      `the function ${symbol} is not in the fixed standard-header table; the model must fix it`,
    );
  }
  const target = chooseEditableBlock(input.files, input.anchors);
  if (!target) {
    return notApplied(
      input.files,
      input.diagnostic,
      `no declared editable block is available for the <${header}> include; the model must fix it`,
    );
  }
  // An include is per translation unit: a header in another file does not make
  // this file's include unnecessary.
  if (headerAlreadyIncluded(input.files.filter((file) => file.path === target.path), header)) {
    return notApplied(
      input.files,
      input.diagnostic,
      `<${header}> is already included in ${target.path}, so adding it again is not a deterministic missing-include fix; the model must fix it`,
    );
  }
  const content = `#include <${header}>\n${target.body.trimEnd()}`.trimEnd();
  const edit: BlockEdit = { path: target.path, block: target.block, content };
  const patched = applyBlockEdits(input.files, [edit], input.anchors);
  if (!patched.ok) {
    return notApplied(
      input.files,
      input.diagnostic,
      `the deterministic <${header}> include was refused by blockPatch: ${patched.failed
        .map((failure) => failure.reason)
        .join("; ")}`,
    );
  }
  return {
    applied: true,
    kind: input.diagnostic.kind,
    files: patched.files,
    appliedBlocks: patched.applied,
    reason: `added #include <${header}> for standard function ${symbol} inside block ${target.block} of ${target.path}`,
    diagnostic: input.diagnostic,
  };
}

function symbolTypoFix(input: {
  files: readonly RuleFile[];
  anchors: readonly string[];
  diagnostic: CompilerDiagnostic;
  attemptedSymbols?: readonly string[];
}): DeterministicRepairResult {
  const symbol = input.diagnostic.name;
  if (!symbol || !/^[A-Za-z_]\w*$/.test(symbol)) {
    return notApplied(input.files, input.diagnostic, "the undefined symbol name is not usable for a typo check");
  }
  if (input.attemptedSymbols?.includes(symbol)) {
    return notApplied(
      input.files,
      input.diagnostic,
      `the deterministic correction for ${symbol} was already attempted and did not fix the build`,
    );
  }

  const match = singleEditCandidate(symbol, input.files);
  if (match.kind === "ambiguous") {
    return notApplied(
      input.files,
      input.diagnostic,
      `more than one existing function is one edit away from ${symbol}; the correction would be ambiguous, so the model must fix it`,
    );
  }
  if (match.kind === "none") {
    return notApplied(
      input.files,
      input.diagnostic,
      `no existing declared function is one edit away from ${symbol}; no deterministic change was applied`,
    );
  }
  const candidate = match.name;

  const targets = blocksContaining(input.files, input.anchors, symbol);
  if (targets.length === 0) {
    return notApplied(
      input.files,
      input.diagnostic,
      `${symbol} does not occur inside a declared editable block; the model must fix it`,
    );
  }

  const edits: BlockEdit[] = targets.map((target) => ({
    path: target.path,
    block: target.block,
    content: target.body.replace(new RegExp(`\\b${symbol}\\b`, "g"), candidate),
  }));
  const patched = applyBlockEdits(input.files, edits, input.anchors);
  if (!patched.ok) {
    return notApplied(
      input.files,
      input.diagnostic,
      `the deterministic correction ${symbol} → ${candidate} was refused by blockPatch: ${patched.failed
        .map((failure) => failure.reason)
        .join("; ")}`,
    );
  }
  const locations = targets.map((target) => `${target.block} of ${target.path}`).join(", ");
  return {
    applied: true,
    kind: input.diagnostic.kind,
    files: patched.files,
    appliedBlocks: patched.applied,
    reason: `corrected the existing function name ${symbol} → ${candidate} inside ${locations}`,
    diagnostic: input.diagnostic,
  };
}

/**
 * Returns a block-scoped fix only for a behavior-preserving mechanical change.
 * It never creates a function body, never adds an arbitrary include, and never
 * edits outside a declared block.
 */
export function deterministicRepair(input: {
  files: readonly RuleFile[];
  anchors: readonly string[];
  diagnostics: readonly CompilerDiagnostic[];
  /** Symbols already attempted in this run, to avoid repeating an unchanged typo fix. */
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
      `adding the missing include ${diagnostic.name ?? ""} would not fix a standard function; the model must make a declared block edit`,
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

  if (diagnostic.implicit === true) {
    return includeFix({ files: input.files, anchors: input.anchors, diagnostic });
  }

  return symbolTypoFix({
    files: input.files,
    anchors: input.anchors,
    diagnostic,
    attemptedSymbols: input.attemptedSymbols,
  });
}
