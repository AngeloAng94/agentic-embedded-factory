import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { projectStatusValidator } from "./schema";
import type { Id } from "./_generated/dataModel";

export const insertProject = mutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
    rtos: v.union(v.literal("freertos"), v.literal("zephyr")),
    status: projectStatusValidator,
    description: v.optional(v.string()),
    board: v.optional(v.string()),
    mcu: v.optional(v.string()),
    toolchain: v.optional(v.string()),
    peripherals: v.optional(v.array(v.string())),
    memoryBudget: v.optional(v.string()),
    flashBudget: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("projects", args);
  },
});

export const insertFile = mutation({
  args: {
    projectId: v.id("projects"),
    path: v.string(),
    content: v.string(),
    type: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("projectFiles", {
      projectId: args.projectId,
      path: args.path,
      content: args.content,
      type: args.type as
        | "c"
        | "h"
        | "cpp"
        | "cmake"
        | "conf"
        | "overlay"
        | "yaml"
        | "json"
        | "md"
        | "other",
      version: 1,
      status: "current",
    });
  },
});

export const updateStatus = mutation({
  args: {
    projectId: v.id("projects"),
    status: projectStatusValidator,
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.projectId, { status: args.status });
  },
});

export const list = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projects")
      .withIndex("userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(50);
  },
});

export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.projectId);
  },
});

export const listFiles = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

export const getFile = query({
  args: { projectId: v.id("projects"), path: v.string() },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) =>
        q.eq("projectId", args.projectId).eq("path", args.path),
      )
      .take(1);
    return files[0] ?? null;
  },
});
