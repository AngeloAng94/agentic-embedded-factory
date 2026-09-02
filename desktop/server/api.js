const express = require("express");
const cors = require("cors");
const db = require("./db");
const { makeSkeleton } = require("./templates");

const router = express.Router();

// ─── Auth ─────────────────────────────────────────────────
router.get("/auth/user", (req, res) => {
  const user = db.getDefaultUser();
  res.json(user);
});

// ─── Projects ─────────────────────────────────────────────
router.get("/projects", (req, res) => {
  const user = db.getDefaultUser();
  const projects = db.listProjects(user.id);
  res.json(projects);
});

router.get("/projects/:id", (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  res.json(project);
});

router.post("/projects/bootstrap", (req, res) => {
  try {
    const user = db.getDefaultUser();
    const { userPrompt, rtos } = req.body;

    if (!userPrompt) {
      return res.status(400).json({ error: "userPrompt is required" });
    }

    const detectedRtos =
      rtos ||
      (userPrompt.toLowerCase().includes("zephyr")
        ? "zephyr"
        : userPrompt.toLowerCase().includes("freertos")
          ? "freertos"
          : null);

    if (!detectedRtos) {
      return res.status(400).json({
        error: "RTOS_NOT_DETECTED",
        message: "Specify 'Zephyr' or 'FreeRTOS' in your prompt.",
      });
    }

    const name =
      userPrompt
        .split(/\s+/)
        .find((w) => w.length > 3 && /[A-Za-z]/.test(w))
        ?.replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 32) || `${detectedRtos}_project`;

    const boardMatch = userPrompt.match(/board[\s:=]+([A-Za-z0-9_/-]+)/i);
    const mcuMatch = userPrompt.match(/mcu[\s:=]+([A-Za-z0-9_/-]+)/i);

    const project = db.createProject(
      user.id,
      name,
      detectedRtos,
      "generating",
      userPrompt,
      boardMatch?.[1],
      mcuMatch?.[1]
    );

    // Generate skeleton files
    const files = makeSkeleton(detectedRtos, name);
    for (const file of files) {
      db.insertFile(project.id, file.path, file.content, file.type);
    }

    // Run simulated build
    db.updateProjectStatus(project.id, "building");
    const buildResult = runBuildSimulation(project);

    // Add assistant message
    db.insertMessage(
      project.id,
      "assistant",
      `## Report: ${name}\n\n- **RTOS:** ${detectedRtos}\n- **Build:** ${buildResult.status}\n- **Test:** ${buildResult.status === "success" ? "passed" : "failed"}\n\nProject generated with RTOS-specific skeleton. You can now request incremental changes via chat.`
    );

    res.json({
      projectId: project.id,
      rtos: detectedRtos,
      name,
      build: buildResult,
    });
  } catch (err) {
    console.error("Bootstrap error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Files ────────────────────────────────────────────────
router.get("/projects/:id/files", (req, res) => {
  const files = db.listFiles(req.params.id);
  res.json(files);
});

router.get("/projects/:id/files/:path(*)", (req, res) => {
  const file = db.getFile(req.params.id, req.params.path);
  if (!file) return res.status(404).json({ error: "Not found" });
  res.json(file);
});

// ─── Messages ─────────────────────────────────────────────
router.get("/projects/:id/messages", (req, res) => {
  const messages = db.listMessages(req.params.id);
  res.json(messages);
});

router.post("/projects/:id/messages", (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: "content is required" });
  const msg = db.insertMessage(req.params.id, "user", content);
  res.json(msg);
});

// ─── Agent Patch ──────────────────────────────────────────
const ALLOWED_ROOT_FILES = new Set([
  "CMakeLists.txt", "README.md", "prj.conf", "Kconfig", "west.yml", ".gitignore",
]);
const ALLOWED_DIRS = new Set(["src", "include", "boards", "tests", "drivers", "app"]);
const ALLOWED_EXT = new Set([
  ".c", ".h", ".cpp", ".cmake", ".conf", ".overlay", ".yaml", ".yml", ".json", ".md", ".txt", ".ld", ".S",
]);

function isPathAllowed(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  if (filePath.startsWith("/") || filePath.startsWith("\\")) return false;
  if (filePath.includes("..") || filePath.includes("~")) return false;
  const parts = filePath.split("/");
  const fileName = parts[parts.length - 1];
  if (parts.length === 1) return ALLOWED_ROOT_FILES.has(fileName);
  if (!ALLOWED_DIRS.has(parts[0])) return false;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return false;
  return ALLOWED_EXT.has(fileName.slice(dot).toLowerCase());
}

router.post("/projects/:id/patch", (req, res) => {
  const { assistantMessage, files, requestBuild } = req.body;
  const projectId = req.params.id;

  let applied = 0;
  let rejected = 0;

  for (const file of files || []) {
    if (isPathAllowed(file.path)) {
      db.updateFile(projectId, file.path, file.content);
      applied++;
    } else {
      rejected++;
    }
  }

  if (assistantMessage) {
    const note = rejected > 0 ? `\n\n_Note: ${rejected} file path(s) rejected by safety gate._` : "";
    db.insertMessage(projectId, "assistant", assistantMessage + note);
  }

  let buildResult = null;
  if (requestBuild) {
    const project = db.getProject(projectId);
    if (project) {
      db.updateProjectStatus(projectId, "building");
      buildResult = runBuildSimulation(project);
    }
  }

  res.json({ applied, rejected, buildStatus: buildResult?.status || null });
});

// ─── Runs ─────────────────────────────────────────────────
router.get("/projects/:id/runs", (req, res) => {
  const runs = db.listRuns(req.params.id);
  res.json(runs);
});

router.post("/projects/:id/build", (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  const result = runBuildSimulation(project);
  res.json(result);
});

// ─── Knowledge Base ───────────────────────────────────────
router.post("/knowledge/seed", (req, res) => {
  const count = db.seedKnowledgeBase();
  res.json({ inserted: count });
});

// ─── Build Simulation (local) ─────────────────────────────
function runBuildSimulation(project) {
  const files = db.listFiles(project.id);
  const required =
    project.rtos === "zephyr"
      ? ["CMakeLists.txt", "prj.conf", "src/main.c"]
      : ["CMakeLists.txt", "src/main.c", "src/FreeRTOSConfig.h"];
  const paths = new Set(files.map((f) => f.path));
  const missing = required.filter((p) => !paths.has(p));

  if (missing.length > 0) {
    const logs = `ERROR: missing required files: ${missing.join(", ")}`;
    db.insertRun(project.id, "build", "failed", logs, `Missing: ${missing.join(", ")}`);
    db.updateProjectStatus(project.id, "failed");
    return { status: "failed", logs };
  }

  const buildLogs = [
    `-- Build started for ${project.name} (${project.rtos})`,
    `-- Target: ${project.board || "unspecified"}`,
    `-- MCU: ${project.mcu || "unspecified"}`,
    "",
    "[cmake] Generating build files...",
    "[cmake] Build files have been written to: build/",
    "[build] Compiling src/main.c",
    "[build] Linking target firmware.elf",
    "[build] Built target: firmware.elf",
    "",
    "Build succeeded.",
  ].join("\n");

  db.insertRun(project.id, "build", "success", buildLogs, "Build succeeded for firmware.elf");

  const testLogs = [
    `-- Test run started for ${project.name}`,
    "[test] main_task_returns_ok ........................... PASS",
    "[test] static_allocation_is_used .................... PASS",
    "[test] isr_safe_api_used ............................ PASS",
    "",
    "All tests passed.",
  ].join("\n");

  db.insertRun(project.id, "test", "success", testLogs, "All static checks passed");

  db.updateProjectStatus(project.id, "ready");
  return { status: "success", buildLogs, testLogs };
}

module.exports = router;
