const Database = require("better-sqlite3");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const DB_PATH = path.join(__dirname, "..", "data", "embedfactory.db");

let db;

function getDb() {
  if (!db) {
    const fs = require("fs");
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      rtos TEXT NOT NULL CHECK (rtos IN ('freertos', 'zephyr')),
      status TEXT NOT NULL DEFAULT 'draft',
      board TEXT,
      mcu TEXT,
      toolchain TEXT,
      description TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS project_files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'other',
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'current',
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('build', 'test', 'lint')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed')),
      logs TEXT NOT NULL DEFAULT '',
      summary TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS knowledge_base (
      id TEXT PRIMARY KEY,
      rtos TEXT NOT NULL CHECK (rtos IN ('freertos', 'zephyr', 'general')),
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT
    );
  `);
}

// ─── Users ────────────────────────────────────────────────
function getOrCreateUser(name, email) {
  const d = getDb();
  const existing = d.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (existing) return existing;
  const id = uuidv4();
  d.prepare("INSERT INTO users (id, name, email) VALUES (?, ?, ?)").run(id, name, email);
  return d.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function getDefaultUser() {
  const d = getDb();
  let user = d.prepare("SELECT * FROM users LIMIT 1").get();
  if (!user) {
    user = getOrCreateUser("Local User", "local@embedfactory.dev");
  }
  return user;
}

// ─── Projects ─────────────────────────────────────────────
function createProject(userId, name, rtos, status, description, board, mcu) {
  const d = getDb();
  const id = uuidv4();
  d.prepare(
    "INSERT INTO projects (id, user_id, name, rtos, status, description, board, mcu) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, userId, name, rtos, status, description || "", board || null, mcu || null);
  return d.prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

function getProject(projectId) {
  return getDb().prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
}

function listProjects(userId) {
  return getDb()
    .prepare("SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId);
}

function updateProjectStatus(projectId, status) {
  getDb().prepare("UPDATE projects SET status = ? WHERE id = ?").run(status, projectId);
}

// ─── Project Files ────────────────────────────────────────
function insertFile(projectId, filePath, content, type) {
  const d = getDb();
  const id = uuidv4();
  d.prepare(
    "INSERT INTO project_files (id, project_id, path, content, type, version, status) VALUES (?, ?, ?, ?, ?, 1, 'current')"
  ).run(id, projectId, filePath, content, type || "other");
  return d.prepare("SELECT * FROM project_files WHERE id = ?").get(id);
}

function listFiles(projectId) {
  return getDb()
    .prepare("SELECT * FROM project_files WHERE project_id = ? ORDER BY path")
    .all(projectId);
}

function getFile(projectId, filePath) {
  return getDb()
    .prepare("SELECT * FROM project_files WHERE project_id = ? AND path = ?")
    .get(projectId, filePath);
}

function updateFile(projectId, filePath, content) {
  const existing = getFile(projectId, filePath);
  if (existing) {
    getDb()
      .prepare("UPDATE project_files SET content = ?, version = version + 1 WHERE id = ?")
      .run(content, existing.id);
    return { ...existing, content, version: existing.version + 1 };
  } else {
    return insertFile(projectId, filePath, content, inferFileType(filePath));
  }
}

// ─── Messages ─────────────────────────────────────────────
function insertMessage(projectId, role, content) {
  const d = getDb();
  const id = uuidv4();
  d.prepare("INSERT INTO messages (id, project_id, role, content) VALUES (?, ?, ?, ?)").run(
    id,
    projectId,
    role,
    content
  );
  return d.prepare("SELECT * FROM messages WHERE id = ?").get(id);
}

function listMessages(projectId) {
  return getDb()
    .prepare("SELECT * FROM messages WHERE project_id = ? ORDER BY created_at ASC")
    .all(projectId);
}

// ─── Runs ─────────────────────────────────────────────────
function insertRun(projectId, type, status, logs, summary) {
  const d = getDb();
  const id = uuidv4();
  d.prepare(
    "INSERT INTO runs (id, project_id, type, status, logs, summary) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, projectId, type, status, logs || "", summary || null);
  return d.prepare("SELECT * FROM runs WHERE id = ?").get(id);
}

function listRuns(projectId) {
  return getDb()
    .prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC")
    .all(projectId);
}

// ─── Knowledge Base ───────────────────────────────────────
function seedKnowledgeBase() {
  const d = getDb();
  const existing = d.prepare("SELECT id FROM knowledge_base LIMIT 1").get();
  if (existing) return 0;

  const entries = [
    {
      rtos: "zephyr",
      category: "structure",
      title: "Zephyr Project Layout",
      content: "A minimal Zephyr application has: CMakeLists.txt, prj.conf, boards/<board>.overlay, src/main.c. Build with: west build -b <board> -p auto",
      tags: "zephyr,west,build",
    },
    {
      rtos: "zephyr",
      category: "pattern",
      title: "Zephyr main.c template",
      content: '#include <zephyr/kernel.h>\n#include <zephyr/sys/printk.h>\n\nint main(void) {\n    printk("Hello from Zephyr\\n");\n    while (1) { k_sleep(K_SECONDS(1)); }\n    return 0;\n}',
      tags: "zephyr,template",
    },
    {
      rtos: "zephyr",
      category: "checklist",
      title: "Zephyr RTOS Checklist",
      content: "- prj.conf enables CONFIG_* needed by the application.\n- Device tree overlay matches the board.\n- CMakeLists.txt finds Zephyr.\n- main.c uses kernel.h and does not block ISR latency.\n- Stack sizes verified with CONFIG_MAIN_STACK_SIZE.",
      tags: "zephyr,checklist",
    },
    {
      rtos: "freertos",
      category: "structure",
      title: "FreeRTOS Project Layout",
      content: "A vendor-agnostic FreeRTOS project: CMakeLists.txt, FreeRTOSConfig.h, src/main.c, src/app/, src/drivers/, tests/.",
      tags: "freertos,build",
    },
    {
      rtos: "freertos",
      category: "pattern",
      title: "FreeRTOS static task pattern",
      content: '#include "FreeRTOS.h"\n#include "task.h"\n\nstatic StaticTask_t taskBuffer;\nstatic StackType_t stackBuffer[256];\n\nstatic void appTask(void *pvParameters) {\n    for (;;) { vTaskDelay(pdMS_TO_TICKS(1000)); }\n}\n\nvoid appTaskCreate(void) {\n    xTaskCreateStatic(appTask, "app", 256, NULL, 1, stackBuffer, &taskBuffer);\n}',
      tags: "freertos,static,task",
    },
    {
      rtos: "freertos",
      category: "checklist",
      title: "FreeRTOS RTOS Checklist",
      content: "- FreeRTOSConfig.h matches MCU and tick frequency.\n- Static allocation used where possible.\n- ISRs use FromISR API variants.\n- Priority inversion handled.\n- Stack overflow checking enabled.\n- No dynamic memory in deterministic paths.",
      tags: "freertos,checklist",
    },
    {
      rtos: "general",
      category: "best_practice",
      title: "Embedded Safety Rules",
      content: "- Prefer static allocation.\n- Keep ISRs short; defer to tasks.\n- Use mutexes with timeout.\n- Validate pointers and array bounds.\n- Enable watchdog and stack overflow checks.\n- Never call non-reentrant libc from ISRs.",
      tags: "safety,general",
    },
  ];

  const stmt = d.prepare(
    "INSERT INTO knowledge_base (id, rtos, category, title, content, tags) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const e of entries) {
    stmt.run(uuidv4(), e.rtos, e.category, e.title, e.content, e.tags);
  }
  return entries.length;
}

// ─── Helpers ──────────────────────────────────────────────
function inferFileType(filePath) {
  if (filePath.endsWith(".c")) return "c";
  if (filePath.endsWith(".h")) return "h";
  if (filePath.endsWith(".cpp")) return "cpp";
  if (filePath.endsWith(".cmake") || filePath.includes("CMakeLists")) return "cmake";
  if (filePath.endsWith(".conf")) return "conf";
  if (filePath.endsWith(".overlay")) return "overlay";
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) return "yaml";
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".md")) return "md";
  return "other";
}

module.exports = {
  getDb,
  getDefaultUser,
  getOrCreateUser,
  createProject,
  getProject,
  listProjects,
  updateProjectStatus,
  insertFile,
  listFiles,
  getFile,
  updateFile,
  insertMessage,
  listMessages,
  insertRun,
  listRuns,
  seedKnowledgeBase,
  inferFileType,
};
