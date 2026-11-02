import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitVcs } from "../tools/gitVcs";

/**
 * Real-git integration tests.
 *
 * Skipped when git is not installed, and also unless `PY_BENCH_ALLOW_REAL_GIT=1`
 * is set: the sandbox this repository is developed in forbids running git, so the
 * suite must not spawn it by accident. Locally:
 *
 *   PY_BENCH_ALLOW_REAL_GIT=1 bun test tests/git.real.test.ts
 */
const gitAvailable = Bun.which("git") !== null;
const allowed = process.env.PY_BENCH_ALLOW_REAL_GIT === "1";
const skipReason = !gitAvailable
  ? "git is not installed"
  : !allowed
    ? "set PY_BENCH_ALLOW_REAL_GIT=1 to run the real git tests"
    : null;

const realTest = test.skipIf(skipReason !== null);

const dirs: string[] = [];

function git(cwd: string, args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr?.toString() ?? ""}`);
  }
  return proc.stdout.toString();
}

function repository(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pybench-git-"));
  dirs.push(dir);
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "user.name", "PY Bench Test"]);
  writeFileSync(path.join(dir, "main.c"), "int main(void) {\n    return 0;\n}\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial"]);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe(`GitVcs — real git${skipReason ? ` (skipped: ${skipReason})` : ""}`, () => {
  realTest("creates a job branch, commits and reports a real state", async () => {
    const dir = repository();
    const vcs = new GitVcs({ cwd: dir });
    const base = (await vcs.currentState()).branch!;
    expect(base).not.toBeNull();

    await vcs.createBranch("job/demo-1");
    expect((await vcs.currentState()).branch).toBe("job/demo-1");

    writeFileSync(path.join(dir, "main.c"), "int main(void) {\n    // [AI_START_APP]\n    return 1;\n    // [AI_END_APP]\n}\n");
    expect((await vcs.currentState()).dirty).toBe(true);

    const id = await vcs.commit("job: change main");
    expect(id).toMatch(/^[0-9a-f]{40}$/);

    const state = await vcs.currentState();
    expect(state.head).toBe(id);
    expect(state.dirty).toBe(false);

    const diff = await vcs.diff(base, id);
    expect(diff).toContain("+    // [AI_START_APP]");
  });

  realTest("discarding the branch restores the previous checkout", async () => {
    const dir = repository();
    const vcs = new GitVcs({ cwd: dir });
    const base = (await vcs.currentState()).branch!;

    await vcs.createBranch("job/demo-2");
    writeFileSync(path.join(dir, "broken.c"), "this does not compile\n");
    await vcs.commit("job: broken attempt");

    const { restoredTo } = await vcs.discardBranch("job/demo-2");
    expect(restoredTo).toBe(base);
    expect((await vcs.currentState()).branch).toBe(base);

    const branches = git(dir, ["branch", "--list", "job/demo-2"]);
    expect(branches.trim()).toBe("");
  });
});
