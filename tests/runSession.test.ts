import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryVcs } from "../core/vcs";
import {
  ensurePokayokeIgnored,
  loadKnownIssueProposalsFile,
  loadKnownIssuesFile,
  runArtifactPaths,
  RunSession,
  runBranchName,
  usesPokayokeArtifacts,
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

  test("writes report.md and pending proposals without touching the catalogue", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "py-bench-artifacts-"));
    try {
      const paths = runArtifactPaths(dir);
      expect(paths.reportPath).toBe(path.join(dir, ".pokayoke", "report.md"));
      expect(paths.knownIssuesPath).toBe(path.join(dir, "known_issues.yaml"));
      expect(paths.pendingIssuesPath).toBe(
        path.join(dir, ".pokayoke", "known_issues.pending.yaml"),
      );
      const outside = mkdtempSync(path.join(tmpdir(), "py-bench-external-"));
      try {
        const external = runArtifactPaths(dir, { artifactDir: outside });
        expect(external.reportPath).toBe(path.join(outside, "report.md"));
        expect(external.pendingIssuesPath).toBe(
          path.join(outside, "known_issues.pending.yaml"),
        );
        expect(usesPokayokeArtifacts(dir, external)).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
      const written = await writeRunArtifacts({
        projectDir: dir,
        report: "# Run\n\n| Criterio di accettazione | Esito |\n| --- | --- |\n| x | PASS |\n",
        pendingProposals: [
          { error: "boom", context: "attempt 1; build failed", runId: "run-1" },
        ],
        paths,
      });
      expect(written.ok).toBe(true);
      expect(readFileSync(paths.reportPath, "utf8")).toContain("| x | PASS |");
      const pending = readFileSync(paths.pendingIssuesPath, "utf8");
      expect(pending).toContain("error: \"boom\"");
      expect(pending).toContain("run_id: \"run-1\"");
      expect(existsSync(paths.knownIssuesPath)).toBe(false);

      const failed = await writeRunArtifacts({
        projectDir: dir,
        report: "x",
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

  test("adds .pokayoke/ to .gitignore once and never rewrites the file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "py-bench-gitignore-"));
    try {
      const first = ensurePokayokeIgnored(dir);
      expect(first).toMatchObject({ ok: true, changed: true });
      expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(".pokayoke/\n");
      const second = ensurePokayokeIgnored(dir);
      expect(second).toMatchObject({ ok: true, changed: false });
      expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(".pokayoke/\n");

      writeFileSync(path.join(dir, ".gitignore"), "node_modules\n", "utf8");
      ensurePokayokeIgnored(dir);
      expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(
        "node_modules\n.pokayoke/\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed pending file is reported and never considered writable", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "py-bench-pending-"));
    try {
      const pendingPath = path.join(dir, "known_issues.pending.yaml");
      expect(loadKnownIssueProposalsFile(pendingPath)).toEqual({
        proposals: [],
        warning: null,
        writable: true,
      });
      writeFileSync(pendingPath, "- error: [unclosed\n");
      const loaded = loadKnownIssueProposalsFile(pendingPath);
      expect(loaded.proposals).toEqual([]);
      expect(loaded.writable).toBe(false);
      expect(loaded.warning).toContain("known_issues.pending.yaml is invalid");
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
