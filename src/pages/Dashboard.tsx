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
import { toast } from "sonner";
import {
  LayoutDashboard,
  Plus,
  LogOut,
  Cpu,
  Loader2,
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

  const seedKnowledgeBase = useMutation(api.knowledgeBase.seedKnowledgeBase);

  useEffect(() => {
    if (user) {
      seedKnowledgeBase().catch(() => {
        // ignore seed errors
      });
    }
  }, [user, seedKnowledgeBase]);

  const projects = useQuery(api.projects.list, {
    userId: user?._id ?? ("" as never),
  });
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

  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isSending, setIsSending] = useState(false);

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
    if (!selectedProjectId) return;
    setIsSending(true);
    try {
      await sendMessage({
        projectId: selectedProjectId as never,
        content,
      });
    } catch (err) {
      toast.error("Message failed", {
        description:
          err instanceof Error ? err.message : "Unknown error. Try again.",
      });
    } finally {
      setIsSending(false);
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
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{files?.length ?? 0} files</span>
                  <span>•</span>
                  <span>{runs?.length ?? 0} runs</span>
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
