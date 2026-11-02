/**
 * Real git implementation of `VcsPort`.
 *
 * It runs git through `Bun.spawnSync` with an argument array (no shell), in the
 * repository directory given to the constructor. Every failure becomes a
 * `VcsError` with the git stderr attached: callers must treat it as a failed
 * job, never as a silent success.
 */
import { VcsError, type VcsPort, type VcsState } from "../core/vcs";

export interface GitVcsOptions {
  cwd: string;
  /** Ref to return to when a job branch is discarded. Defaults to the branch at construction. */
  baseRef?: string;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export class GitVcs implements VcsPort {
  readonly kind = "REAL" as const;

  private readonly cwd: string;
  private readonly bases = new Map<string, string>();
  private baseRef: string;

  constructor(options: GitVcsOptions) {
    this.cwd = options.cwd;
    this.baseRef = options.baseRef ?? this.currentRef();
  }

  /** True when a git executable is on PATH. Does not touch any repository. */
  static isAvailable(): boolean {
    return Bun.which("git") !== null;
  }

  async createBranch(name: string): Promise<void> {
    const base = this.currentRef();
    this.run(["checkout", "-b", name]);
    this.bases.set(name, base);
    this.baseRef = base;
  }

  async commit(message: string, options: { allowEmpty?: boolean } = {}): Promise<string> {
    this.run(["add", "-A"]);
    this.run(["commit", "-m", message, ...(options.allowEmpty ? ["--allow-empty"] : [])]);
    return this.run(["rev-parse", "HEAD"]).stdout.trim();
  }

  async diff(from?: string, to?: string): Promise<string> {
    const args = ["diff"];
    if (from !== undefined) args.push(from);
    if (to !== undefined) args.push(to);
    args.push("--");
    return this.run(args).stdout;
  }

  async discardBranch(name: string): Promise<{ restoredTo: string | null }> {
    const current = this.currentBranch();
    if (current === name) {
      const target = this.bases.get(name) ?? this.baseRef;
      this.run(["checkout", target]);
    }
    this.run(["branch", "-D", name]);
    this.bases.delete(name);
    return { restoredTo: this.currentBranch() };
  }

  async currentState(): Promise<VcsState> {
    const branch = this.currentBranch();
    const head = this.run(["rev-parse", "--verify", "HEAD"], { allowFailure: true });
    const status = this.run(["status", "--porcelain"]);
    return {
      branch: branch === "HEAD" ? null : branch,
      head: head.ok ? head.stdout.trim() : null,
      dirty: status.stdout.trim() !== "",
    };
  }

  private currentBranch(): string {
    return this.run(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  }

  private currentRef(): string {
    const head = this.run(["rev-parse", "--verify", "HEAD"], { allowFailure: true });
    if (head.ok) return head.stdout.trim();
    return this.currentBranch();
  }

  private run(args: string[], options: { allowFailure?: boolean } = {}): RunResult {
    if (!GitVcs.isAvailable()) {
      throw new VcsError("GIT_NOT_AVAILABLE", "git executable not found on PATH");
    }
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: this.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout?.toString() ?? "";
    const stderr = proc.stderr?.toString() ?? "";
    const ok = proc.exitCode === 0;

    if (!ok && !options.allowFailure) {
      const code =
        stderr.includes("already exists") || stderr.includes("already checked out")
          ? "BRANCH_EXISTS"
          : stderr.includes("not a git repository")
            ? "NOT_A_REPOSITORY"
            : "COMMAND_FAILED";
      throw new VcsError(code, `git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`, stderr);
    }
    return { ok, stdout, stderr };
  }
}
