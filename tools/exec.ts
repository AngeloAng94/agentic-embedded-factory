/**
 * Process execution for the native tools.
 *
 * No shell: commands are argument arrays, so a profile cannot inject `&&` or
 * quotes into a build. The binary resolver is injectable so tests can prove the
 * NOT_AVAILABLE path without depending on what is installed on the machine.
 */

export interface ExecResult {
  argv: string[];
  display: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export type BinaryResolver = (binary: string) => string | null;

/** Real PATH lookup. */
export const systemResolver: BinaryResolver = (binary) => Bun.which(binary);

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Splits a profile command line, honouring single and double quotes. */
export function tokenize(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let pending = false;

  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      pending = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (pending || current !== "") {
        argv.push(current);
        current = "";
        pending = false;
      }
      continue;
    }
    current += char;
  }

  if (pending || current !== "") argv.push(current);
  return argv;
}

export function runCommand(argv: string[], options: ExecOptions = {}): ExecResult {
  const started = performance.now();
  const proc = Bun.spawnSync(argv, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  const stdout = proc.stdout?.toString() ?? "";
  const stderr = proc.stderr?.toString() ?? "";
  const exitCode = proc.exitCode ?? null;

  return {
    argv,
    display: argv.join(" "),
    exitCode,
    stdout,
    stderr,
    durationMs: Math.round(performance.now() - started),
    timedOut: exitCode === null,
  };
}
