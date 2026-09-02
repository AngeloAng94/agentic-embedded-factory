import { cn } from "@/lib/utils";
import { Terminal, CheckCircle2, XCircle, Clock } from "lucide-react";

export interface BuildRun {
  type: "build" | "test" | "lint";
  status: "pending" | "running" | "success" | "failed";
  logs: string;
  summary?: string;
}

interface BuildConsoleProps {
  runs: BuildRun[];
}

export function BuildConsole({ runs }: BuildConsoleProps) {
  const latest = runs[0];

  return (
    <div className="flex h-full flex-col border-t border-border/60 bg-card/30">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Terminal className="h-3.5 w-3.5" />
          Build & Test
        </div>
        {latest && <StatusBadge status={latest.status} />}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {runs.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            No builds or tests run yet.
          </p>
        ) : (
          <div className="space-y-4">
            {runs.map((run, index) => (
              <div
                key={index}
                className="rounded-lg border border-border/60 bg-muted/40 p-3"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase text-muted-foreground">
                    {run.type}
                  </span>
                  <StatusBadge status={run.status} />
                  {run.summary && (
                    <span className="text-xs text-muted-foreground">
                      {run.summary}
                    </span>
                  )}
                </div>
                <pre className="whitespace-pre-wrap rounded-md bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground">
                  {run.logs}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: BuildRun["status"] }) {
  const config = {
    pending: {
      icon: <Clock className="h-3 w-3" />,
      className: "bg-yellow-500/10 text-yellow-700",
      label: "Pending",
    },
    running: {
      icon: <Clock className="h-3 w-3 animate-spin" />,
      className: "bg-blue-500/10 text-blue-700",
      label: "Running",
    },
    success: {
      icon: <CheckCircle2 className="h-3 w-3" />,
      className: "bg-emerald-500/10 text-emerald-700",
      label: "Success",
    },
    failed: {
      icon: <XCircle className="h-3 w-3" />,
      className: "bg-red-500/10 text-red-700",
      label: "Failed",
    },
  };
  const { icon, className, label } = config[status];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase",
        className,
      )}
    >
      {icon}
      {label}
    </span>
  );
}
