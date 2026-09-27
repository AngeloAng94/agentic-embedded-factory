/**
 * Bridge to the shared runner (`runner/index.ts`).
 *
 * The desktop app does NOT reimplement build/LLM/patch logic: it spawns the
 * same runner the web app dispatches to, so there is a single implementation of
 * the honest build contract and of patch validation.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RUNNER_ENTRY = path.join(__dirname, "..", "..", "runner", "index.ts");

function resolveExecutable(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function runnerCommand() {
  if (!fs.existsSync(RUNNER_ENTRY)) {
    return {
      error: `runner entry not found at ${RUNNER_ENTRY}. The desktop build must include the repository runner/ directory.`,
    };
  }
  const bun = resolveExecutable("bun");
  if (bun) return { program: bun, args: [RUNNER_ENTRY] };
  const node = resolveExecutable("node");
  if (node) {
    return { program: node, args: ["--experimental-strip-types", RUNNER_ENTRY] };
  }
  return { error: "neither bun nor node is available to run the local runner" };
}

/**
 * Runs `runner/index.ts <args...>` with an optional JSON payload file.
 * Returns { ok, payload, exitCode, stderr } — never throws.
 */
function runRunner(args, payload) {
  return new Promise((resolve) => {
    const command = runnerCommand();
    if (command.error) {
      resolve({ ok: false, code: "RUNNER_NOT_AVAILABLE", message: command.error });
      return;
    }

    let payloadPath = null;
    const argv = [...command.args, ...args];
    if (payload) {
      payloadPath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "embedfactory-desktop-")),
        "payload.json",
      );
      fs.writeFileSync(payloadPath, JSON.stringify(payload), "utf8");
      const flagIndex = argv.indexOf("--files");
      if (flagIndex >= 0) argv[flagIndex + 1] = payloadPath;
    }

    const child = spawn(command.program, argv, {
      cwd: path.join(__dirname, "..", ".."),
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      resolve({ ok: false, code: "RUNNER_SPAWN_FAILED", message: error.message });
    });
    child.on("close", (exitCode) => {
      if (payloadPath) {
        try {
          fs.rmSync(path.dirname(payloadPath), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      let payloadOut = null;
      try {
        payloadOut = JSON.parse(stdout);
      } catch {
        payloadOut = null;
      }
      resolve({ ok: exitCode === 0, exitCode, payload: payloadOut, stdout, stderr });
    });
  });
}

/** Writes the project files to a temp file the runner can read with --files. */
function writeFilesPayload(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "embedfactory-files-"));
  const filePath = path.join(dir, "files.json");
  fs.writeFileSync(filePath, JSON.stringify(files), "utf8");
  return { filePath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function spawnRunner(args) {
  const command = runnerCommand();
  if (command.error) {
    return { ok: false, code: "RUNNER_NOT_AVAILABLE", message: command.error };
  }
  return new Promise((resolve) => {
    const child = spawn(command.program, [...command.args, ...args], {
      cwd: path.join(__dirname, "..", ".."),
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) =>
      resolve({ ok: false, code: "RUNNER_SPAWN_FAILED", message: error.message }),
    );
    child.on("close", (exitCode) => {
      let payload = null;
      try {
        payload = JSON.parse(stdout);
      } catch {
        payload = null;
      }
      resolve({ ok: exitCode === 0, exitCode, payload, stdout, stderr });
    });
  });
}

module.exports = { runRunner, spawnRunner, writeFilesPayload, RUNNER_ENTRY };
