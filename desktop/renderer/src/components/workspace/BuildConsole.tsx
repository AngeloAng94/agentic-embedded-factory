import { cn } from "@/lib/utils";
import { Terminal, CheckCircle2, XCircle, AlertTriangle, HelpCircle } from "lucide-react";

export interface BuildRunView {
  id: string;
  type: string;
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
  summary: string | null;
  /** Rows written before the honest verification model: never trusted. */
  legacy: boolean;
}

interface BuildConsoleProps {
  runs: BuildRunView[];
}

/**
 * Build evidence console (desktop). Identical honesty rules to the web app:
 * a green SUCCESS requires verification === REAL and exit code 0.
 */
export function BuildConsole({ runs }: BuildConsoleProps) {
  const latestBuild = runs.find((run) => run.type === "build");

  return (
    <div className="flex h-full flex-col border-t border-border/60 bg-card/30">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Terminal className="h-3.5 w-3.5" />
          Build &amp; verification evidence
        </div>
        {latestBuild && <StatusBadge run={latestBuild} />}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {runs.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            Nothing has been executed yet. No result is claimed until a real process runs.
          </p>
        ) : (
          <div className="space-y-4">
            {runs.map((run) => (
              <div key={run.id} className="rounded-lg border border-border/60 bg-muted/40 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold uppercase text-muted-foreground">
                    {run.type}
                  </span>
                  <StatusBadge run={run} />
                  {run.attempt ? (
                    <span className="text-[10px] uppercase text-muted-foreground">
                      attempt {run.attempt}
                    </span>
                  ) : null}
                  {run.command && (
                    <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {run.command}
                    </code>
                  )}
                  {run.summary && (
                    <span className="text-xs text-muted-foreground">{run.summary}</span>
                  )}
                </div>

                <dl className="mb-2 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
                  <div>
                    <dt className="uppercase">Exit code</dt>
                    <dd className="font-mono text-foreground">
                      {run.exitCode === null ? "n/a — nothing executed" : run.exitCode}
                    </dd>
                  </div>
                  <div>
                    <dt className="uppercase">Duration</dt>
                    <dd className="font-mono text-foreground">
                      {run.durationMs === null ? "n/a" : `${(run.durationMs / 1000).toFixed(2)}s`}
                    </dd>
                  </div>
                  <div>
                    <dt className="uppercase">Toolchain</dt>
                    <dd className="truncate font-mono text-foreground">
                      {run.toolchain ?? "not detected"}
                    </dd>
                  </div>
                </dl>

                {run.reason && (
                  <p className="mb-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-700">
                    {run.reason}
                  </p>
                )}

                <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground">
                  {[run.stdout, run.stderr && `[stderr]\n${run.stderr}`]
                    .filter(Boolean)
                    .join("\n") || "(no output captured)"}
                </pre>

                {run.artifacts.length > 0 && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Artifacts: <span className="font-mono">{run.artifacts.join(", ")}</span>
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ run }: { run: BuildRunView }) {
  const { label, className, icon } = badgeFor(run);
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

function badgeFor(run: BuildRunView): { label: string; className: string; icon: React.ReactNode } {
  if (run.legacy) {
    return {
      label: "LEGACY · UNVERIFIED",
      className: "bg-slate-500/10 text-slate-600",
      icon: <HelpCircle className="h-3 w-3" />,
    };
  }
  if (run.verification === "REAL" && run.verdict === "SUCCESS") {
    return {
      label: "REAL · SUCCESS",
      className: "bg-emerald-500/10 text-emerald-700",
      icon: <CheckCircle2 className="h-3 w-3" />,
    };
  }
  if (run.verification === "REAL" && run.verdict === "FAILURE") {
    return {
      label: "REAL · FAILURE",
      className: "bg-red-500/10 text-red-700",
      icon: <XCircle className="h-3 w-3" />,
    };
  }
  if (run.verification === "SIMULATED") {
    return {
      label: "SIMULATED · no compiler invoked",
      className: "bg-amber-500/10 text-amber-700",
      icon: <AlertTriangle className="h-3 w-3" />,
    };
  }
  if (run.verification === "NOT_AVAILABLE") {
    return {
      label: "NOT AVAILABLE",
      className: "bg-slate-500/10 text-slate-600",
      icon: <AlertTriangle className="h-3 w-3" />,
    };
  }
  return {
    label: `${run.type.toUpperCase()} · RECORDED`,
    className: "bg-slate-500/10 text-slate-600",
    icon: <HelpCircle className="h-3 w-3" />,
  };
}
