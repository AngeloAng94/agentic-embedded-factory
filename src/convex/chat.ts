import { v } from "convex/values";
import { mutation } from "./_generated/server";

export const sendMessage = mutation({
  args: {
    projectId: v.id("projects"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("messages", {
      projectId: args.projectId,
      role: "user",
      content: args.content,
    });

    const project = await ctx.db.get(args.projectId);
    const reply = project
      ? `Received your request for ${project.name}. I'll apply the change incrementally in the next iteration. For now the MVP keeps the project skeleton intact and traces the request.`
      : "Project not found. Please create a project first.";

    await ctx.db.insert("messages", {
      projectId: args.projectId,
      role: "assistant",
      content: reply,
    });

    return { reply };
  },
});
