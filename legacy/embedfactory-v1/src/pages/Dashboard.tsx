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
import { ControlPlaneHeader } from "@/components/app/ControlPlaneHeader";
import { StatusBadge } from "@/components/app/StatusIndicator";
import { formatCheckedAt } from "@/components/app/statusFormat";
import {
  ArrowRight,
  FolderOpen,
  Plus,
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
import {
  capabilityLabel,
  capabilityTone,
  connectionLabel,
  connectionTone,
  onboardingSteps,
  runnerLabel,
  runnerTone,
  type EnvironmentStatus,
  type ProjectEnvironmentStatus,
  type StatusTone,
} from "@/lib/core/environmentStatus";
import type { AgentCycleResult, GitInitActionResult } from "@/convex/lib/contracts";

type RightPanel = "none" | "safety" | "history";

export default function Dashboard() {
  const { user } = useAuth();
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
  // Real environment status: server configuration + last real probe.
  const environment = useQuery(api.environment.status, user ? {} : "skip");
  const projectEnvironment = useQuery(
    api.environment.projectEnvironment,
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

  const handleCreateProject = async (config: {
    name: string;
    rtos: "freertos" | "zephyr";
    board: string | null;
    requirements: string;
  }) => {
    setIsBootstrapping(true);
    try {
      const created = await bootstrap({
        userPrompt: config.requirements,
        projectName: config.name,
        rtos: config.rtos,
        board: config.board ?? undefined,
      });
      if ("error" in created) {
        toast.error("Could not create project", { description: created.message });
        return;
      }
      setSelectedProjectId(created.projectId);
      setDialogOpen(false);
      toast.success("Skeleton created (unverified)", {
        description: `No compiler was invoked yet${
          config.board ? ` · board ${config.board} stays UNKNOWN / NOT VERIFIED until diagnostics list it` : ""
        }. Asking the agent for the first iteration…`,
      });

      const cycle = await runCycle({
        projectId: created.projectId,
        userMessage: config.requirements,
      });
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
      <ControlPlaneHeader title="EmbedFactory Workspace">
        <Button size="sm" onClick={() => setDialogOpen(true)} className="gap-1.5 rounded-full">
          <Plus className="h-4 w-4" />
          New firmware
        </Button>
      </ControlPlaneHeader>

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
              <div className="border-b border-border/60">
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
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
                <ProjectEnvironmentStrip status={projectEnvironment} />
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
            <ControlCenter
              environment={environment}
              onCreate={() => setDialogOpen(true)}
              onOpenEnvironment={() => navigate("/environment")}
              onOpenSettings={() => navigate("/settings")}
            />
          )}
        </main>
      </div>

      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreateProject}
        isLoading={isBootstrapping}
        environment={environment}
      />
    </div>
  );
}

/**
 * The control center: what this deployment can really do right now, with the
 * first-run checklist. Nothing is blocked — a missing capability is reported
 * with its reason and a link to the page that fixes it.
 */
function ControlCenter({
  environment,
  onCreate,
  onOpenEnvironment,
  onOpenSettings,
}: {
  environment: EnvironmentStatus | undefined;
  onCreate: () => void;
  onOpenEnvironment: () => void;
  onOpenSettings: () => void;
}) {
  if (!environment) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const rows: { label: string; tone: StatusTone; value: string; detail: string }[] = [
    {
      label: "AI",
      tone: connectionTone(environment.llm.state),
      value: connectionLabel(environment.llm.state),
      detail: environment.llm.explicit
        ? `${environment.llm.provider} · ${environment.llm.model ?? "model not set"}`
        : `no LLM_* variable is set — built-in default ${environment.llm.provider} at ${
            environment.llm.baseUrl ?? "?"
          }`,
    },
    {
      label: "Build runner",
      tone: runnerTone(environment.runner.state),
      value: runnerLabel(environment.runner.state),
      detail: environment.runner.url ?? "BUILD_RUNNER_URL is not set",
    },
    {
      label: "Zephyr",
      tone: capabilityTone(environment.zephyr.state),
      value: capabilityLabel(environment.zephyr.state),
      detail:
        environment.zephyr.toolchain ??
        environment.zephyr.message ??
        "run diagnostics to probe the toolchain",
    },
    {
      label: "FreeRTOS",
      tone: capabilityTone(environment.freertos.state),
      value: capabilityLabel(environment.freertos.state),
      detail: environment.freertos.message ?? "no FreeRTOS doctor exists yet",
    },
    {
      label: "Toolchain",
      tone: capabilityTone(environment.toolchain),
      value: capabilityLabel(environment.toolchain),
      detail: `last diagnostics: ${formatCheckedAt(environment.checkedAt)}`,
    },
  ];

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-3xl space-y-9 px-6 py-10">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Welcome to EmbedFactory</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Build, verify and repair embedded firmware with AI.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onCreate} className="rounded-full px-6">
            <Plus className="mr-2 h-4 w-4" />
            New Firmware
          </Button>
          <Button variant="outline" disabled className="cursor-not-allowed rounded-full px-6">
            <FolderOpen className="mr-2 h-4 w-4" />
            Existing Firmware
            <span className="ml-2 rounded-full border px-2 py-0.5 text-[10px] tracking-wide uppercase">
              Coming soon
            </span>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Existing Firmware will let you analyze and work on an existing embedded codebase. Import is
          not implemented yet, so the entry point stays disabled instead of opening a screen that
          does nothing.
        </p>

        <section>
          <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            System status
          </h3>
          <div className="mt-3 divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
            {rows.map((row) => (
              <button
                key={row.label}
                type="button"
                onClick={onOpenEnvironment}
                className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/40"
              >
                <span className="min-w-0">
                  <span className="block text-xs font-medium tracking-widest uppercase">
                    {row.label}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {row.detail}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <StatusBadge tone={row.tone} label={row.value} />
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                </span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            First run
          </h3>
          <ol className="mt-3 space-y-2">
            {onboardingSteps(environment).map((step, index) => (
              <li key={step.id} className="rounded-xl border border-border/60 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] text-muted-foreground">
                      {index + 1}
                    </span>
                    <span className="text-sm font-medium">{step.title}</span>
                  </span>
                  <StatusBadge tone={capabilityTone(step.state)} label={capabilityLabel(step.state)} />
                </div>
                <p className="mt-1.5 pl-9 text-xs break-words text-muted-foreground">{step.detail}</p>
              </li>
            ))}
          </ol>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={onCreate} className="rounded-full px-6">
              <Plus className="mr-2 h-4 w-4" />
              Create first project
            </Button>
            <Button variant="outline" onClick={onOpenSettings} className="rounded-full">
              Configure AI
            </Button>
            <span className="text-xs text-muted-foreground">
              Nothing here blocks you: a project can be created before the environment is complete —
              it simply stays unverified.
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}

/** The AI / BUILD / RTOS / BOARD strip inside a project. */
function ProjectEnvironmentStrip({ status }: { status: ProjectEnvironmentStatus | undefined }) {
  if (!status) return null;

  const items = [
    { label: "AI", tone: connectionTone(status.ai.state), value: connectionLabel(status.ai.state) },
    {
      label: "Build",
      tone: capabilityTone(status.build.state),
      value: capabilityLabel(status.build.state),
    },
    {
      label: "RTOS",
      tone: capabilityTone(status.rtos.state),
      value: status.rtos.rtos === "zephyr" ? "Zephyr" : "FreeRTOS",
    },
    {
      label: "Board",
      tone: capabilityTone(status.board.state),
      value: status.board.board ?? "not set",
    },
  ];

  const reasons = [
    status.ai.state === "CONNECTED" ? null : `AI — ${status.ai.message ?? "not tested"}`,
    status.build.state === "READY" ? null : `BUILD — ${status.build.message ?? "not ready"}`,
    status.rtos.state === "READY" ? null : `RTOS — ${status.rtos.message ?? "not verified"}`,
    status.board.state === "READY" ? null : `BOARD — ${status.board.message ?? "not verified"}`,
  ].filter((item): item is string => item !== null);

  return (
    <div className="space-y-1.5 border-t border-border/60 px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5">
        {items.map((item) => (
          <span key={item.label} className="inline-flex items-center gap-2">
            <span className="text-[10px] tracking-widest text-muted-foreground uppercase">
              {item.label}
            </span>
            <StatusBadge tone={item.tone} label={item.value} />
          </span>
        ))}
        {status.build.lastBuild ? (
          <span className="text-[10px] text-muted-foreground">
            last build {status.build.lastBuild.verification} · {status.build.lastBuild.verdict}
            {status.build.lastBuild.exitCode === null
              ? ""
              : ` · exit ${status.build.lastBuild.exitCode}`}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">no build run yet</span>
        )}
      </div>
      {reasons.length > 0 ? (
        <ul className="space-y-0.5">
          {reasons.map((reason) => (
            <li key={reason} className="font-mono text-[10px] leading-4 text-muted-foreground">
              Reason: {reason}
            </li>
          ))}
        </ul>
      ) : null}
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
