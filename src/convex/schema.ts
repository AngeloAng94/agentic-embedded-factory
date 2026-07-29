import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

export const rtosValidator = v.union(v.literal("freertos"), v.literal("zephyr"));
export type Rtos = Infer<typeof rtosValidator>;

export const projectStatusValidator = v.union(
  v.literal("draft"),
  v.literal("requirements"),
  v.literal("generating"),
  v.literal("building"),
  v.literal("testing"),
  v.literal("ready"),
  v.literal("failed"),
);
export type ProjectStatus = Infer<typeof projectStatusValidator>;

export const fileTypeValidator = v.union(
  v.literal("c"),
  v.literal("h"),
  v.literal("cpp"),
  v.literal("cmake"),
  v.literal("conf"),
  v.literal("overlay"),
  v.literal("yaml"),
  v.literal("json"),
  v.literal("md"),
  v.literal("other"),
);
export type FileType = Infer<typeof fileTypeValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    projects: defineTable({
      userId: v.id("users"),
      name: v.string(),
      rtos: rtosValidator,
      status: projectStatusValidator,
      board: v.optional(v.string()),
      mcu: v.optional(v.string()),
      toolchain: v.optional(v.string()),
      peripherals: v.optional(v.array(v.string())),
      memoryBudget: v.optional(v.string()),
      flashBudget: v.optional(v.string()),
      constraints: v.optional(v.array(v.string())),
      description: v.optional(v.string()),
      architecture: v.optional(v.string()),
      config: v.optional(v.record(v.string(), v.any())),
    })
      .index("userId", ["userId"])
      .index("by_user_status", ["userId", "status"]),

    projectFiles: defineTable({
      projectId: v.id("projects"),
      path: v.string(),
      content: v.string(),
      type: fileTypeValidator,
      version: v.number(),
      status: v.union(v.literal("current"), v.literal("stale")),
    })
      .index("by_project", ["projectId", "path"])
      .index("by_project_type", ["projectId", "type"]),

    messages: defineTable({
      projectId: v.id("projects"),
      role: v.union(
        v.literal("user"),
        v.literal("assistant"),
        v.literal("system"),
        v.literal("tool"),
      ),
      content: v.string(),
      toolCalls: v.optional(v.string()),
    })
      .index("by_project", ["projectId"]),

    runs: defineTable({
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
    })
      .index("by_project", ["projectId"]),

    knowledgeBase: defineTable({
      rtos: v.union(v.literal("freertos"), v.literal("zephyr"), v.literal("general")),
      category: v.string(),
      title: v.string(),
      content: v.string(),
      tags: v.optional(v.array(v.string())),
    }).index("by_rtos_category", ["rtos", "category"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
