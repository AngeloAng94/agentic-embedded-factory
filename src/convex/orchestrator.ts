import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";
import { makeSkeleton, inferFileType } from "./templates";
import { detectBoard, detectMcu, detectProjectName, detectRtos } from "../lib/core/rtos";
import { MAX_REPAIR_ATTEMPTS } from "../lib/core/buildStatus";

/**
 * Project bootstrap.
 *
 * Creates the RTOS skeleton and records it as version 1 of every file.
 * It deliberately does NOT run a build: only a real toolchain can verify a
 * project, so the project stays `unverified` until a real build succeeds.
 */
export const bootstrapProject = mutation({
  args: {
    userPrompt: v.string(),
    projectName: v.optional(v.string()),
    rtos: v.optional(v.union(v.literal("freertos"), v.literal("zephyr"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const prompt = args.userPrompt ?? "";
    const detectedRtos = args.rtos ?? detectRtos(prompt);
    if (!detectedRtos) {
      return {
        error: "RTOS_NOT_DETECTED" as const,
        message:
          "Unable to detect the RTOS. Specify 'Zephyr' or 'FreeRTOS' in your request.",
      };
    }

    const name = args.projectName ?? detectProjectName(prompt, detectedRtos);
    const now = Date.now();

    const projectId = await ctx.db.insert("projects", {
      userId: userId as Id<"users">,
      name,
      rtos: detectedRtos,
      status: "draft",
      description: prompt,
      board: detectBoard(prompt) ?? undefined,
      mcu: detectMcu(prompt) ?? undefined,
      repairAttempts: 0,
    });

    const files = makeSkeleton(detectedRtos, name);
    for (const file of files) {
      await ctx.db.insert("projectFiles", {
        projectId,
        path: file.path,
        content: file.content,
        type: inferFileType(file.path) as never,
        version: 1,
        status: "current",
        updatedAt: now,
      });
      await ctx.db.insert("fileVersions", {
        projectId,
        path: file.path,
        version: 1,
        content: file.content,
        author: "bootstrap",
        reason: "initial project skeleton",
        createdAt: now,
      });
    }

    const assistantMessage = `## Project created: ${name}

- **RTOS:** ${detectedRtos}
- **Files:** ${files.map((file) => file.path).join(", ")}
- **Build:** NOT RUN — no compiler was invoked, so nothing is verified yet.
- **Status:** unverified

Ask for the firmware behaviour you need (e.g. "read the temperature sensor every second and log it over UART"). Each request is turned into validated patches, and the project is built with a real toolchain whenever a build runner is configured.
Up to ${MAX_REPAIR_ATTEMPTS} automatic repair attempts are used when the compiler reports errors.`;

    await ctx.db.insert("messages", {
      projectId,
      role: "assistant",
      content: assistantMessage,
      createdAt: now,
      toolCalls: JSON.stringify({
        bootstrap: true,
        build: null,
        verification: "NOT_RUN",
      }),
    });

    return {
      projectId,
      rtos: detectedRtos,
      name,
      files: files.map((file) => ({ path: file.path, version: 1 })),
      build: null,
    };
  },
});
