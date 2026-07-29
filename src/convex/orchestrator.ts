import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { runBuildSimulationImpl } from "./buildSimulation";
import { makeSkeleton, inferFileType } from "./templates";

export const bootstrapProject = mutation({
  args: {
    userPrompt: v.string(),
    projectName: v.optional(v.string()),
    rtos: v.optional(v.union(v.literal("freertos"), v.literal("zephyr"))),
  },
  handler: async (ctx, args) => {
    const userId = await ctx.auth.getUserIdentity().then((id) => id?._id);
    if (!userId) {
      throw new Error("Unauthenticated");
    }

    const lower = args.userPrompt.toLowerCase();
    const detectedRtos: "freertos" | "zephyr" | null =
      args.rtos ??
      (lower.includes("zephyr")
        ? "zephyr"
        : lower.includes("freertos")
          ? "freertos"
          : null);

    if (!detectedRtos) {
      return {
        error: "RTOS_NOT_DETECTED" as const,
        message:
          "Non ho capito quale RTOS vuoi usare. Specifica 'Zephyr' o 'FreeRTOS' nel tuo messaggio.",
      };
    }

    const name =
      args.projectName ??
      args.userPrompt
        .split(/\s+/)
        .find((w) => w.length > 3 && /[A-Za-z]/.test(w))
        ?.replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 32) ??
      `${detectedRtos}_project`;

    const boardMatch = args.userPrompt.match(
      /board[\s:=]+([A-Za-z0-9_/-]+)/i,
    );
    const mcuMatch = args.userPrompt.match(/mcu[\s:=]+([A-Za-z0-9_/-]+)/i);

    const projectId = await ctx.db.insert("projects", {
      userId: userId as never,
      name,
      rtos: detectedRtos,
      status: "generating",
      description: args.userPrompt,
      board: boardMatch?.[1],
      mcu: mcuMatch?.[1],
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
      });
    }

    await ctx.db.patch(projectId, { status: "building" });

    const buildResult = await runBuildSimulationImpl(ctx, projectId);

    const buildLogs =
      buildResult.status === "success" ? buildResult.buildLogs : "";
    const testLogs =
      buildResult.status === "success" ? buildResult.testLogs : "";

    const assistantMessage = `## Report iniziale: ${name}

- **RTOS:** ${detectedRtos}
- **Build:** ${buildResult.status}
- **Test:** ${buildResult.status === "success" ? "success" : "failed"}

Il progetto è stato generato con uno skeleton RTOS-specifico. Puoi ora chiedere modifiche incrementali tramite la chat. Il sistema applicherà patch precise senza rigenerare l'intero progetto.`;

    await ctx.db.insert("messages", {
      projectId,
      role: "assistant",
      content: assistantMessage,
    });

    return {
      projectId,
      rtos: detectedRtos,
      name,
      build: { status: buildResult.status, logs: buildLogs },
      test: { status: buildResult.status, logs: testLogs },
    };
  },
});
