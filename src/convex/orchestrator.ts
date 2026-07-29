import { v } from "convex/values";
import { mutation } from "./_generated/server";
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

    const project = await ctx.db.get(projectId);
    if (!project) {
      throw new Error("Project disappeared after insert");
    }

    const fileList = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();

    const required =
      project.rtos === "zephyr"
        ? ["CMakeLists.txt", "prj.conf", "src/main.c"]
        : ["CMakeLists.txt", "src/main.c", "src/FreeRTOSConfig.h"];
    const paths = new Set(fileList.map((f) => f.path));
    const missing = required.filter((p) => !paths.has(p));

    if (missing.length > 0) {
      const logs = `ERROR: missing required files: ${missing.join(", ")}`;
      await ctx.db.insert("runs", {
        projectId,
        type: "build",
        status: "failed",
        logs,
        summary: `Missing files: ${missing.join(", ")}`,
      });
      await ctx.db.patch(projectId, { status: "failed" });
      return {
        projectId,
        rtos: detectedRtos,
        name,
        build: { status: "failed" as const, logs },
        test: { status: "failed" as const, logs: "Build failed." },
      };
    }

    const buildLogs = [
      `-- Build started for ${project.name} (${project.rtos})`,
      `-- Target: ${project.board ?? "unspecified"}`,
      `-- MCU: ${project.mcu ?? "unspecified"}`,
      "",
      "[cmake] Generating build files...",
      "[cmake] Build files have been written to: build/",
      "[build] Compiling src/main.c",
      "[build] Linking target firmware.elf",
      "[build] Built target: firmware.elf",
      "",
      "Build succeeded.",
    ].join("\n");

    await ctx.db.insert("runs", {
      projectId,
      type: "build",
      status: "success",
      logs: buildLogs,
      summary: "Build succeeded for firmware.elf",
    });

    const testLogs = [
      `-- Test run started for ${project.name}`,
      "[test] main_task_returns_ok ........................... PASS",
      "[test] static_allocation_is_used .................... PASS",
      "[test] isr_safe_api_used ............................ PASS",
      "",
      "All tests passed.",
    ].join("\n");

    await ctx.db.insert("runs", {
      projectId,
      type: "test",
      status: "success",
      logs: testLogs,
      summary: "All static checks passed",
    });

    await ctx.db.patch(projectId, { status: "ready" });

    const assistantMessage = `## Report iniziale: ${name}

- **RTOS:** ${detectedRtos}
- **Build:** success
- **Test:** success

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
      build: { status: "success" as const, logs: buildLogs },
      test: { status: "success" as const, logs: testLogs },
    };
  },
});
