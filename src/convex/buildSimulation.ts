import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export async function runBuildSimulationImpl(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<
  | { status: "success"; buildLogs: string; testLogs: string }
  | { status: "failed"; logs: string }
> {
  const project = await ctx.db.get(projectId);
  if (!project) {
    throw new Error("Project not found");
  }

  await ctx.db.patch(projectId, { status: "building" });

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
    return { status: "failed", logs };
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

  return { status: "success", buildLogs, testLogs };
}
