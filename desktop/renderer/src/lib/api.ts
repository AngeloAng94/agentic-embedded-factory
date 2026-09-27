/**
 * Local API client for the desktop app.
 *
 * The Express server owns the LLM call, patch validation and the real build
 * (through the shared runner): the browser never talks to a provider directly
 * and never invents a build result.
 */

const BASE = "http://localhost:3001/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `POST ${path} failed: ${res.status}`);
  }
  return res.json();
}

// ─── Types ────────────────────────────────────────────────
export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  rtos: "freertos" | "zephyr";
  status: string;
  board?: string | null;
  mcu?: string | null;
  description?: string;
  last_verdict?: string | null;
  last_verification?: string | null;
}

export interface ProjectFile {
  id: string;
  project_id: string;
  path: string;
  content: string;
  type: string;
  version: number;
  status: string;
}

export interface Message {
  id: string;
  project_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

export interface Run {
  id: string;
  project_id: string;
  type: string;
  status: "pending" | "running" | "success" | "failed";
  logs: string;
  summary?: string;
  evidence?: string | null;
}

export interface Version {
  id: string;
  project_id: string;
  path: string;
  version: number;
  author: string;
  reason?: string | null;
  patch?: string | null;
  build_verdict?: string | null;
  created_at: number;
  content: string;
}

export interface AgentTurnResult {
  ok: boolean;
  code?: string;
  status?: string;
  message?: string;
  attempts?: number;
  writes?: number;
  build?: { verification: string; verdict: string; exitCode: number | null } | null;
}

export interface ExportResult {
  ok: boolean;
  outDir?: string;
  written?: number;
  message?: string;
}

export interface GitResult {
  ok: boolean;
  code?: string;
  message?: string;
  steps?: { command: string; exitCode: number }[];
}

// ─── API ──────────────────────────────────────────────────
export const api = {
  getUser: () => get<User>("/auth/user"),

  getProjects: () => get<Project[]>("/projects"),
  getProject: (id: string) => get<Project>(`/projects/${id}`),
  bootstrapProject: (
    userPrompt: string,
    rtos: "freertos" | "zephyr",
  ) =>
    post<{ projectId: string; rtos: string; name: string; build: null }>(
      "/projects/bootstrap",
      { userPrompt, rtos },
    ),
  deleteProject: (id: string) => post<{ deleted: boolean }>(`/projects/${id}`),

  getFiles: (projectId: string) => get<ProjectFile[]>(`/projects/${projectId}/files`),
  getFile: (projectId: string, path: string) =>
    get<ProjectFile>(`/projects/${projectId}/files/${path}`),

  getMessages: (projectId: string) => get<Message[]>(`/projects/${projectId}/messages`),
  sendMessage: (projectId: string, content: string) =>
    post<Message>(`/projects/${projectId}/messages`, { content }),

  /** Full agent turn: server-side LLM, validated patches, real build. */
  runAgent: (projectId: string, userMessage: string) =>
    post<AgentTurnResult>(`/projects/${projectId}/agent`, { userMessage }),

  getRuns: (projectId: string) => get<Run[]>(`/projects/${projectId}/runs`),
  runBuild: (projectId: string) =>
    post<{ ok: boolean; code?: string; build: unknown }>(`/projects/${projectId}/build`),

  getVersions: (projectId: string) => get<Version[]>(`/projects/${projectId}/versions`),
  rollback: (projectId: string, versionId: string) =>
    post<{ path: string; version: number; restoredFrom: number }>(
      `/projects/${projectId}/rollback`,
      { versionId },
    ),

  exportProject: (projectId: string, outDir: string) =>
    post<ExportResult>(`/projects/${projectId}/export`, { outDir }),

  gitInit: (projectId: string, message?: string) =>
    post<GitResult>(`/projects/${projectId}/git`, { message }),

  seedKnowledge: () => post<{ inserted: number }>("/knowledge/seed"),
};

/** Parses the evidence JSON stored with each run (honest verification model). */
export function parseEvidence(run: Run): {
  verification: string | null;
  verdict: string | null;
  command: string | null;
  toolchain: string | null;
  exitCode: number | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  artifacts: string[];
  reason: string | null;
  attempt: number | null;
  legacy: boolean;
} {
  if (run.evidence) {
    try {
      const parsed = JSON.parse(run.evidence) as Record<string, unknown>;
      return {
        verification: (parsed.verification as string) ?? null,
        verdict: (parsed.verdict as string) ?? null,
        command: (parsed.command as string) ?? null,
        toolchain: (parsed.toolchain as string) ?? null,
        exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : null,
        durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : null,
        stdout: typeof parsed.stdout === "string" ? parsed.stdout : run.logs ?? "",
        stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
        artifacts: Array.isArray(parsed.artifacts) ? (parsed.artifacts as string[]) : [],
        reason: (parsed.reason as string) ?? null,
        attempt: typeof parsed.attempt === "number" ? parsed.attempt : null,
        legacy: false,
      };
    } catch {
      /* fall through to the legacy shape */
    }
  }
  return {
    verification: null,
    verdict: null,
    command: null,
    toolchain: null,
    exitCode: null,
    durationMs: null,
    stdout: run.logs ?? "",
    stderr: "",
    artifacts: [],
    reason: "row written before the honest verification model",
    attempt: null,
    legacy: true,
  };
}
