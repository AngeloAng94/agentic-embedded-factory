import { Button } from "@/components/ui/button";
import { History, RotateCcw } from "lucide-react";

export interface VersionEntry {
  _id: string;
  path: string;
  version: number;
  author: string;
  reason: string | null;
  patch: string | null;
  createdAt: number;
  buildVerdict: string | null;
  sizeBytes: number;
}

interface VersionsPanelProps {
  versions: VersionEntry[];
  onRollback: (versionId: string) => void;
  isRollingBack?: boolean;
}

const AUTHOR_LABEL: Record<string, string> = {
  bootstrap: "skeleton",
  agent: "agent",
  user: "manual",
  rollback: "rollback",
};

export function VersionsPanel({ versions, onRollback, isRollingBack }: VersionsPanelProps) {
  return (
    <div className="flex h-full flex-col border-l border-border/60 bg-card/30">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <History className="h-3.5 w-3.5" />
        Version history ({versions.length})
      </div>
      <div className="flex-1 space-y-2 overflow-auto p-4">
        {versions.length === 0 && (
          <p className="text-center text-xs text-muted-foreground">No change recorded yet.</p>
        )}
        {versions.map((entry) => (
          <div
            key={entry._id}
            className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[11px] text-foreground">{entry.path}</span>
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                v{entry.version}
              </span>
            </div>
            <p className="mt-1 text-[10px] uppercase text-muted-foreground">
              {AUTHOR_LABEL[entry.author] ?? entry.author} ·{" "}
              {new Date(entry.createdAt).toLocaleString()} · {entry.sizeBytes} B
              {entry.buildVerdict ? ` · build ${entry.buildVerdict}` : ""}
            </p>
            {entry.reason && <p className="mt-1 opacity-80">{entry.reason}</p>}
            {entry.patch && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[10px] text-muted-foreground">patch</summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-background p-2 font-mono text-[10px]">
                  {entry.patch}
                </pre>
              </details>
            )}
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-7 w-full gap-1.5 text-[11px]"
              disabled={isRollingBack}
              onClick={() => onRollback(entry._id)}
            >
              <RotateCcw className="h-3 w-3" />
              Restore v{entry.version}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
