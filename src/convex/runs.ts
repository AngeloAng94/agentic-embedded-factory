import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireOwnedProject, requireUserId } from "./lib/auth";
import { runTypeValidator, verificationValidator, verdictValidator } from "./schema";

/**
 * Run records are evidence. `verification` says how the result was obtained and
 * `verdict` what it was: no row may claim SUCCESS without REAL verification.
 */

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireOwnedProject(ctx, args.projectId, userId);
    return await ctx.db
      .query("runs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(60);
  },
});

export const insert = internalMutation({
  args: {
    projectId: v.id("projects"),
    type: runTypeValidator,
    verification: v.optional(verificationValidator),
    verdict: v.optional(verdictValidator),
    command: v.optional(v.string()),
    toolchain: v.optional(v.string()),
    exitCode: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    stdout: v.optional(v.string()),
    stderr: v.optional(v.string()),
    artifacts: v.optional(v.array(v.string())),
    reason: v.optional(v.string()),
    attempt: v.optional(v.number()),
    patchSummary: v.optional(v.string()),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"runs">> => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error(`Project ${args.projectId} not found`);

    const runId = await ctx.db.insert("runs", {
      ...args,
      status:
        args.verdict === "SUCCESS"
          ? "success"
          : args.verdict === "FAILURE"
            ? "failed"
            : "pending",
      logs: [args.stdout, args.stderr].filter(Boolean).join("\n"),
      createdAt: Date.now(),
    });

    if (args.type === "build" && args.verification) {
      const status =
        args.verdict === "SUCCESS" && args.verification === "REAL"
          ? ("verified" as const)
          : args.verdict === "FAILURE" && args.verification === "REAL"
            ? ("failed" as const)
            : ("unverified" as const);
      await ctx.db.patch(args.projectId, {
        status,
        lastVerdict: args.verdict,
        lastVerification: args.verification,
        lastBuildAt: Date.now(),
      });
    }

    return runId;
  },
});

export const latest = query({
  args: { projectId: v.id("projects"), type: v.optional(runTypeValidator) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireOwnedProject(ctx, args.projectId, userId);
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(30);
    if (!args.type) return runs[0] ?? null;
    return runs.find((run) => run.type === args.type) ?? null;
  },
});
