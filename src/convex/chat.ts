import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { runBuildSimulationImpl } from "./buildSimulation";
import { inferFileType } from "./templates";

export const sendMessage = mutation({
  args: {
    projectId: v.id("projects"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      role: "user",
      content: args.content,
    });
  },
});

const ALLOWED_ROOT_FILES = new Set([
  "CMakeLists.txt",
  "README.md",
  "prj.conf",
  "Kconfig",
  "west.yml",
  ".gitignore",
]);

function isPathAllowed(path: string): boolean {
  if (!path || typeof path !== "string") return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (path.includes("..") || path.includes("~")) return false;
  if (path.includes("//") || path.includes("\\\\")) return false;

  const parts = path.split("/");
  const fileName = parts[parts.length - 1];

  if (parts.length === 1) {
    if (ALLOWED_ROOT_FILES.has(fileName)) return true;
    return false;
  }

  const first = parts[0];
  if (!["src", "include", "boards", "tests", "drivers", "app"].includes(first)) {
    return false;
  }

  const allowedExtensions = new Set([
    ".c",
    ".h",
    ".cpp",
    ".cmake",
    ".conf",
    ".overlay",
    ".yaml",
    ".yml",
    ".json",
    ".md",
    ".txt",
    ".ld",
    ".S",
  ]);
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = fileName.slice(dot);
  return allowedExtensions.has(ext.toLowerCase());
}

export const applyAgentPatch = mutation({
  args: {
    projectId: v.id("projects"),
    assistantMessage: v.string(),
    files: v.array(
      v.object({
        path: v.string(),
        content: v.string(),
      }),
    ),
    requestBuild: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error("Project not found");
    }

    const allowedFiles = args.files.filter((f) => isPathAllowed(f.path));
    const rejected = args.files.filter((f) => !isPathAllowed(f.path));

    for (const file of allowedFiles) {
      const existing = await ctx.db
        .query("projectFiles")
        .withIndex("by_project", (q) =>
          q.eq("projectId", args.projectId).eq("path", file.path),
        )
        .take(1);

      if (existing.length > 0) {
        await ctx.db.patch(existing[0]._id, {
          content: file.content,
          version: (existing[0].version ?? 1) + 1,
          status: "current",
        });
      } else {
        await ctx.db.insert("projectFiles", {
          projectId: args.projectId,
          path: file.path,
          content: file.content,
          type: inferFileType(file.path) as never,
          version: 1,
          status: "current",
        });
      }
    }

    await ctx.db.insert("messages", {
      projectId: args.projectId,
      role: "assistant",
      content:
        args.assistantMessage +
        (rejected.length > 0
          ? `\n\n_Note: ${rejected.length} file path(s) rejected by safety gate._`
          : ""),
    });

    let buildResult:
      | { status: "success"; buildLogs?: string; testLogs?: string }
      | { status: "failed"; logs: string }
      | undefined;

    if (args.requestBuild) {
      buildResult = await runBuildSimulationImpl(ctx, args.projectId);
    }

    return {
      applied: allowedFiles.length,
      rejected: rejected.length,
      buildStatus: buildResult?.status ?? null,
    };
  },
});
