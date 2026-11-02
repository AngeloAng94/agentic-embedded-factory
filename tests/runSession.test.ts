import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryVcs } from "../core/vcs";
import {
  loadKnownIssuesFile,
  runArtifactPaths,
  RunSession,
  runBranchName,
  writeRunArtifacts,
} from "../agent/runSession";

describe("Phase 6d run session", () => {
  test("creates a namespaced branch and one commit per attempt", async () => {
    const vcs = new InMemoryVcs("main");
    const session = new RunSession({ vcs, runId: "run 1/alpha" });
    const begun = await session.begin();
    expect(begun).toEqual({ ok: true, branch: "job/run-1-alpha", baseBranch: "main" });
    expect((await vcs.currentState()).branch).toBe("job/run-1-alpha");

    expect(await session.commitAttempt(1, "REAL FAILURE: build failed")).toEqual({
      ok: true,
      commit: {
        attempt: 1,
        commit: "fake-0001",
        message: "attempt 1: REAL FAILURE: build failed",
      },
    });
    await session.commitAttempt(2, "REAL SUCCESS: build succeeded");
    expect(session.commits).toHaveLength(2);
    expect(session.commits[1]?.commit).toBe("fake-0002");

    const finish = await session.finish(true);
    expect(finish).toEqual({ ok: true, kept: true, restoredTo: null });
    expect((await vcs.currentState()).branch).toBe("job/run-1-alpha");
    expect(session.metadata()).toMatchObject({
      branch: "job/run-1-alpha",
      baseBranch: "main",
      kept: true,
      restoredTo: null,
    });
  });

  test("a failed run discards its branch and restores the base", async () => {
    const vcs = new InMemoryVcs("main");
    const session = new RunSession({ vcs, runId: "failure" });
    await session.begin();
    await session.commitAttempt(1, "REAL FAILURE: build failed");
    const finish = await session.finish(false);

    expect(finish).toEqual({ ok: true, kept: false, restoredTo: "main" });
    expect((await vcs.currentState()).branch).toBe("main");
    expect(session.metadata().kept).toBe(false);
    expect(session.metadata().restoredTo).toBe("main");
    await expect(vcs.discardBranch("job/failure")).rejects.toThrow();
  });

  test("refuses to start on the already checked-out branch", async () => {
    const vcs = new InMemoryVcs("main");
    const session = new RunSession({ vcs, runId: "x", branchName: "main" });
    const begun = await session.begin();
    expect(begun.ok).toBe(false);
    if (!begun.ok) expect(begun.reason).toContain("already checked out");
    expect(session.branch).toBeNull();
  });

  test("runBranchName sanitizes an id and keeps the job namespace", () => {
    expect(runBranchName("run 1/alpha")).toBe("job/run-1-alpha");
    expect(runBranchName("///")).toBe("job/run");
  });

  test("writes report.md and known_issues.yaml, and reports write failures", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "py-bench-artifacts-"));
    try {
      const paths = runArtifactPaths(dir);
      const written = await writeRunArtifacts({
        projectDir: dir,
        report: "# Run\n\n| Criterio di accettazione | Esito |\n| --- | --- |\n| x | PASS |\n",
        issues: [{ error: "boom", hint: "inspect" }],
        paths,
      });
      expect(written.ok).toBe(true);
      expect(readFileSync(paths.reportPath, "utf8")).toContain("| x | PASS |");
      expect(readFileSync(paths.knownIssuesPath, "utf8")).toContain("error: \"boom\"");

      const failed = await writeRunArtifacts({
        projectDir: dir,
        report: "x",
        issues: [],
        paths,
        writeFile: () => {
          throw new Error("disk full");
        },
      });
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.reason).toContain("disk full");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing catalogue is empty; malformed YAML is a warning", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "py-bench-known-"));
    try {
      const missing = runArtifactPaths(dir).knownIssuesPath;
      expect(loadKnownIssuesFile(missing)).toEqual({ issues: [], warning: null });

      const bad = path.join(dir, "known_issues.yaml");
      writeFileSync(bad, "- error: [unclosed\n");
      const loaded = loadKnownIssuesFile(bad);
      expect(loaded.issues).toEqual([]);
      expect(loaded.warning).toContain("known_issues.yaml is invalid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
