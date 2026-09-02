/**
 * Local API client — replaces Convex queries/mutations for the desktop version.
 * All calls go to the Express server on localhost:3001.
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
  type: "build" | "test" | "lint";
  status: "pending" | "running" | "success" | "failed";
  logs: string;
  summary?: string;
}

// ─── API ──────────────────────────────────────────────────
export const api = {
  // Auth
  getUser: () => get<User>("/auth/user"),

  // Projects
  getProjects: () => get<Project[]>("/projects"),
  getProject: (id: string) => get<Project>(`/projects/${id}`),
  bootstrapProject: (userPrompt: string, rtos: "freertos" | "zephyr") =>
    post<{ projectId: string; rtos: string; name: string; build: { status: string } }>(
      "/projects/bootstrap",
      { userPrompt, rtos }
    ),

  // Files
  getFiles: (projectId: string) => get<ProjectFile[]>(`/projects/${projectId}/files`),

  // Messages
  getMessages: (projectId: string) => get<Message[]>(`/projects/${projectId}/messages`),
  sendMessage: (projectId: string, content: string) =>
    post<Message>(`/projects/${projectId}/messages`, { content }),

  // Agent patch
  applyAgentPatch: (
    projectId: string,
    assistantMessage: string,
    files: { path: string; content: string }[],
    requestBuild: boolean
  ) =>
    post<{ applied: number; rejected: number; buildStatus: string | null }>(
      `/projects/${projectId}/patch`,
      { assistantMessage, files, requestBuild }
    ),

  // Runs
  getRuns: (projectId: string) => get<Run[]>(`/projects/${projectId}/runs`),
  runBuild: (projectId: string) =>
    post<{ status: string; buildLogs?: string; testLogs?: string; logs?: string }>(
      `/projects/${projectId}/build`
    ),

  // Knowledge
  seedKnowledge: () => post<{ inserted: number }>("/knowledge/seed"),
};
