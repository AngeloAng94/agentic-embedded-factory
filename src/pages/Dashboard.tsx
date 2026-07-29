import { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";

import { ProjectExplorer } from "@/components/workspace/ProjectExplorer";
import { FileViewer } from "@/components/workspace/FileViewer";
import { ChatPanel } from "@/components/workspace/ChatPanel";
import { BuildConsole } from "@/components/workspace/BuildConsole";
import { NewProjectDialog } from "@/components/workspace/NewProjectDialog";
import { SafetyPanel } from "@/components/workspace/SafetyPanel";
import { toast } from "sonner";
import {
  LayoutDashboard,
  Plus,
  LogOut,
  Cpu,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useNavigate } from "react-router";
import { cn } from "@/lib/utils";

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showSafety, setShowSafety] = useState(false);

  const seedKnowledgeBase = useMutation(api.knowledgeBase.seedKnowledgeBase);

  useEffect(() => {
    if (user) {
      seedKnowledgeBase().catch(() => {
        // ignore seed errors
      });
    }
  }, [user, seedKnowledgeBase]);

  const projects = useQuery(
    api.projects.list,
    user ? { userId: user._id } : "skip",
  );
  const selectedProject = useQuery(
    api.projects.get,
    selectedProjectId ? { projectId: selectedProjectId as never } : "skip",
  );
  const files = useQuery(
    api.projects.listFiles,
    selectedProjectId ? { projectId: selectedProjectId as never } : "skip",
  );
  const messages = useQuery(
    api.messages.list,
    selectedProjectId ? { projectId: selectedProjectId as never } : "skip",
  );
  const runs = useQuery(
    api.runs.list,
    selectedProjectId ? { projectId: selectedProjectId as never } : "skip",
  );

  const bootstrap = useMutation(api.orchestrator.bootstrapProject);
  const sendMessage = useMutation(api.chat.sendMessage);
  const applyAgentPatch = useMutation(api.chat.applyAgentPatch);
  const runBuild = useMutation(api.runs.runBuildSimulation);

  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const handleCreateProject = async (
    prompt: string,
    rtos: "freertos" | "zephyr",
  ) => {
    setIsBootstrapping(true);
    try {
      const result = await bootstrap({
        userPrompt: prompt,
        rtos,
      });
      if ("error" in result) {
        toast.error("Could not bootstrap", {
          description: result.message,
        });
      } else {
        toast.success("Project generated", {
          description: `${result.name} is ready for review.`,
        });
        setSelectedProjectId(result.projectId);
        setDialogOpen(false);
      }
    } catch (err) {
      toast.error("Bootstrap failed", {
        description:
          err instanceof Error ? err.message : "Unknown error. Try again.",
      });
    } finally {
      setIsBootstrapping(false);
    }
  };

  const handleSendMessage = async (content: string) => {
    if (!selectedProjectId || !selectedProject) return;
    setIsSending(true);
    try {
      await sendMessage({
        projectId: selectedProjectId as never,
        content,
      });

      const contextFiles =
        files?.map((f) => ({
          path: f.path,
          content: f.content.slice(0, 2000),
        })) ?? [];

      const prompt = buildAgentPrompt(selectedProject, contextFiles, content);
      let agentResult: AgentResult;

      try {
        agentResult = await callOllama(prompt);
      } catch (ollamaErr) {
        agentResult = deterministicFallback(
          selectedProject.rtos,
          content,
          ollamaErr instanceof Error ? ollamaErr.message : String(ollamaErr),
        );
      }

      const patchResult = await applyAgentPatch({
        projectId: selectedProjectId as never,
        assistantMessage: agentResult.message,
        files: agentResult.files,
        requestBuild: agentResult.requestBuild,
      });

      if (patchResult.applied > 0) {
        toast.success("Patch applied", {
          description: `${patchResult.applied} file(s) modified.`,
        });
      }
      if (patchResult.rejected > 0) {
        toast.warning("Safety gate", {
          description: `${patchResult.rejected} file path(s) rejected.`,
        });
      }
    } catch (err) {
      toast.error("Agent failed", {
        description:
          err instanceof Error ? err.message : "Unknown error. Try again.",
      });
    } finally {
      setIsSending(false);
    }
  };

  const handleRebuild = async () => {
    if (!selectedProjectId) return;
    setIsRebuilding(true);
    try {
      const result = await runBuild({
        projectId: selectedProjectId as never,
      });
      toast.success("Build finished", {
        description: result.status === "success" ? "Build passed" : "Build failed",
      });
    } catch (err) {
      toast.error("Rebuild failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setIsRebuilding(false);
    }
  };

  const selectedFile = files?.find((f) => f.path === selectedPath);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border/60 px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Cpu className="h-4 w-4" />
          </div>
          <h1 className="text-base font-semibold tracking-tight">
            EmbedFactory Workspace
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            onClick={() => setDialogOpen(true)}
            className="gap-1.5 rounded-full"
          >
            <Plus className="h-4 w-4" />
            New project
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleSignOut}
            className="gap-1.5 rounded-full"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar: projects */}
        <aside className="flex w-64 flex-col border-r border-border/60 bg-muted/20">
          <div className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Projects
          </div>
          <div className="flex-1 overflow-auto px-3 pb-3">
            {!projects && (
              <div className="flex items-center justify-center py-6 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            )}
            {projects?.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                No projects yet. Create one to start.
              </p>
            )}
            <div className="space-y-1">
              {projects?.map((project) => (
                <button
                  key={project._id}
                  onClick={() => {
                    setSelectedProjectId(project._id);
                    setSelectedPath(null);
                  }}
                  className={cn(
                    "w-full rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted",
                    selectedProjectId === project._id
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate">{project.name}</span>
                    <span className="text-[10px] uppercase text-muted-foreground">
                      {project.rtos}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* Main area */}
        <main className="flex flex-1 flex-col overflow-hidden">
          {selectedProjectId && selectedProject ? (
            <>
              <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
                <div>
                  <h2 className="text-sm font-semibold">
                    {selectedProject.name}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {selectedProject.rtos === "zephyr" ? "Zephyr" : "FreeRTOS"} •
                    {" "}
                    {selectedProject.status}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowSafety((s) => !s)}
                    className={cn(
                      "gap-1.5 rounded-full",
                      showSafety && "bg-muted",
                    )}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Safety
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleRebuild}
                    disabled={isRebuilding}
                    className="gap-1.5 rounded-full"
                  >
                    {isRebuilding ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Rebuild
                  </Button>
                </div>
              </div>
              <div className="flex flex-1 overflow-hidden">
                <div className="flex w-64 shrink-0 flex-col border-r border-border/60">
                  <ProjectExplorer
                    files={files ?? []}
                    selectedPath={selectedPath}
                    onSelect={setSelectedPath}
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex min-h-0 flex-1">
                    <div className="flex-1 overflow-hidden border-r border-border/60">
                      <FileViewer
                        path={selectedPath}
                        content={selectedFile?.content}
                      />
                    </div>
                    <div className="w-[380px] shrink-0">
                      <ChatPanel
                        messages={
                          messages?.map((m) => ({
                            role: m.role as "user" | "assistant" | "system",
                            content: m.content,
                          })) ?? []
                        }
                        onSend={handleSendMessage}
                        isLoading={isSending}
                        disabled={isBootstrapping}
                      />
                    </div>
                  </div>
                  <div className="h-64 shrink-0 border-t border-border/60">
                    <BuildConsole
                      runs={
                        runs?.map((r) => ({
                          type: r.type as "build" | "test" | "lint",
                          status: r.status as
                            | "pending"
                            | "running"
                            | "success"
                            | "failed",
                          logs: r.logs,
                          summary: r.summary,
                        })) ?? []
                      }
                    />
                  </div>
                </div>
                {showSafety && (
                  <div className="w-72 shrink-0">
                    <SafetyPanel
                      files={
                        files?.map((f) => ({
                          path: f.path,
                          content: f.content,
                          type: f.type,
                        })) ?? []
                      }
                      rtos={selectedProject.rtos}
                    />
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              <LayoutDashboard className="mb-4 h-12 w-12 text-muted-foreground/40" />
              <h2 className="text-xl font-semibold tracking-tight">
                Welcome to EmbedFactory
              </h2>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                Create a new embedded project to start generating firmware with
                the AI agent.
              </p>
              <Button
                onClick={() => setDialogOpen(true)}
                className="mt-6 rounded-full px-6"
              >
                <Plus className="mr-2 h-4 w-4" />
                Create project
              </Button>
            </div>
          )}
        </main>
      </div>

      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreateProject}
        isLoading={isBootstrapping}
      />
    </div>
  );
}

interface AgentResult {
  message: string;
  files: { path: string; content: string }[];
  requestBuild: boolean;
}

function buildAgentPrompt(
  project: { rtos: string; name: string; board?: string | null; mcu?: string | null },
  files: { path: string; content: string }[],
  userRequest: string,
): string {
  const fileContext = files
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");

  return `You are an expert embedded firmware engineer. The project uses ${project.rtos} and is named "${project.name}". Board: ${project.board ?? "unspecified"}, MCU: ${project.mcu ?? "unspecified"}.

Current files:
${fileContext || "(no files yet)"}

User request:
${userRequest}

Respond with a single JSON object (no markdown, no backticks) in this exact shape:
{
  "message": "Concise explanation of what you changed and why.",
  "files": [
    {"path": "src/<name>.c", "content": "full file content"}
  ],
  "requestBuild": true
}

Rules:
- Do not use absolute paths or paths with "..".
- Only create files under src/, include/, tests/, drivers/, app/, or root CMakeLists.txt / README.md / prj.conf / .gitignore.
- Use static allocation where possible. Avoid malloc/free in deterministic paths.
- Keep ISRs short and use FromISR APIs where relevant.
- requestBuild should be true unless the request is purely a question.
`;
}

async function callOllama(prompt: string): Promise<AgentResult> {
  const response = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama3",
      prompt,
      stream: false,
      format: "json",
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}`);
  }

  const data = (await response.json()) as { response?: string };
  const text = data.response ?? "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON object found in Ollama response");
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    message?: string;
    files?: { path: string; content: string }[];
    requestBuild?: boolean;
  };

  return {
    message:
      parsed.message ?? "No explanation provided.",
    files:
      parsed.files?.filter(
        (f) => typeof f.path === "string" && typeof f.content === "string",
      ) ?? [],
    requestBuild: Boolean(parsed.requestBuild),
  };
}

function deterministicFallback(
  rtos: string,
  userRequest: string,
  error: string,
): AgentResult {
  const lower = userRequest.toLowerCase();
  let extraFiles: { path: string; content: string }[] = [];

  if (lower.includes("led")) {
    extraFiles.push({
      path: "src/led.c",
      content:
        rtos === "zephyr"
          ? `#include <zephyr/kernel.h>
#include <zephyr/drivers/gpio.h>

/* Stub LED driver generated by fallback agent. */`
          : `#include "FreeRTOS.h"
#include "task.h"

/* Stub LED driver generated by fallback agent. */`,
    });
  }
  if (lower.includes("sensor") || lower.includes("temperature")) {
    extraFiles.push({
      path: "src/sensor.c",
      content:
        rtos === "zephyr"
          ? `#include <zephyr/kernel.h>
#include <zephyr/drivers/sensor.h>

/* Stub sensor driver generated by fallback agent. */`
          : `#include "FreeRTOS.h"
#include "task.h"

/* Stub sensor driver generated by fallback agent. */`,
    });
  }

  if (extraFiles.length === 0) {
    extraFiles.push({
      path: "src/app.c",
      content:
        rtos === "zephyr"
          ? `#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>

void app_init(void)
{
    printk("Application initialized.\\n");
}
`
          : `#include "FreeRTOS.h"
#include "task.h"
#include <stdio.h>

void app_init(void)
{
    printf("Application initialized.\\n");
}
`,
    });
  }

  return {
    message: `Ollama not available (${error}). Applied a deterministic fallback patch. The file(s) are stubs; refine them with a more specific request once Ollama is running.`,
    files: extraFiles,
    requestBuild: true,
  };
}
