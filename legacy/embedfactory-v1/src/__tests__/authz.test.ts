import { describe, expect, test } from "bun:test";
import * as projects from "../convex/projects";
import * as projectFiles from "../convex/projectFiles";
import * as messages from "../convex/messages";
import * as runs from "../convex/runs";
import * as versions from "../convex/versions";
import * as agentStore from "../convex/agentStore";
import * as knowledgeBase from "../convex/knowledgeBase";
import { FakeDb, exportedArgs, fileDoc, handlerOf, makeCtx } from "./helpers/fakeConvex";

const USER_A = "users:1";
const USER_B = "users:2";

function setup() {
  const db = new FakeDb();
  db.seed("users", [
    { _id: USER_A, email: "a@example.com" },
    { _id: USER_B, email: "b@example.com" },
  ]);
  db.seed("projects", [
    { _id: "projects:A", userId: USER_A, name: "A firmware", rtos: "zephyr", status: "unverified" },
    { _id: "projects:B", userId: USER_B, name: "B firmware", rtos: "freertos", status: "unverified" },
  ]);
  db.seed("projectFiles", [
    fileDoc("projects:A", "src/main.c", "int main(void) { return 0; }\n"),
    fileDoc("projects:B", "src/main.c", "/* B code */\n"),
  ]);
  db.seed("messages", [
    { projectId: "projects:A", role: "user", content: "A message" },
    { projectId: "projects:B", role: "user", content: "B message" },
  ]);
  db.seed("runs", [
    { projectId: "projects:A", type: "build", verification: "REAL", verdict: "SUCCESS" },
    { projectId: "projects:B", type: "build", verification: "REAL", verdict: "FAILURE" },
  ]);
  db.seed("fileVersions", [
    { projectId: "projects:A", path: "src/main.c", version: 1, content: "v1 A", author: "bootstrap", createdAt: 1 },
    { projectId: "projects:B", path: "src/main.c", version: 1, content: "v1 B", author: "bootstrap", createdAt: 1 },
  ]);
  return db;
}

describe("authorization — session-derived identity", () => {
  test("no public function accepts a client supplied userId", () => {
    const modules: [string, Record<string, unknown>][] = [
      ["projects", projects as unknown as Record<string, unknown>],
      ["projectFiles", projectFiles as unknown as Record<string, unknown>],
      ["messages", messages as unknown as Record<string, unknown>],
      ["runs", runs as unknown as Record<string, unknown>],
      ["versions", versions as unknown as Record<string, unknown>],
      ["knowledgeBase", knowledgeBase as unknown as Record<string, unknown>],
    ];

    for (const [moduleName, module] of modules) {
      for (const [fnName, fn] of Object.entries(module)) {
        try {
          const args = exportedArgs(fn);
          expect(
            Object.keys(args).includes("userId"),
            `${moduleName}.${fnName} must not accept a client userId`,
          ).toBe(false);
        } catch {
          // not a convex function (types, helpers) — ignored
        }
      }
    }
  });

  test("projects.list only returns the caller's projects", async () => {
    const db = setup();
    const forA = await handlerOf(projects.list)(makeCtx(db, USER_A), {});
    const forB = await handlerOf(projects.list)(makeCtx(db, USER_B), {});

    expect(forA.map((p: { _id: string }) => p._id)).toEqual(["projects:A"]);
    expect(forB.map((p: { _id: string }) => p._id)).toEqual(["projects:B"]);
  });

  test("projects.get refuses another user's project", async () => {
    const db = setup();
    await expect(
      handlerOf(projects.get)(makeCtx(db, USER_A), { projectId: "projects:B" }),
    ).rejects.toThrow(/not found or not accessible/);

    const own = await handlerOf(projects.get)(makeCtx(db, USER_A), { projectId: "projects:A" });
    expect(own.name).toBe("A firmware");
  });

  test("projects.listFiles / getFile refuse another user's project", async () => {
    const db = setup();
    await expect(
      handlerOf(projects.listFiles)(makeCtx(db, USER_A), { projectId: "projects:B" }),
    ).rejects.toThrow(/not accessible/);

    await expect(
      handlerOf(projects.getFile)(makeCtx(db, USER_A), {
        projectId: "projects:B",
        path: "src/main.c",
      }),
    ).rejects.toThrow(/not accessible/);
  });

  test("user A cannot modify or delete user B's project", async () => {
    const db = setup();

    await expect(
      handlerOf(projectFiles.patch)(makeCtx(db, USER_A), {
        projectId: "projects:B",
        path: "src/main.c",
        content: "/* hacked */",
      }),
    ).rejects.toThrow(/not accessible/);

    const bFile = db.all("projectFiles").find((f) => f.projectId === "projects:B");
    expect(bFile?.content).toBe("/* B code */\n");

    await expect(
      handlerOf(projects.remove)(makeCtx(db, USER_A), { projectId: "projects:B" }),
    ).rejects.toThrow(/not accessible/);

    expect(db.all("projects").some((p) => p._id === "projects:B")).toBe(true);
  });

  test("messages, runs and versions are scoped to the owner", async () => {
    const db = setup();

    await expect(
      handlerOf(messages.list)(makeCtx(db, USER_A), { projectId: "projects:B" }),
    ).rejects.toThrow(/not accessible/);
    await expect(
      handlerOf(runs.list)(makeCtx(db, USER_A), { projectId: "projects:B" }),
    ).rejects.toThrow(/not accessible/);
    await expect(
      handlerOf(versions.list)(makeCtx(db, USER_A), { projectId: "projects:B" }),
    ).rejects.toThrow(/not accessible/);
    await expect(
      handlerOf(versions.rollback)(makeCtx(db, USER_A), {
        projectId: "projects:B",
        versionId: "fileVersions:6",
      }),
    ).rejects.toThrow(/not accessible/);

    const aMessages = await handlerOf(messages.list)(makeCtx(db, USER_A), {
      projectId: "projects:A",
    });
    expect(aMessages.map((m: { content: string }) => m.content)).toEqual(["A message"]);
  });

  test("unauthenticated callers are rejected everywhere", async () => {
    const db = setup();
    const anon = makeCtx(db, null);

    await expect(handlerOf(projects.list)(anon, {})).rejects.toThrow(/Not authenticated/);
    await expect(
      handlerOf(projects.get)(anon, { projectId: "projects:A" }),
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      handlerOf(projectFiles.patch)(anon, {
        projectId: "projects:A",
        path: "src/main.c",
        content: "x",
      }),
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      handlerOf(runs.list)(anon, { projectId: "projects:A" }),
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      handlerOf(versions.rollback)(anon, { projectId: "projects:A", versionId: "fileVersions:1" }),
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      handlerOf(knowledgeBase.seedKnowledgeBase)(anon, {}),
    ).rejects.toThrow(/Not authenticated/);
  });

  test("the internal agent context refuses a mismatched user id", async () => {
    const db = setup();
    await expect(
      handlerOf(agentStore.projectContext)(makeCtx(db, USER_A), {
        projectId: "projects:B",
        userId: USER_A,
      }),
    ).rejects.toThrow(/not accessible/);

    const own = await handlerOf(agentStore.projectContext)(makeCtx(db, USER_A), {
      projectId: "projects:A",
      userId: USER_A,
    });
    expect(own.files).toHaveLength(1);
  });

  test("a user can delete their own project and its history", async () => {
    const db = setup();
    await handlerOf(projects.remove)(makeCtx(db, USER_A), { projectId: "projects:A" });

    expect(db.all("projects").some((p) => p._id === "projects:A")).toBe(false);
    expect(db.all("projectFiles").some((f) => f.projectId === "projects:A")).toBe(false);
    expect(db.all("fileVersions").some((v) => v.projectId === "projects:A")).toBe(false);
    expect(db.all("runs").some((r) => r.projectId === "projects:A")).toBe(false);
  });
});
