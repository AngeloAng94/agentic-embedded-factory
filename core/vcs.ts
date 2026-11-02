/**
 * Version control boundary.
 *
 * The product depends on git: every job works on its own branch and a failed
 * job must leave the repository exactly as it was. The orchestrator therefore
 * talks to `VcsPort`, never to `git` directly.
 *
 * Two implementations exist:
 *   - `tools/gitVcs.ts`      real git, used by the CLI/job mode
 *   - `InMemoryVcs` (below)  a FAKE test double, explicitly marked as such
 */

export interface VcsState {
  branch: string | null;
  head: string | null;
  dirty: boolean;
}

export interface VcsPort {
  /** Creates `name` from the current HEAD and switches to it. */
  createBranch(name: string): Promise<void>;
  /** Stages everything and commits. Returns the commit id. */
  commit(message: string, options?: { allowEmpty?: boolean }): Promise<string>;
  /** `git diff` between two revisions; no arguments = working tree vs HEAD. */
  diff(from?: string, to?: string): Promise<string>;
  /** Deletes the branch; if it is checked out, returns to where it started. */
  discardBranch(name: string): Promise<{ restoredTo: string | null }>;
  currentState(): Promise<VcsState>;
}

export type VcsErrorCode =
  | "GIT_NOT_AVAILABLE"
  | "BRANCH_EXISTS"
  | "BRANCH_NOT_FOUND"
  | "COMMAND_FAILED"
  | "NOT_A_REPOSITORY";

export class VcsError extends Error {
  readonly code: VcsErrorCode;
  readonly stderr: string;

  constructor(code: VcsErrorCode, message: string, stderr = "") {
    super(message);
    this.name = "VcsError";
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * FAKE — this is a test double, not a git implementation.
 *
 * It never touches the filesystem or a process. Diffs are synthetic and every
 * diff it returns starts with `# FAKE in-memory diff`, so a report built from
 * them can never be mistaken for real repository evidence.
 */
export class InMemoryVcs implements VcsPort {
  /** Explicit marker: this object cannot produce real evidence. */
  readonly kind = "FAKE" as const;
  readonly simulated = true;

  private readonly branches = new Map<string, { base: string | null; commits: string[] }>();
  private current: string | null = null;
  private commitSeq = 0;
  private files = new Map<string, string>();

  constructor(initialBranch = "main") {
    this.branches.set(initialBranch, { base: null, commits: [] });
    this.current = initialBranch;
  }

  describe(): string {
    return "FAKE in-memory VCS (test double) — no git process was executed";
  }

  async createBranch(name: string): Promise<void> {
    if (this.branches.has(name)) {
      throw new VcsError("BRANCH_EXISTS", `branch ${name} already exists`);
    }
    const base = this.current;
    this.branches.set(name, { base, commits: [] });
    this.current = name;
  }

  async commit(message: string): Promise<string> {
    if (!this.current) throw new VcsError("BRANCH_NOT_FOUND", "no branch checked out");
    this.commitSeq += 1;
    const id = `fake-${String(this.commitSeq).padStart(4, "0")}`;
    this.branches.get(this.current)?.commits.push(`${id} ${message}`);
    return id;
  }

  async diff(from?: string, to?: string): Promise<string> {
    const range = from === undefined && to === undefined ? "working tree" : `${from ?? "HEAD"}..${to ?? "HEAD"}`;
    return [
      "# FAKE in-memory diff — not repository evidence",
      `# branch: ${this.current ?? "(none)"}  range: ${range}`,
      `# files: ${[...this.files.keys()].join(", ") || "(none)"}`,
    ].join("\n");
  }

  async discardBranch(name: string): Promise<{ restoredTo: string | null }> {
    const branch = this.branches.get(name);
    if (!branch) throw new VcsError("BRANCH_NOT_FOUND", `branch ${name} does not exist`);
    this.branches.delete(name);
    if (this.current === name) this.current = branch.base;
    return { restoredTo: this.current };
  }

  async currentState(): Promise<VcsState> {
    const branch = this.current ? this.branches.get(this.current) : undefined;
    const commits = branch?.commits ?? [];
    return {
      branch: this.current,
      head: commits.length > 0 ? commits[commits.length - 1]!.split(" ")[0]! : null,
      dirty: false,
    };
  }

  /** Test helper: pretend a file was written, so `diff` can name it. */
  trackFile(path: string, content: string): void {
    this.files.set(path, content);
  }
}
