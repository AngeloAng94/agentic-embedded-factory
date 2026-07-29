import { v } from "convex/values";
import { mutation } from "./_generated/server";

export const patch = mutation({
  args: {
    id: v.id("projectFiles"),
    content: v.optional(v.string()),
    version: v.optional(v.number()),
    status: v.optional(v.union(v.literal("current"), v.literal("stale"))),
  },
  handler: async (ctx, args) => {
    const update: Partial<{
      content: string;
      version: number;
      status: "current" | "stale";
    }> = {};
    if (args.content !== undefined) update.content = args.content;
    if (args.version !== undefined) update.version = args.version;
    if (args.status !== undefined) update.status = args.status;
    await ctx.db.patch(args.id, update);
  },
});
