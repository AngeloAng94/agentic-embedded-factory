import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

import { ProjectExplorer } from "@/components/workspace/ProjectExplorer";
import { FileViewer } from "@/components/workspace/FileViewer";
import { ChatPanel } from "@/components/workspace/ChatPanel";
import { BuildConsole, type BuildRunView } from "@/components/workspace/BuildConsole";
import { NewProjectDialog } from "@/components/workspace/NewProjectDialog";
import { SafetyPanel } from "@/components/workspace/SafetyPanel";
import { VersionsPanel, type VersionEntry } from "@/components/workspace/VersionsPanel";
import {
  LayoutDashboard,
  Plus,
  LogOut,
  Cpu,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Download,
  GitBranch,
  History,
  Trash2,
} from "lucide-react";
import { useNavigate } from "react-router";
import { cn } from "@/lib/utils";
import { buildProjectArchive, safeArchiveName } from "@/lib/core/projectExport";
import type { AgentCycleResult, GitInitActionResult } from "@/convex/lib/contracts";

type RightPanel = "none" | "safety" | "history";

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [rightPanel, setRightPanel] = useState<RightPanel>("none");

  const seedKnowledgeBase = useMutation(api.knowledgeBase.seedKnowledgeBase);
  useEffect(() => {
    if (user) {
      seedKnowledgeBase().catch(() => {
        /* seeding is best effort */
      });
    }
  }, [user, seedKnowledgeBase]);

  const projects = useQuery(api.projects.list, user ? {} : "skip");
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
  const versions = useQuery(
    api.versions.list,
    selectedProjectId ? { projectId: selectedProjectId as never } : "skip",
  );

  const bootstrap = useMutation(api.orchestrator.bootstrapProject);
  const runCycle = useAction(api.agent.runCycle);
  const runBuild = useAction(api.agent.runBuild);
  const requestGitInit = useAction(api.agent.requestGitInit);
  const rollback = useMutation(api.versions.rollback);
  const removeProject = useMutation(api.projects.remove);

  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);

  const projectFileList = useMemo(
    () => (files ?? []).map((file) => ({ path: file.path, content: file.content })),
    [files],
  );

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const reportCycleResult = (result: AgentCycleResult) => {
    if (result.ok) {
      switch (result.status) {
        case "SUCCESS":
          toast.success("Build SUCCESS (real toolchain)", {
            description: `${result.build.command ?? "command"} · exit ${result.build.exitCode} · ${(
              (result.build.durationMs ?? 0) / 1000
            ).toFixed(1)}s`,
          });
          break;
        case "BUILD_NOT_AVAILABLE":
          toast.warning("Build NOT AVAILABLE — nothing was verified", {
            description: result.build.reason ?? "no build runner configured",
          });
          break;
        case "CHANGES_APPLIED":
          toast.success("Files changed (unverified)", {
            description: result.applied ?? "no build requested",
          });
          break;
        default:
          toast.info("Agent answered", { description: "No file was changed." });
      }
      return;
    }

    if (result.code === "LLM_UNREACHABLE" || result.code === "LLM_TIMEOUT") {
      toast.error("LLM unavailable — no files were changed", {
        description: result.message,
      });
      return;
    }
    if (result.code === "LLM_NOT_CONFIGURED") {
      toast.error("LLM not configured", { description: result.message });
      return;
    }
    if (result.code === "PATCH_FAILED") {
      toast.error("PATCH_FAILED — nothing was written", {
        description: result.detail[0]?.reason ?? result.message,
      });
      return;
    }
    if (result.code === "REPAIR_LIMIT_REACHED") {
      toast.error("BUILD FAILED — REPAIR LIMIT REACHED", {
        description: `exit code ${result.build?.exitCode ?? "n/a"} after ${result.attempts} attempt(s)`,
      });
      return;
    }
    toast.error("Agent run failed", { description: result.message });
  };

  const handleCreateProject = async (
    prompt: string,
    rtos: "freertos" | "zephyr",
  ) => {
    setIsBootstrapping(true);
    try {
      const created = await bootstrap({ userPrompt: prompt, rtos });
      if ("error" in created) {
        toast.error("Could not create project", { description: created.message });
        return;
      }
      setSelectedProjectId(created.projectId);
      setDialogOpen(false);
      toast.success("Skeleton created (unverified)", {
        description: "No compiler was invoked yet. Asking the agent for the first iteration…",
      });

      const cycle = await runCycle({ projectId: created.projectId, userMessage: prompt });
      reportCycleResult(cycle);
    } catch (error) {
      toast.error("Bootstrap failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsBootstrapping(false);
    }
  };

  const handleSendMessage = async (content: string) => {
    if (!selectedProjectId) return;
    setIsSending(true);
    try {
      const result = await runCycle({
        projectId: selectedProjectId as never,
        userMessage: content,
      });
      reportCycleResult(result);
    } catch (error) {
      toast.error("Agent failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsSending(false);
    }
  };

  const handleRebuild = async () => {
    if (!selectedProjectId) return;
    setIsRebuilding(true);
    try {
      const result = await runBuild({ projectId: selectedProjectId as never });
      if (result.ok) {
        toast.success(
          result.build.verdict === "SUCCESS" ? "Build SUCCESS (REAL)" : "Build finished with errors",
          { description: `${result.build.command ?? ""} · exit ${result.build.exitCode}` },
        );
      } else {
        toast.warning("Build NOT AVAILABLE", { description: result.message });
      }
    } catch (error) {
      toast.error("Rebuild failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsRebuilding(false);
    }
  };

  const handleExport = () => {
    if (!selectedProject) return;
    const { bytes, manifest } = buildProjectArchive(
      {
        name: selectedProject.name,
        rtos: selectedProject.rtos,
        board: selectedProject.board ?? null,
        mcu: selectedProject.mcu ?? null,
        description: selectedProject.description ?? null,
      },
      projectFileList,
      {
        verification: selectedProject.lastVerification
          ? `${selectedProject.lastVerification} · ${selectedProject.lastVerdict ?? "UNKNOWN"}`
          : "NOT_VERIFIED",
        verdict: selectedProject.lastVerdict ?? "UNKNOWN",
        toolchain: selectedProject.toolchain ?? null,
      },
    );

    const blob = new Blob([bytes as unknown as BlobPart], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeArchiveName(selectedProject.name)}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    toast.success("Project exported", {
      description: `${manifest.fileCount} file(s) + manifest + README · ${manifest.boardProfile.verification} · board ${
        manifest.boardProfile.board ?? "unspecified"
      }`,
    });
  };

  const handleGitInit = async () => {
    if (!selectedProjectId) return;
    try {
      const result: GitInitActionResult = await requestGitInit({
        projectId: selectedProjectId as never,
      });
      if (result.ok) {
        toast.success("Repository initialised", {
          description: (result.steps ?? []).map((step) => step.command).join(" → "),
        });
      } else {
        toast.warning("Git not available here", { description: result.message });
      }
    } catch (error) {
      toast.error("Git failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  const handleRollback = async (versionId: string) => {
    if (!selectedProjectId) return;
    setIsRollingBack(true);
    try {
      const result = await rollback({
        projectId: selectedProjectId as never,
        versionId: versionId as never,
      });
      toast.success(`Restored ${result.path}`, {
        description: `new version v${result.version} (from v${result.restoredFrom}); project is unverified again`,
      });
    } catch (error) {
      toast.error("Rollback failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsRollingBack(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedProjectId || !selectedProject) return;
    if (!window.confirm(`Delete "${selectedProject.name}" and all its history?`)) return;
    try {
      await removeProject({ projectId: selectedProjectId as never });
      setSelectedProjectId(null);
      setSelectedPath(null);
      toast.success("Project deleted");
    } catch (error) {
      toast.error("Delete failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  const selectedFile = files?.find((file) => file.path === selectedPath);
  const runViews: BuildRunView[] = (runs ?? []).map((run) => ({
    id: run._id,
    type: run.type,
    verification: run.verification ?? null,
    verdict: run.verdict ?? null,
    command: run.command ?? null,
    toolchain: run.toolchain ?? null,
    exitCode: run.exitCode ?? null,
    durationMs: run.durationMs ?? null,
    stdout: run.stdout ?? run.logs ?? "",
    stderr: run.stderr ?? "",
    artifacts: run.artifacts ?? [],
    reason: run.reason ?? null,
    attempt: run.attempt ?? null,
    summary: run.summary ?? null,
    legacy: run.verification === undefined,
  }));

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border/60 px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Cpu className="h-4 w-4" />
          </div>
          <h1 className="text-base font-semibold tracking-tight">EmbedFactory Workspace</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setDialogOpen(true)} className="gap-1.5 rounded-full">
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
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{project.name}</span>
                    <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                      {project.rtos}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] uppercase text-muted-foreground">
                    {statusLabel(project)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <main className="flex flex-1 flex-col overflow-hidden">
          {selectedProjectId && selectedProject ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
                <div>
                  <h2 className="text-sm font-semibold">{selectedProject.name}</h2>
                  <p className="text-xs text-muted-foreground">
                    {selectedProject.rtos === "zephyr" ? "Zephyr" : "FreeRTOS"} · {selectedProject.status} ·{" "}
                    {selectedProject.board ?? "board unspecified"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleExport}
                    disabled={!files || files.length === 0}
                    className="gap-1.5 rounded-full"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export ZIP
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleGitInit}
                    className="gap-1.5 rounded-full"
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                    Git init
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRightPanel(rightPanel === "safety" ? "none" : "safety")}
                    className={cn("gap-1.5 rounded-full", rightPanel === "safety" && "bg-muted")}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Safety
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRightPanel(rightPanel === "history" ? "none" : "history")}
                    className={cn("gap-1.5 rounded-full", rightPanel === "history" && "bg-muted")}
                  >
                    <History className="h-3.5 w-3.5" />
                    History
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
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleDelete}
                    className="gap-1.5 rounded-full text-red-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div className="flex flex-1 overflow-hidden">
                <div className="flex w-56 shrink-0 flex-col border-r border-border/60">
                  <ProjectExplorer
                    files={files ?? []}
                    selectedPath={selectedPath}
                    onSelect={setSelectedPath}
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex min-h-0 flex-1">
                    <div className="flex-1 overflow-hidden border-r border-border/60">
                      <FileViewer path={selectedPath} content={selectedFile?.content} />
                    </div>
                    <div className="w-[380px] shrink-0">
                      <ChatPanel
                        messages={
                          messages?.map((message) => ({
                            role: message.role as "user" | "assistant" | "system",
                            content: message.content,
                          })) ?? []
                        }
                        onSend={handleSendMessage}
                        isLoading={isSending}
                        disabled={isBootstrapping}
                      />
                    </div>
                  </div>
                  <div className="h-72 shrink-0 border-t border-border/60">
                    <BuildConsole runs={runViews} />
                  </div>
                </div>
                {rightPanel === "safety" && (
                  <div className="w-80 shrink-0">
                    <SafetyPanel files={projectFileList} rtos={selectedProject.rtos} />
                  </div>
                )}
                {rightPanel === "history" && (
                  <div className="w-80 shrink-0">
                    <VersionsPanel
                      versions={(versions ?? []) as VersionEntry[]}
                      onRollback={handleRollback}
                      isRollingBack={isRollingBack}
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
                Create a project, describe the firmware behaviour and let the agent produce
                validated patches. Builds are only reported as successful when a real toolchain
                exits 0.
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

function statusLabel(project: {
  status: string;
  lastVerification?: string | null;
  lastVerdict?: string | null;
}): string {
  if (project.lastVerification === "REAL" && project.lastVerdict === "SUCCESS") {
    return "verified (REAL build)";
  }
  if (project.lastVerification === "REAL" && project.lastVerdict === "FAILURE") {
    return "build failed (REAL)";
  }
  if (project.status === "verified") return "verified";
  if (project.status === "failed") return "build failed";
  return "unverified";
}
