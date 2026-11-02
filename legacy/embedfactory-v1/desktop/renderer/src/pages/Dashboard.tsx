import { useState, useEffect } from "react";
import {
  api,
  parseEvidence,
  type Project,
  type ProjectFile,
  type Message,
  type Run,
} from "../lib/api";
import { Button } from "../components/ui/button";
import { ProjectExplorer } from "../components/workspace/ProjectExplorer";
import { FileViewer } from "../components/workspace/FileViewer";
import { ChatPanel } from "../components/workspace/ChatPanel";
import { BuildConsole } from "../components/workspace/BuildConsole";
import { NewProjectDialog } from "../components/workspace/NewProjectDialog";
import { SafetyPanel } from "../components/workspace/SafetyPanel";
import {
  LayoutDashboard,
  Plus,
  Cpu,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useNavigate } from "react-router";
import { cn } from "../lib/utils";

export default function Dashboard() {
  const navigate = useNavigate();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showSafety, setShowSafety] = useState(false);

  // Data state
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);

  // Loading states
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);

  // Seed knowledge base on mount
  useEffect(() => {
    api.seedKnowledge().catch(() => {});
  }, []);

  // Load projects
  useEffect(() => {
    setLoading(true);
    api.getProjects().then(setProjects).finally(() => setLoading(false));
  }, []);

  // Load project details when selected
  useEffect(() => {
    if (!selectedProjectId) {
      setSelectedProject(null);
      setFiles([]);
      setMessages([]);
      setRuns([]);
      return;
    }
    Promise.all([
      api.getProject(selectedProjectId),
      api.getFiles(selectedProjectId),
      api.getMessages(selectedProjectId),
      api.getRuns(selectedProjectId),
    ]).then(([p, f, m, r]) => {
      setSelectedProject(p);
      setFiles(f);
      setMessages(m);
      setRuns(r);
    });
  }, [selectedProjectId]);

  const refreshAll = () => {
    if (!selectedProjectId) return;
    Promise.all([
      api.getFiles(selectedProjectId),
      api.getMessages(selectedProjectId),
      api.getRuns(selectedProjectId),
      api.getProject(selectedProjectId),
    ]).then(([f, m, r, p]) => {
      setFiles(f);
      setMessages(m);
      setRuns(r);
      setSelectedProject(p);
    });
  };

  const handleCreateProject = async (prompt: string, rtos: "freertos" | "zephyr") => {
    setIsBootstrapping(true);
    try {
      const result = await api.bootstrapProject(prompt, rtos);
      setSelectedProjectId(result.projectId);
      setDialogOpen(false);
      api.getProjects().then(setProjects);
      refreshAll();
      alert(
        "Skeleton created — NOT built yet (unverified): no compiler was invoked.\n\nAsk the agent for the first iteration to get a real build result."
      );
    } catch (err) {
      alert(`Bootstrap failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setIsBootstrapping(false);
    }
  };

  const handleSendMessage = async (content: string) => {
    if (!selectedProjectId) return;
    setIsSending(true);
    try {
      setMessages((prev) => [
        ...prev,
        {
          id: `local-${Date.now()}`,
          project_id: selectedProjectId,
          role: "user" as const,
          content,
        },
      ]);

      // The entire turn runs server-side: LLM call, patch validation, real build
      // and the bounded repair loop. The browser never talks to a provider and
      // never invents a build result.
      const result = await api.runAgent(selectedProjectId, content);

      if (!result.ok) {
        alert(
          result.code === "REPAIR_LIMIT_REACHED"
            ? "BUILD FAILED — REPAIR LIMIT REACHED. Nothing else will be attempted automatically."
            : `${result.code ?? "Agent error"}: ${
                result.message ?? "no files were created or modified"
              }`
        );
      }

      refreshAll();
    } catch (err) {
      alert(`Agent failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setIsSending(false);
    }
  };

  const handleRebuild = async () => {
    if (!selectedProjectId) return;
    setIsRebuilding(true);
    try {
      const result = await api.runBuild(selectedProjectId);
      if (!result.ok) {
        alert(
          "Build NOT AVAILABLE — no compiler was invoked.\n\nInstall bun/west (or configure the build command) and try again."
        );
      }
      refreshAll();
    } catch (err) {
      alert(`Rebuild failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setIsRebuilding(false);
    }
  };

  const selectedFile = files.find((f) => f.path === selectedPath);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border/60 px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Cpu className="h-4 w-4" />
          </div>
          <h1 className="text-base font-semibold tracking-tight">EmbedFactory Workspace</h1>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => navigate("/")} variant="ghost" className="rounded-full">
            Home
          </Button>
          <Button size="sm" onClick={() => setDialogOpen(true)} className="gap-1.5 rounded-full">
            <Plus className="h-4 w-4" />
            New project
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar: projects */}
        <aside className="flex w-64 flex-col border-r border-border/60 bg-muted/20">
          <div className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Projects
          </div>
          <div className="flex-1 overflow-auto px-3 pb-3">
            {loading && (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {!loading && projects.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                No projects yet. Create one to start.
              </p>
            )}
            <div className="space-y-1">
              {projects.map((project) => (
                <button
                  key={project.id}
                  onClick={() => { setSelectedProjectId(project.id); setSelectedPath(null); }}
                  className={cn(
                    "w-full rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted",
                    selectedProjectId === project.id
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate">{project.name}</span>
                    <span className="text-[10px] uppercase text-muted-foreground">{project.rtos}</span>
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
              {/* Project header */}
              <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
                <div>
                  <h2 className="text-sm font-semibold">{selectedProject.name}</h2>
                  <p className="text-xs text-muted-foreground">
                    {selectedProject.rtos === "zephyr" ? "Zephyr" : "FreeRTOS"} • {selectedProject.status}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setShowSafety((s) => !s)}
                    className={cn("gap-1.5 rounded-full", showSafety && "bg-muted")}>
                    <ShieldCheck className="h-3.5 w-3.5" /> Safety
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleRebuild} disabled={isRebuilding}
                    className="gap-1.5 rounded-full">
                    {isRebuilding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    Rebuild
                  </Button>
                </div>
              </div>

              {/* Workspace panels */}
              <div className="flex flex-1 overflow-hidden">
                <div className="flex w-64 shrink-0 flex-col border-r border-border/60">
                  <ProjectExplorer files={files} selectedPath={selectedPath} onSelect={setSelectedPath} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex min-h-0 flex-1">
                    <div className="flex-1 overflow-hidden border-r border-border/60">
                      <FileViewer path={selectedPath} content={selectedFile?.content} />
                    </div>
                    <div className="w-[380px] shrink-0">
                      <ChatPanel
                        messages={messages
                          .filter((m) => m.role !== "tool")
                          .map((m) => ({
                            role: m.role as "user" | "assistant" | "system",
                            content: m.content,
                          }))}
                        onSend={handleSendMessage}
                        isLoading={isSending}
                        disabled={isBootstrapping}
                      />
                    </div>
                  </div>
                  <div className="h-64 shrink-0 border-t border-border/60">
                    <BuildConsole
                      runs={runs.map((run) => {
                        const evidence = parseEvidence(run);
                        return {
                          id: run.id,
                          type: run.type,
                          verification: evidence.verification,
                          verdict: evidence.verdict,
                          command: evidence.command,
                          toolchain: evidence.toolchain,
                          exitCode: evidence.exitCode,
                          durationMs: evidence.durationMs,
                          stdout: evidence.stdout,
                          stderr: evidence.stderr,
                          artifacts: evidence.artifacts,
                          reason: evidence.reason,
                          attempt: evidence.attempt,
                          summary: run.summary ?? null,
                          legacy: evidence.legacy,
                        };
                      })}
                    />
                  </div>
                </div>
                {showSafety && (
                  <div className="w-72 shrink-0">
                    <SafetyPanel
                      files={files.map((f) => ({ path: f.path, content: f.content, type: f.type }))}
                      rtos={selectedProject.rtos}
                    />
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              <LayoutDashboard className="mb-4 h-12 w-12 text-muted-foreground/40" />
              <h2 className="text-xl font-semibold tracking-tight">Welcome to EmbedFactory</h2>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                Create a new embedded project to start generating firmware with the AI agent.
              </p>
              <Button onClick={() => setDialogOpen(true)} className="mt-6 rounded-full px-6">
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
