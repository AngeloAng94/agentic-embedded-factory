import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { requireOwnedProject, requireUserId } from "./lib/auth";
import { isPathAllowed, MAX_FILE_BYTES } from "../lib/core/pathSafety";
import { inferFileType } from "./templates";

/**
 * File writes go through an allow-listed path sandbox and are recorded in
 * `fileVersions` so any change can be rolled back.
 */

export const patch = mutation({
  args: {
    projectId: v.id("projects"),
    path: v.string(),
    content: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireOwnedProject(ctx, args.projectId, userId);

    if (!isPathAllowed(args.path)) {
      throw new Error(`Path "${args.path}" is outside the project sandbox.`);
    }
    if (args.content.length > MAX_FILE_BYTES) {
      throw new Error(`File ${args.path} exceeds the ${MAX_FILE_BYTES} byte limit.`);
    }

    const existing = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) =>
        q.eq("projectId", args.projectId).eq("path", args.path),
      )
      .take(1);

    const now = Date.now();
    const previous = existing[0];

    if (previous) {
      const version = (previous.version ?? 1) + 1;
      await ctx.db.patch(previous._id, {
        content: args.content,
        version,
        status: "current",
        updatedAt: now,
      });
      await ctx.db.insert("fileVersions", {
        projectId: args.projectId,
        path: args.path,
        version,
        content: args.content,
        previousContent: previous.content,
        author: "user",
        reason: args.reason ?? "manual edit",
        createdAt: now,
      });
      return { path: args.path, version };
    }

    await ctx.db.insert("projectFiles", {
      projectId: args.projectId,
      path: args.path,
      content: args.content,
      type: inferFileType(args.path) as never,
      version: 1,
      status: "current",
      updatedAt: now,
    });
    await ctx.db.insert("fileVersions", {
      projectId: args.projectId,
      path: args.path,
      version: 1,
      content: args.content,
      author: "user",
      reason: args.reason ?? "manual creation",
      createdAt: now,
    });
    return { path: args.path, version: 1 };
  },
});

/** Internal: used by the agent when it applies a validated plan. */
export const writeInternal = internalMutation({
  args: {
    projectId: v.id("projects"),
    path: v.string(),
    content: v.string(),
    patch: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    if (!isPathAllowed(args.path)) {
      throw new Error(`Path "${args.path}" is outside the project sandbox.`);
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) =>
        q.eq("projectId", args.projectId).eq("path", args.path),
      )
      .take(1);

    if (existing[0]) {
      const version = (existing[0].version ?? 1) + 1;
      await ctx.db.patch(existing[0]._id, {
        content: args.content,
        version,
        status: "current",
        updatedAt: now,
      });
      await ctx.db.insert("fileVersions", {
        projectId: args.projectId,
        path: args.path,
        version,
        content: args.content,
        previousContent: existing[0].content,
        patch: args.patch,
        author: "agent",
        reason: args.reason,
        createdAt: now,
      });
      return version;
    }

    await ctx.db.insert("projectFiles", {
      projectId: args.projectId,
      path: args.path,
      content: args.content,
      type: inferFileType(args.path) as never,
      version: 1,
      status: "current",
      updatedAt: now,
    });
    await ctx.db.insert("fileVersions", {
      projectId: args.projectId,
      path: args.path,
      version: 1,
      content: args.content,
      patch: args.patch,
      author: "agent",
      reason: args.reason,
      createdAt: now,
    });
    return 1;
  },
});
