import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwnedProject, requireUserId } from "./lib/auth";
import { inferFileType } from "./templates";

/**
 * Version history + rollback.
 *
 * Every applied change (bootstrap, agent patch, user edit, rollback) is stored
 * as an immutable `fileVersions` row, so `v1..vn` can always be inspected and
 * restored. A rollback never deletes history: it writes a new `v(n+1)` whose
 * author is `rollback`.
 */

export const list = query({
  args: { projectId: v.id("projects"), path: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireOwnedProject(ctx, args.projectId, userId);

    const rows = await ctx.db
      .query("fileVersions")
      .withIndex("by_project_created", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(200);

    return rows
      .filter((row) => (args.path ? row.path === args.path : true))
      .map((row) => ({
        _id: row._id,
        path: row.path,
        version: row.version,
        author: row.author,
        reason: row.reason ?? null,
        patch: row.patch ?? null,
        createdAt: row.createdAt,
        buildVerdict: row.buildVerdict ?? null,
        buildRunId: row.buildRunId ?? null,
        contentPreview: row.content.slice(0, 400),
        sizeBytes: row.content.length,
      }));
  },
});

export const rollback = mutation({
  args: {
    projectId: v.id("projects"),
    versionId: v.id("fileVersions"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireOwnedProject(ctx, args.projectId, userId);

    const version = await ctx.db.get(args.versionId);
    if (!version || version.projectId !== args.projectId) {
      throw new Error("Version not found for this project");
    }

    const current = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) =>
        q.eq("projectId", args.projectId).eq("path", version.path),
      )
      .take(1);

    const now = Date.now();

    if (!current[0]) {
      await ctx.db.insert("projectFiles", {
        projectId: args.projectId,
        path: version.path,
        content: version.content,
        type: inferFileType(version.path) as never,
        version: 1,
        status: "current",
        updatedAt: now,
      });
      await ctx.db.insert("fileVersions", {
        projectId: args.projectId,
        path: version.path,
        version: 1,
        content: version.content,
        author: "rollback",
        reason: `restored v${version.version} (${version.author})`,
        createdAt: now,
      });
      await ctx.db.patch(args.projectId, { status: "unverified" });
      return { path: version.path, version: 1, restoredFrom: version.version };
    }

    const nextVersion = (current[0].version ?? 1) + 1;
    await ctx.db.patch(current[0]._id, {
      content: version.content,
      version: nextVersion,
      status: "current",
      updatedAt: now,
    });
    await ctx.db.insert("fileVersions", {
      projectId: args.projectId,
      path: version.path,
      version: nextVersion,
      content: version.content,
      previousContent: current[0].content,
      author: "rollback",
      reason: `restored v${version.version} (${version.author})`,
      createdAt: now,
    });

    await ctx.db.patch(args.projectId, { status: "unverified" });

    return { path: version.path, version: nextVersion, restoredFrom: version.version };
  },
});
