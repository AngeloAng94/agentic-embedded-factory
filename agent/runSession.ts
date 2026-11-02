/**
 * Phase 6d: one VCS branch per run, one commit per attempt, restore on failure,
 * plus the two run artifacts (`report.md`, `known_issues.yaml`).
 *
 * The session never decides whether a run succeeded: the orchestrator passes
 * its final code. A session that did not create the branch never deletes it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { VcsPort } from "../core/vcs";
import {
  formatKnownIssues,
  parseKnownIssues,
  type KnownIssue,
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

  async commitAttempt(attempt: number, message: string): Promise<{ ok: true; commit: AttemptCommit } | { ok: false; reason: string }> {
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

export interface RunArtifactPaths {
  reportPath: string;
  knownIssuesPath: string;
}

export function runArtifactPaths(
  projectDir: string,
  options: { reportPath?: string | null; knownIssuesPath?: string | null } = {},
): RunArtifactPaths {
  return {
    reportPath: path.resolve(projectDir, options.reportPath ?? "report.md"),
    knownIssuesPath: path.resolve(projectDir, options.knownIssuesPath ?? "known_issues.yaml"),
  };
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

export interface WriteRunArtifactsInput {
  projectDir: string;
  report: string;
  issues: readonly KnownIssue[];
  paths?: Partial<RunArtifactPaths>;
  writeFile?: WriteTextFile;
}

export async function writeRunArtifacts(
  input: WriteRunArtifactsInput,
): Promise<{ ok: true; paths: RunArtifactPaths } | { ok: false; paths: RunArtifactPaths; reason: string }> {
  const paths = runArtifactPaths(input.projectDir, {
    reportPath: input.paths?.reportPath,
    knownIssuesPath: input.paths?.knownIssuesPath,
  });
  const write = input.writeFile ?? defaultWriteFile;
  try {
    await write(paths.reportPath, input.report);
    await write(paths.knownIssuesPath, formatKnownIssues(input.issues));
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
