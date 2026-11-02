import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireOwnedProject, requireUserId } from "./lib/auth";

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireOwnedProject(ctx, args.projectId, userId);
    return await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("asc")
      .take(200);
  },
});

export const insert = mutation({
  args: {
    projectId: v.id("projects"),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
      v.literal("tool"),
    ),
    content: v.string(),
    toolCalls: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireOwnedProject(ctx, args.projectId, userId);
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      role: args.role,
      content: args.content,
      toolCalls: args.toolCalls,
      createdAt: Date.now(),
    });
  },
});

export const insertInternal = internalMutation({
  args: {
    projectId: v.id("projects"),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
      v.literal("tool"),
    ),
    content: v.string(),
    toolCalls: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      role: args.role,
      content: args.content,
      toolCalls: args.toolCalls,
      createdAt: Date.now(),
    });
  },
});
