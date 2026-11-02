import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { ProjectAccessError } from "./lib/auth";
import { applyUnifiedDiff, parseUnifiedDiff } from "../lib/core/diff";
import { isPathAllowed, MAX_FILE_BYTES } from "../lib/core/pathSafety";
import type {
  ApplyPlanOutcome,
  LastBuildEvidence,
  ProjectContextPayload,
} from "./lib/contracts";
import type { Verdict, Verification } from "../lib/core/types";
import { inferFileType } from "./templates";

/**
 * Internal data access for the agent.
 *
 * `applyPlan` is all-or-nothing: patches are validated against the current
 * content of every file first; if a single operation fails nothing is written.
 * A failed patch can therefore never corrupt a file.
 */

function normalizeVerification(value: string | undefined): Verification | null {
  return value === "REAL" || value === "SIMULATED" || value === "NOT_AVAILABLE" ? value : null;
}

function normalizeVerdict(value: string | undefined): Verdict | null {
  return value === "SUCCESS" || value === "FAILURE" || value === "UNKNOWN" ? value : null;
}

export const projectContext = internalQuery({
  args: { projectId: v.id("projects"), userId: v.id("users") },
  handler: async (ctx, args): Promise<ProjectContextPayload> => {
    const project = await ctx.db.get(args.projectId);
    if (!project || project.userId !== args.userId) {
      throw new ProjectAccessError(args.projectId);
    }
    const files = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const runs = await ctx.db
      .query("runs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(20);

    const lastRun = runs.find((run) => run.type === "build") ?? null;
    const evidence: LastBuildEvidence | null = lastRun
      ? {
          verification: normalizeVerification(lastRun.verification),
          verdict: normalizeVerdict(lastRun.verdict),
          command: lastRun.command ?? null,
          toolchain: lastRun.toolchain ?? null,
          exitCode: lastRun.exitCode ?? null,
          durationMs: lastRun.durationMs ?? null,
          stdout: lastRun.stdout ?? lastRun.logs ?? "",
          stderr: lastRun.stderr ?? "",
          artifacts: lastRun.artifacts ?? [],
          reason: lastRun.reason ?? null,
          attempt: lastRun.attempt ?? 1,
          legacy: lastRun.verification === undefined,
        }
      : null;

    return {
      project: {
        name: project.name,
        rtos: project.rtos,
        board: project.board ?? null,
        mcu: project.mcu ?? null,
        description: project.description ?? null,
        status: project.status,
        lastVerdict: normalizeVerdict(project.lastVerdict),
        lastVerification: normalizeVerification(project.lastVerification),
      },
      files: files.map((file) => ({ path: file.path, content: file.content })),
      lastBuild: evidence,
    };
  },
});

export const listFiles = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (
    ctx,
    args,
  ): Promise<{ path: string; content: string; version: number }[]> => {
    const files = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    return files.map((file) => ({
      path: file.path,
      content: file.content,
      version: file.version,
    }));
  },
});

interface PlannedWrite {
  path: string;
  content: string;
  patch?: string;
  previousContent?: string;
  exists: boolean;
}

export const applyPlan = internalMutation({
  args: {
    projectId: v.id("projects"),
    agentRunId: v.string(),
    summary: v.string(),
    attempt: v.number(),
    creates: v.array(v.object({ path: v.string(), content: v.string() })),
    patches: v.array(v.object({ path: v.string(), diff: v.string() })),
  },
  handler: async (ctx, args): Promise<ApplyPlanOutcome> => {
    const files = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const byPath = new Map(files.map((file) => [file.path, file]));

    const planned: PlannedWrite[] = [];
    const failed: { path: string; code: string; reason: string }[] = [];
    const rejected: { path: string; reason: string }[] = [];
    const unchanged: string[] = [];
    const seen = new Set<string>();

    for (const create of args.creates) {
      if (!isPathAllowed(create.path)) {
        rejected.push({ path: create.path, reason: "path outside the project sandbox" });
        continue;
      }
      if (seen.has(create.path)) {
        failed.push({
          path: create.path,
          code: "DUPLICATE_OPERATION",
          reason: "the plan touches the same path twice",
        });
        continue;
      }
      seen.add(create.path);

      if (create.content.length > MAX_FILE_BYTES) {
        failed.push({
          path: create.path,
          code: "FILE_TOO_LARGE",
          reason: `content exceeds ${MAX_FILE_BYTES} bytes`,
        });
        continue;
      }
      const current = byPath.get(create.path);
      if (current) {
        if (current.content === create.content) {
          unchanged.push(create.path);
          continue;
        }
        failed.push({
          path: create.path,
          code: "CREATE_OVER_EXISTING",
          reason: "file already exists: edits to existing files must be sent as a unified diff patch",
        });
        continue;
      }
      planned.push({ path: create.path, content: create.content, exists: false });
    }

    for (const patch of args.patches) {
      if (!isPathAllowed(patch.path)) {
        rejected.push({ path: patch.path, reason: "path outside the project sandbox" });
        continue;
      }
      if (seen.has(patch.path)) {
        failed.push({
          path: patch.path,
          code: "DUPLICATE_OPERATION",
          reason: "the plan touches the same path twice",
        });
        continue;
      }
      seen.add(patch.path);

      const current = byPath.get(patch.path);
      if (!current) {
        failed.push({
          path: patch.path,
          code: "PATCH_TARGET_MISSING",
          reason: "patch targets a file that does not exist: send it as a create",
        });
        continue;
      }

      const parsed = parseUnifiedDiff(patch.diff);
      if (!parsed.ok) {
        failed.push({ path: patch.path, code: "PATCH_FAILED", reason: parsed.reason });
        continue;
      }
      if (parsed.parsed.filePath && parsed.parsed.filePath !== patch.path) {
        failed.push({
          path: patch.path,
          code: "PATCH_PATH_MISMATCH",
          reason: `diff header targets "${parsed.parsed.filePath}"`,
        });
        continue;
      }

      const outcome = applyUnifiedDiff(current.content, patch.diff);
      if (!outcome.ok) {
        failed.push({ path: patch.path, code: "PATCH_FAILED", reason: outcome.reason });
        continue;
      }
      if (outcome.content === current.content) {
        unchanged.push(patch.path);
        continue;
      }
      if (outcome.content.length > MAX_FILE_BYTES) {
        failed.push({
          path: patch.path,
          code: "FILE_TOO_LARGE",
          reason: `result exceeds ${MAX_FILE_BYTES} bytes`,
        });
        continue;
      }
      planned.push({
        path: patch.path,
        content: outcome.content,
        patch: patch.diff,
        previousContent: current.content,
        exists: true,
      });
    }

    // All-or-nothing: nothing is written when one operation failed.
    if (failed.length > 0) {
      return { applied: [], failed, rejected, unchanged };
    }

    const applied: { path: string; version: number; kind: "create" | "patch" }[] = [];
    const now = Date.now();

    for (const op of planned) {
      const current = byPath.get(op.path);
      if (current) {
        const version = (current.version ?? 1) + 1;
        await ctx.db.patch(current._id, {
          content: op.content,
          version,
          status: "current",
          updatedAt: now,
        });
        await ctx.db.insert("fileVersions", {
          projectId: args.projectId,
          path: op.path,
          version,
          content: op.content,
          previousContent: op.previousContent,
          patch: op.patch,
          author: "agent",
          reason: args.summary.slice(0, 500),
          createdAt: now,
          agentRunId: args.agentRunId,
        });
        applied.push({ path: op.path, version, kind: "patch" });
      } else {
        await ctx.db.insert("projectFiles", {
          projectId: args.projectId,
          path: op.path,
          content: op.content,
          type: inferFileType(op.path) as never,
          version: 1,
          status: "current",
          updatedAt: now,
        });
        await ctx.db.insert("fileVersions", {
          projectId: args.projectId,
          path: op.path,
          version: 1,
          content: op.content,
          author: "agent",
          reason: args.summary.slice(0, 500),
          createdAt: now,
          agentRunId: args.agentRunId,
        });
        applied.push({ path: op.path, version: 1, kind: "create" });
      }
    }

    if (applied.length > 0) {
      await ctx.db.patch(args.projectId, {
        status: "unverified",
        repairAttempts: args.attempt,
      });
    }

    return { applied, failed, rejected, unchanged };
  },
});

export const attachBuildToVersions = internalMutation({
  args: {
    projectId: v.id("projects"),
    agentRunId: v.string(),
    buildRunId: v.id("runs"),
    verdict: v.union(v.literal("SUCCESS"), v.literal("FAILURE"), v.literal("UNKNOWN")),
  },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query("fileVersions")
      .withIndex("by_project_created", (q) => q.eq("projectId", args.projectId))
      .collect();
    let updated = 0;
    for (const row of rows) {
      if (row.agentRunId !== args.agentRunId) continue;
      await ctx.db.patch(row._id, { buildRunId: args.buildRunId, buildVerdict: args.verdict });
      updated += 1;
    }
    return updated;
  },
});
