/**
 * Phase 6d: one VCS branch per run, one commit per attempt, restore on failure,
 * plus the run artifacts.
 *
 * A run never edits the approved `known_issues.yaml` catalogue. Observed
 * failures are appended to `.pokayoke/known_issues.pending.yaml` as proposals,
 * and only the explicit human command in `tools/knownIssues/index.ts` can
 * approve them. Generated artifacts live under `.pokayoke/`, which is kept out
 * of the repository by `.gitignore` (added automatically when missing); the
 * approved catalogue remains a normal project input at the root by default.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { VcsPort } from "../core/vcs";
import {
  formatKnownIssueProposals,
  parseKnownIssueProposals,
  parseKnownIssues,
  type KnownIssue,
  type KnownIssueProposal,
} from "../core/knownIssues";

export interface AttemptCommit {
  attempt: number;
  commit: string;
  message: string;
}

export interface RunSessionOptions {
  vcs: VcsPort;
  runId: string;
  /** Optional explicit job branch. It must not be the currently checked out branch. */
  branchName?: string | null;
}

export type RunSessionBegin =
  | { ok: true; branch: string; baseBranch: string | null }
  | { ok: false; reason: string };

export type RunSessionFinish =
  | { ok: true; kept: boolean; restoredTo: string | null }
  | { ok: false; reason: string; kept: boolean; restoredTo: string | null };

export interface RunSessionMetadata {
  branch: string | null;
  baseBranch: string | null;
  commits: AttemptCommit[];
  kept: boolean;
  restoredTo: string | null;
}

function safeBranchPart(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? "run" : cleaned.slice(0, 80);
}

/** A generated branch is namespaced, so it can never be mistaken for `main`. */
export function runBranchName(runId: string): string {
  return `job/${safeBranchPart(runId)}`;
}

export class RunSession {
  readonly vcs: VcsPort;
  readonly runId: string;
  readonly requestedBranch: string | null;
  private branchName: string | null = null;
  private base: string | null = null;
  private ownsBranch = false;
  private readonly commitList: AttemptCommit[] = [];
  private kept = false;
  private restored: string | null = null;

  constructor(options: RunSessionOptions) {
    this.vcs = options.vcs;
    this.runId = options.runId;
    this.requestedBranch = options.branchName?.trim() || null;
  }

  get branch(): string | null {
    return this.branchName;
  }

  get baseBranch(): string | null {
    return this.base;
  }

  get commits(): readonly AttemptCommit[] {
    return this.commitList;
  }

  get wasKept(): boolean {
    return this.kept;
  }

  get restoredTo(): string | null {
    return this.restored;
  }

  async begin(): Promise<RunSessionBegin> {
    try {
      const state = await this.vcs.currentState();
      this.base = state.branch;
      const branch = this.requestedBranch ?? runBranchName(this.runId);
      if (branch === state.branch) {
        return {
          ok: false,
          reason: `VCS: branch ${branch} is already checked out; a run must start on a new branch`,
        };
      }
      await this.vcs.createBranch(branch);
      this.branchName = branch;
      this.ownsBranch = true;
      return { ok: true, branch, baseBranch: this.base };
    } catch (error) {
      return {
        ok: false,
        reason: `VCS: cannot create the run branch: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  async commitAttempt(
    attempt: number,
    message: string,
  ): Promise<{ ok: true; commit: AttemptCommit } | { ok: false; reason: string }> {
    if (!this.branchName) return { ok: false, reason: "VCS: no run branch is active" };
    const clean = `attempt ${attempt}: ${message.replace(/\s+/g, " ").trim()}`;
    try {
      const commit = await this.vcs.commit(clean, { allowEmpty: true });
      const entry = { attempt, commit, message: clean };
      this.commitList.push(entry);
      return { ok: true, commit: entry };
    } catch (error) {
      return {
        ok: false,
        reason: `VCS: commit for attempt ${attempt} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /**
   * Keeps a successful branch. Any other outcome returns to the base branch and
   * deletes the job branch, so a failed run leaves no source changes behind.
   */
  async finish(success: boolean): Promise<RunSessionFinish> {
    if (success) {
      this.kept = true;
      return { ok: true, kept: true, restoredTo: null };
    }
    if (!this.branchName) {
      return { ok: true, kept: false, restoredTo: this.base };
    }
    if (!this.ownsBranch) {
      this.kept = false;
      return { ok: true, kept: false, restoredTo: this.base };
    }
    try {
      const restored = await this.vcs.discardBranch(this.branchName);
      this.kept = false;
      this.restored = restored.restoredTo;
      this.ownsBranch = false;
      return { ok: true, kept: false, restoredTo: restored.restoredTo };
    } catch (error) {
      return {
        ok: false,
        kept: false,
        restoredTo: this.restored,
        reason: `VCS: restoring the base branch failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  metadata(): RunSessionMetadata {
    return {
      branch: this.branchName,
      baseBranch: this.base,
      commits: this.commitList.map((entry) => ({ ...entry })),
      kept: this.kept,
      restoredTo: this.restored,
    };
  }
}

export type WriteTextFile = (filePath: string, content: string) => void | Promise<void>;

function defaultWriteFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

export const DEFAULT_ARTIFACT_DIR = ".pokayoke";

export interface RunArtifactPaths {
  /** Directory holding the default artifacts. It may be outside the project. */
  artifactDir: string;
  reportPath: string;
  knownIssuesPath: string;
  pendingIssuesPath: string;
}

export interface RunArtifactOptions {
  /** Defaults to `<projectDir>/.pokayoke`; absolute paths are accepted. */
  artifactDir?: string | null;
  reportPath?: string | null;
  knownIssuesPath?: string | null;
  pendingIssuesPath?: string | null;
}

export function runArtifactPaths(
  projectDir: string,
  options: RunArtifactOptions = {},
): RunArtifactPaths {
  const artifactDir = path.resolve(projectDir, options.artifactDir ?? DEFAULT_ARTIFACT_DIR);
  const generated = (value: string | null | undefined, fallback: string): string =>
    value ? path.resolve(projectDir, value) : path.join(artifactDir, fallback);
  return {
    artifactDir,
    reportPath: generated(options.reportPath, "report.md"),
    // The approved catalogue is a project input, not a generated artifact. It
    // stays at the project root unless the caller explicitly moves it.
    knownIssuesPath: path.resolve(projectDir, options.knownIssuesPath ?? "known_issues.yaml"),
    pendingIssuesPath: generated(options.pendingIssuesPath, "known_issues.pending.yaml"),
  };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * True when at least one artifact lives under `<projectDir>/.pokayoke`. In that
 * case the orchestrator must ensure that directory is ignored.
 */
export function usesPokayokeArtifacts(
  projectDir: string,
  paths: Pick<RunArtifactPaths, "reportPath" | "knownIssuesPath" | "pendingIssuesPath">,
): boolean {
  const root = path.resolve(projectDir, DEFAULT_ARTIFACT_DIR);
  return [paths.reportPath, paths.knownIssuesPath, paths.pendingIssuesPath].some((file) =>
    isInside(root, path.resolve(file)),
  );
}

export interface GitignoreResult {
  ok: true;
  changed: boolean;
  path: string;
}

/**
 * Adds `.pokayoke/` to the project `.gitignore` when it is missing. It never
 * rewrites an existing line, and it does not require a git repository: the
 * ignore file is also useful when the project is initialised later.
 */
export function ensurePokayokeIgnored(
  projectDir: string,
): GitignoreResult | { ok: false; reason: string } {
  const gitignorePath = path.join(projectDir, ".gitignore");
  try {
    const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    const lines = current.split(/\r?\n/).map((line) => line.trim());
    if (
      lines.includes(".pokayoke/") ||
      lines.includes(".pokayoke") ||
      lines.includes("/.pokayoke/") ||
      lines.includes("/.pokayoke")
    ) {
      return { ok: true, changed: false, path: gitignorePath };
    }
    const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
    writeFileSync(gitignorePath, `${prefix}.pokayoke/\n`, "utf8");
    return { ok: true, changed: true, path: gitignorePath };
  } catch (error) {
    return {
      ok: false,
      reason: `.gitignore could not be updated: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export interface LoadedKnownIssues {
  issues: KnownIssue[];
  warning: string | null;
}

/** A missing catalogue is empty, not an error. A malformed one is a warning. */
export function loadKnownIssuesFile(filePath: string): LoadedKnownIssues {
  if (!existsSync(filePath)) return { issues: [], warning: null };
  try {
    const parsed = parseKnownIssues(readFileSync(filePath, "utf8"));
    return parsed.ok
      ? { issues: parsed.issues, warning: null }
      : {
          issues: [],
          warning: `known_issues.yaml is invalid and was not used: ${parsed.errors.join("; ")}`,
        };
  } catch (error) {
    return {
      issues: [],
      warning: `known_issues.yaml could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export interface LoadedPendingIssues {
  proposals: KnownIssueProposal[];
  warning: string | null;
  /** False when a malformed file must not be overwritten. */
  writable: boolean;
}

/** A missing pending file is empty. A malformed one is a warning, not a catalogue. */
export function loadKnownIssueProposalsFile(filePath: string): LoadedPendingIssues {
  if (!existsSync(filePath)) return { proposals: [], warning: null, writable: true };
  try {
    const parsed = parseKnownIssueProposals(readFileSync(filePath, "utf8"));
    return parsed.ok
      ? { proposals: parsed.proposals, warning: null, writable: true }
      : {
          proposals: [],
          warning: `known_issues.pending.yaml is invalid and was not used: ${parsed.errors.join("; ")}`,
          writable: false,
        };
  } catch (error) {
    return {
      proposals: [],
      warning: `known_issues.pending.yaml could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      writable: false,
    };
  }
}

export interface WriteRunArtifactsInput {
  projectDir: string;
  report: string;
  /** Proposals to append at the run end. Absent means "do not touch the file". */
  pendingProposals?: readonly KnownIssueProposal[] | null;
  paths?: Partial<RunArtifactPaths>;
  writeFile?: WriteTextFile;
}

/**
 * Writes `report.md` and, only when proposals are supplied, the pending
 * proposal file. The approved `known_issues.yaml` is intentionally never
 * written here.
 */
export async function writeRunArtifacts(
  input: WriteRunArtifactsInput,
): Promise<
  { ok: true; paths: RunArtifactPaths } | { ok: false; paths: RunArtifactPaths; reason: string }
> {
  const paths = runArtifactPaths(input.projectDir, {
    artifactDir: input.paths?.artifactDir,
    reportPath: input.paths?.reportPath,
    knownIssuesPath: input.paths?.knownIssuesPath,
    pendingIssuesPath: input.paths?.pendingIssuesPath,
  });
  const write = input.writeFile ?? defaultWriteFile;
  try {
    await write(paths.reportPath, input.report);
    if (input.pendingProposals) {
      await write(
        paths.pendingIssuesPath,
        formatKnownIssueProposals(input.pendingProposals),
      );
    }
    return { ok: true, paths };
  } catch (error) {
    return {
      ok: false,
      paths,
      reason: `run artifacts could not be written: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
