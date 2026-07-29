import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const insert = mutation({
  args: {
    projectId: v.id("projects"),
    type: v.union(v.literal("build"), v.literal("test"), v.literal("lint")),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("success"),
      v.literal("failed"),
    ),
    logs: v.string(),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("runs", {
      projectId: args.projectId,
      type: args.type,
      status: args.status,
      logs: args.logs,
      summary: args.summary,
    });
  },
});

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("runs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(50);
  },
});
