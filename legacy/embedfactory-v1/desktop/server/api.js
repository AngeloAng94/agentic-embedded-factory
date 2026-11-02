const express = require("express");
const cors = require("cors");
const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("./db");
const { makeSkeleton } = require("./templates");
const { runRunner } = require("./runner-bridge");

const router = express.Router();

const MAX_REPAIR_ATTEMPTS = 3;

function isSafeRelativePath(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  if (filePath.startsWith("/") || filePath.startsWith("\\")) return false;
  if (filePath.includes("..") || filePath.includes("~")) return false;
  return true;
}

function writeTempJson(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "embedfactory-kb-"));
  const file = path.join(dir, "knowledge.json");
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function projectFilesPayload(projectId) {
  return db.listFiles(projectId).map((file) => ({ path: file.path, content: file.content }));
}

function buildEvidence(build, type = "build", extra = {}) {
  if (!build) {
    return {
      type,
      verification: "NOT_AVAILABLE",
      verdict: "UNKNOWN",
      command: null,
      exitCode: null,
      durationMs: null,
      stdout: "",
      stderr: "",
      artifacts: [],
      reason: "no build result was produced",
      ...extra,
    };
  }
  return {
    type,
    verification: build.verification,
    verdict: build.verdict,
    command: build.command || null,
    toolchain: build.toolchain || null,
    exitCode: typeof build.exitCode === "number" ? build.exitCode : null,
    durationMs: typeof build.durationMs === "number" ? build.durationMs : null,
    stdout: String(build.stdout || "").slice(0, 40000),
    stderr: String(build.stderr || "").slice(0, 40000),
    artifacts: build.artifacts || [],
    reason: build.reason || null,
    attempt: build.attempt || 1,
    ...extra,
  };
}

function formatBuildReport(build) {
  if (!build) return "No build result was produced.";
  return [
    "BUILD",
    "─────",
    `Command: ${build.command || "(none)"}`,
    `Exit code: ${build.exitCode === null || build.exitCode === undefined ? "n/a" : build.exitCode}`,
    `Duration: ${build.durationMs ? `${(build.durationMs / 1000).toFixed(1)}s` : "n/a"}`,
    "",
    "stdout:",
    (build.stdout || "").trim() || "(empty)",
    "",
    "stderr:",
    (build.stderr || "").trim() || "(empty)",
    "",
    build.artifacts && build.artifacts.length > 0 ? `Artifacts: ${build.artifacts.join(", ")}` : "",
    build.reason ? `Reason: ${build.reason}` : "",
    `Status: ${build.verification} · ${build.verdict}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── Auth ─────────────────────────────────────────────────
router.get("/auth/user", (req, res) => {
  res.json(db.getDefaultUser());
});

// ─── Projects ─────────────────────────────────────────────
router.get("/projects", (req, res) => {
  const user = db.getDefaultUser();
  res.json(db.listProjects(user.id));
});

router.get("/projects/:id", (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  res.json(project);
});

router.post("/projects/bootstrap", (req, res) => {
  try {
    const user = db.getDefaultUser();
    const { userPrompt, rtos, projectName } = req.body || {};
    if (!userPrompt) return res.status(400).json({ error: "userPrompt is required" });

    const lower = userPrompt.toLowerCase();
    const detectedRtos =
      rtos ||
      (lower.includes("zephyr") ? "zephyr" : lower.includes("freertos") ? "freertos" : null);

    if (!detectedRtos) {
      return res.status(400).json({
        error: "RTOS_NOT_DETECTED",
        message: "Specify 'Zephyr' or 'FreeRTOS' in your prompt.",
      });
    }

    const name =
      projectName ||
      userPrompt
        .split(/\s+/)
        .find((word) => word.length > 3 && /[a-zA-Z]/.test(word))
        ?.replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 32) ||
      `${detectedRtos}_project`;

    const boardMatch = userPrompt.match(/board[\s:=]+([A-Za-z0-9_/-]+)/i);
    const mcuMatch = userPrompt.match(/mcu[\s:=]+([A-Za-z0-9_/-]+)/i);

    // The project starts as unverified: no compiler has been invoked.
    const project = db.createProject(
      user.id,
      name,
      detectedRtos,
      "unverified",
      userPrompt,
      boardMatch ? boardMatch[1].toLowerCase() : undefined,
      mcuMatch ? mcuMatch[1] : undefined,
    );

    for (const file of makeSkeleton(detectedRtos, name)) {
      db.updateFileVersioned(project.id, file.path, file.content, {
        author: "bootstrap",
        reason: "initial project skeleton",
      });
    }

    db.insertMessage(
      project.id,
      "assistant",
      `## Project created: ${name}\n\n- **RTOS:** ${detectedRtos}\n- **Build:** NOT RUN — no compiler was invoked, so nothing is verified yet.\n- **Status:** unverified\n\nDescribe the firmware behaviour you need: each request becomes validated patches and is built with a real toolchain (up to ${MAX_REPAIR_ATTEMPTS} automatic repair attempts).`,
    );

    res.json({ projectId: project.id, rtos: detectedRtos, name, build: null });
  } catch (error) {
    console.error("Bootstrap error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.delete("/projects/:id", (req, res) => {
  db.getDb().prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);
  res.json({ deleted: true });
});

// ─── Files ────────────────────────────────────────────────
router.get("/projects/:id/files", (req, res) => {
  res.json(db.listFiles(req.params.id));
});

router.get("/projects/:id/files/:path(*)", (req, res) => {
  const file = db.getFile(req.params.id, req.params.path);
  if (!file) return res.status(404).json({ error: "Not found" });
  res.json(file);
});

// ─── Messages ─────────────────────────────────────────────
router.get("/projects/:id/messages", (req, res) => {
  res.json(db.listMessages(req.params.id));
});

router.post("/projects/:id/messages", (req, res) => {
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: "content is required" });
  res.json(db.insertMessage(req.params.id, "user", content));
});

// ─── Agent turn (server side, real LLM, validated patches, real build) ────
router.post("/projects/:id/agent", async (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });

  const { userMessage, maxRepairAttempts } = req.body || {};
  if (!userMessage) return res.status(400).json({ error: "userMessage is required" });

  const maxAttempts = Math.min(Math.max(Number(maxRepairAttempts) || MAX_REPAIR_ATTEMPTS, 1), 4);
  db.insertMessage(project.id, "user", userMessage);

  const knowledge = db.listKnowledgeDocuments();
  const kb = writeTempJson(knowledge);

  let files = projectFilesPayload(project.id);
  let lastBuild = null;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const run = await runRunner(
        [
          "turn",
          "--files",
          "",
          "--request",
          userMessage,
          "--name",
          project.name,
          "--rtos",
          project.rtos,
          "--board",
          project.board || "",
          "--knowledge",
          kb.file,
          "--build",
          "--json",
        ],
        files,
      );

      const payload = run.payload;
      if (!payload) {
        const message = `**Agent unavailable — no files were changed.**\n\n${
          run.stderr || run.message || "the local runner produced no result"
        }`;
        db.insertMessage(project.id, "assistant", message);
        return res.status(200).json({ ok: false, code: "RUNNER_NOT_AVAILABLE", message });
      }

      if (payload.knowledgeLog) {
        db.insertRun(project.id, {
          type: "retrieval",
          verification: "REAL",
          verdict: "SUCCESS",
          stdout: String(payload.knowledgeLog),
          reason: "knowledge base retrieval evidence",
          summary: "retrieval",
        });
      }

      if (payload.ok === false) {
        const message = `**${payload.code}: nothing was written.**\n\n${payload.message}`;
        db.insertMessage(project.id, "assistant", message);
        return res.status(200).json({ ok: false, code: payload.code, message: payload.message });
      }

      for (const write of payload.writes || []) {
        if (!isSafeRelativePath(write.path)) continue;
        db.updateFileVersioned(project.id, write.path, write.content, {
          author: "agent",
          reason: payload.summary || "agent change",
          patch: write.patch || null,
        });
      }

      if (payload.safety) {
        db.insertRun(project.id, {
          type: "safety",
          verification: "REAL",
          verdict: payload.safety.summary.fail > 0 ? "FAILURE" : "SUCCESS",
          stdout: [
            `engine: ${payload.safety.engine} (${payload.safety.rtos})`,
            `summary: ${payload.safety.summary.pass} PASS / ${payload.safety.summary.warning} WARNING / ${payload.safety.summary.fail} FAIL`,
            ...payload.safety.findings.map(
              (finding) =>
                `[${finding.status}] ${finding.rule} (${finding.severity}) ${finding.file}${
                  finding.line === null ? "" : `:${finding.line}`
                } — ${finding.explanation}`,
            ),
          ].join("\n"),
          summary: `${payload.safety.summary.pass} PASS / ${payload.safety.summary.warning} WARNING / ${payload.safety.summary.fail} FAIL`,
          reason: "static analysis of the current sources",
        });
      }

      const writes = (payload.writes || []).length;
      const summary =
        writes > 0
          ? `${writes} file(s) written (${(payload.writes || [])
              .map((write) => `${write.path} ${write.kind}`)
              .join(", ")})`
          : "no file change";

      if (!payload.requestBuild) {
        db.insertMessage(project.id, "assistant", `${payload.summary}\n\n_${summary}. No build requested._`);
        return res.status(200).json({ ok: true, status: payload.status, writes });
      }

      lastBuild = payload.build || null;
      if (!lastBuild) {
        db.insertMessage(
          project.id,
          "assistant",
          `**Build NOT AVAILABLE — nothing was verified.**\n\nNo build result was produced by the runner.\n${summary}`,
        );
        return res.status(200).json({ ok: true, status: "BUILD_NOT_AVAILABLE", writes });
      }

      const runRow = db.insertRun(
        project.id,
        buildEvidence(lastBuild, "build", { patchSummary: summary, attempt }),
      );

      if (lastBuild.verdict === "SUCCESS" && lastBuild.verification === "REAL") {
        const message = `## BUILD SUCCESS (real toolchain)\n\n${formatBuildReport(lastBuild)}\n\n### Change\n\n${payload.summary}\n\n${summary}`;
        db.insertMessage(project.id, "assistant", message);
        return res.status(200).json({
          ok: true,
          status: "SUCCESS",
          attempts: attempt,
          build: lastBuild,
          runId: runRow.id,
        });
      }

      if (attempt >= maxAttempts) break;
      files = projectFilesPayload(project.id);
    }

    const message = `## BUILD FAILED — REPAIR LIMIT REACHED\n\n${formatBuildReport(lastBuild)}\n\nAttempts used: ${maxAttempts}/${maxAttempts}.`;
    db.insertMessage(project.id, "assistant", message);
    return res.status(200).json({
      ok: false,
      code: "REPAIR_LIMIT_REACHED",
      message,
      attempts: maxAttempts,
      build: lastBuild,
    });
  } finally {
    kb.cleanup();
  }
});

// ─── Build ────────────────────────────────────────────────
router.post("/projects/:id/build", async (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });

  const run = await runRunner(
    [
      "build",
      "--files",
      "",
      "--rtos",
      project.rtos,
      "--board",
      project.board || "",
      "--json",
    ],
    projectFilesPayload(project.id),
  );

  if (!run.payload) {
    const evidence = buildEvidence(null, "build", {
      reason: run.message || "the local runner produced no result",
    });
    db.insertRun(project.id, evidence);
    db.insertMessage(project.id, "assistant", `**Build NOT AVAILABLE**\n\n${evidence.reason}`);
    return res.status(200).json({ ok: false, code: "RUNNER_NOT_AVAILABLE", build: evidence });
  }

  db.insertRun(project.id, buildEvidence(run.payload, "build"));
  db.insertMessage(project.id, "assistant", formatBuildReport(run.payload));
  res.json({ ok: true, build: run.payload });
});

// ─── Runs ─────────────────────────────────────────────────
router.get("/projects/:id/runs", (req, res) => {
  res.json(db.listRuns(req.params.id));
});

// ─── Versions / rollback ──────────────────────────────────
router.get("/projects/:id/versions", (req, res) => {
  res.json(db.listVersions(req.params.id));
});

router.post("/projects/:id/rollback", (req, res) => {
  const { versionId } = req.body || {};
  const version = versionId ? db.getVersion(versionId) : null;
  if (!version || version.project_id !== req.params.id) {
    return res.status(404).json({ error: "Version not found for this project" });
  }
  const updated = db.updateFileVersioned(req.params.id, version.path, version.content, {
    author: "rollback",
    reason: `restored v${version.version} (${version.author})`,
  });
  db.updateProjectStatus(req.params.id, "unverified");
  res.json({ path: version.path, version: updated.version, restoredFrom: version.version });
});

// ─── Export to a real directory ───────────────────────────
router.post("/projects/:id/export", async (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });

  const outDir = req.body && req.body.outDir;
  if (!outDir) {
    return res.status(400).json({
      ok: false,
      message: "outDir is required: choose a local directory to write the project into",
    });
  }

  const run = await runRunner([
    "export",
    "--files",
    "",
    "--out",
    path.resolve(outDir),
    "--name",
    project.name,
    "--rtos",
    project.rtos,
    "--board",
    project.board || "",
    "--json",
  ], projectFilesPayload(project.id));
  res.json(
    run.payload || {
      ok: false,
      message: run.stderr || run.message || "export failed",
    },
  );
});

// ─── Git ──────────────────────────────────────────────────
router.post("/projects/:id/git", async (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });

  const message =
    (req.body && req.body.message) || `Initial commit from EmbedFactory (${project.name})`;
  const run = await runRunner([
    "git",
    "--files",
    "",
    "--message",
    message,
    "--json",
  ], projectFilesPayload(project.id));

  if (!run.payload) {
    return res.json({
      ok: false,
      message: run.stderr || run.message || "git could not be executed",
    });
  }
  res.json(run.payload);
});

// ─── Knowledge Base ───────────────────────────────────────
router.post("/knowledge/seed", (req, res) => {
  res.json({ inserted: db.seedKnowledgeBase() });
});

router.get("/knowledge", (req, res) => {
  res.json(db.listKnowledgeDocuments());
});

module.exports = router;
