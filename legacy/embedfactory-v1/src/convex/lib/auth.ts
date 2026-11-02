import { getAuthUserId } from "@convex-dev/auth/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Authorization helpers.
 *
 * Identity ALWAYS comes from the authenticated session — a `userId` sent by the
 * client is never trusted. Every data access path goes through these helpers.
 */

export type AnyCtx = QueryCtx | MutationCtx | ActionCtx;

export class NotAuthenticatedError extends Error {
  constructor() {
    super("Not authenticated: sign in to access this resource.");
    this.name = "NotAuthenticatedError";
  }
}

export class ProjectAccessError extends Error {
  constructor(projectId: string) {
    // Deliberately indistinguishable from "missing" to avoid leaking ids.
    super(`Project ${projectId} not found or not accessible for this user.`);
    this.name = "ProjectAccessError";
  }
}

export async function requireUserId(ctx: AnyCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new NotAuthenticatedError();
  return userId as Id<"users">;
}

/** Loads a project only when it belongs to the authenticated user. */
export async function requireOwnedProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
  userId: Id<"users">,
): Promise<Doc<"projects">> {
  const project = await ctx.db.get(projectId);
  if (!project) throw new ProjectAccessError(projectId);
  if (project.userId !== userId) {
    throw new ProjectAccessError(projectId);
  }
  return project;
}

