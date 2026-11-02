import { AlertCircle, AlertTriangle, CheckCircle2, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  analyzeProject,
  safetyStatusBadge,
  type SafetyFinding,
  type SafetyStatus,
} from "@/lib/core/safety";

interface SafetyPanelProps {
  files: { path: string; content: string; type?: string }[];
  rtos: string;
}

/**
 * Runs the same analyzer the backend uses (`analyzeProject`) directly on the
 * files the browser already has, so the panel always shows real, line-accurate
 * findings — including which engine produced them and its limitations.
 */
export function SafetyPanel({ files, rtos }: SafetyPanelProps) {
  const report = analyzeProject(
    files.map((file) => ({ path: file.path, content: file.content })),
    rtos,
  );
  const badge = safetyStatusBadge(report);

  return (
    <div className="flex h-full flex-col border-l border-border/60 bg-card/30">
      <div className="border-b border-border/60 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Safety analysis
      </div>
      <div className="space-y-1 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Shield className="h-3.5 w-3.5" />
          <span className={cn("font-semibold", statusColor(badge))}>{badge}</span>
          <span>
            {report.summary.pass} PASS · {report.summary.warning} WARNING · {report.summary.fail} FAIL
          </span>
        </div>
        <p className="text-[10px] leading-relaxed opacity-80">
          engine: {report.engine} — {report.limitations[0]} (not a clang AST)
        </p>
      </div>
      <div className="flex-1 space-y-2 overflow-auto p-4">
        {report.findings.map((finding, index) => (
          <FindingCard key={`${finding.rule}-${index}`} finding={finding} />
        ))}
      </div>
    </div>
  );
}

function statusColor(status: SafetyStatus): string {
  if (status === "FAIL") return "text-red-600";
  if (status === "WARNING") return "text-amber-600";
  return "text-emerald-600";
}

function FindingCard({ finding }: { finding: SafetyFinding }) {
  const tone =
    finding.status === "FAIL"
      ? "border-red-500/20 bg-red-500/5 text-red-700"
      : finding.status === "WARNING"
        ? "border-amber-500/20 bg-amber-500/5 text-amber-700"
        : "border-emerald-500/20 bg-emerald-500/5 text-emerald-700";

  return (
    <div className={cn("rounded-lg border px-3 py-2 text-xs", tone)}>
      <div className="flex items-start gap-2">
        {finding.status === "PASS" ? (
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : finding.status === "WARNING" ? (
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        )}
        <div className="min-w-0">
          <p className="font-medium">
            {finding.status} · {finding.rule}
          </p>
          <p className="mt-0.5 font-mono text-[10px] opacity-80">
            {finding.file}
            {finding.line === null ? "" : `:${finding.line}`} · severity {finding.severity}
          </p>
          <p className="mt-1 opacity-90">{finding.explanation}</p>
          {finding.snippet && (
            <pre className="mt-1 overflow-x-auto rounded bg-background/60 px-2 py-1 font-mono text-[10px]">
              {finding.snippet}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
