import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

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
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      role: args.role,
      content: args.content,
      toolCalls: args.toolCalls,
    });
  },
});

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("asc")
      .take(200);
  },
});
