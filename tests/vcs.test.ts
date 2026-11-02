import { describe, expect, test } from "bun:test";
import { InMemoryVcs, VcsError } from "../core/vcs";

/**
 * Only the FAKE double is tested here. Real git is covered by
 * tests/git.real.test.ts, which is skipped unless explicitly enabled.
 */
describe("InMemoryVcs — fake double", () => {
  test("declares itself as fake and never claims repository evidence", async () => {
    const vcs = new InMemoryVcs();
    expect(vcs.kind).toBe("FAKE");
    expect(vcs.simulated).toBe(true);
    expect(vcs.describe()).toContain("FAKE");

    const diff = await vcs.diff();
    expect(diff).toContain("FAKE in-memory diff");
    expect(diff).toContain("not repository evidence");
  });

  test("creates a branch, commits on it and can go back", async () => {
    const vcs = new InMemoryVcs("main");
    expect((await vcs.currentState()).branch).toBe("main");

    await vcs.createBranch("job/demo-1");
    expect((await vcs.currentState()).branch).toBe("job/demo-1");

    const before = await vcs.currentState();
    expect(before.head).toBeNull();

    const id = await vcs.commit("job: first attempt");
    expect(id).toBe("fake-0001");
    expect((await vcs.currentState()).head).toBe("fake-0001");

    const { restoredTo } = await vcs.discardBranch("job/demo-1");
    expect(restoredTo).toBe("main");
    expect((await vcs.currentState()).branch).toBe("main");
  });

  test("refuses a duplicate branch and a missing one", async () => {
    const vcs = new InMemoryVcs("main");
    await vcs.createBranch("job/a");
    await expect(vcs.createBranch("job/a")).rejects.toThrow(VcsError);
    await expect(vcs.discardBranch("job/missing")).rejects.toThrow(VcsError);
  });

  test("a discarded branch disappears from the state", async () => {
    const vcs = new InMemoryVcs("main");
    await vcs.createBranch("job/b");
    await vcs.commit("x");
    await vcs.discardBranch("job/b");
    expect((await vcs.currentState()).branch).toBe("main");
    await expect(vcs.createBranch("job/b")).resolves.toBeUndefined();
  });
});
