import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireOwnedProject, requireUserId } from "./lib/auth";
import { projectStatusValidator } from "./schema";

/**
 * Project queries — every handler derives the user from the session and
 * enforces ownership. No client-supplied `userId` is accepted anywhere.
 */

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    return await ctx.db
      .query("projects")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(100);
  },
});

export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await requireOwnedProject(ctx, args.projectId, userId);
  },
});

export const listFiles = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireOwnedProject(ctx, args.projectId, userId);
    return await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

export const getFile = query({
  args: { projectId: v.id("projects"), path: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireOwnedProject(ctx, args.projectId, userId);
    const files = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) =>
        q.eq("projectId", args.projectId).eq("path", args.path),
      )
      .take(1);
    return files[0] ?? null;
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireOwnedProject(ctx, args.projectId, userId);

    const files = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    for (const row of files) await ctx.db.delete(row._id);

    const versions = await ctx.db
      .query("fileVersions")
      .withIndex("by_project_created", (q) => q.eq("projectId", args.projectId))
      .collect();
    for (const row of versions) await ctx.db.delete(row._id);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    for (const row of messages) await ctx.db.delete(row._id);

    const runs = await ctx.db
      .query("runs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    for (const row of runs) await ctx.db.delete(row._id);

    await ctx.db.delete(args.projectId);
    return { deleted: true };
  },
});

/** Internal: status changes are always derived from a real event server-side. */
export const setStatus = internalMutation({
  args: {
    projectId: v.id("projects"),
    status: projectStatusValidator,
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;
    // Never allow a project to become `ready`: only `verified` (real build ok)
    // or `unverified` may be written by the system.
    const status = args.status === "ready" ? "unverified" : args.status;
    await ctx.db.patch(args.projectId, { status });
    return status;
  },
});
