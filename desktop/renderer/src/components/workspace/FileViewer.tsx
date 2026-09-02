import { cn } from "@/lib/utils";
import { FileText } from "lucide-react";

interface FileViewerProps {
  path: string | null;
  content: string | undefined;
}

export function FileViewer({ path, content }: FileViewerProps) {
  if (!path) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center text-muted-foreground">
        <FileText className="mb-3 h-10 w-10 text-muted-foreground/40" />
        <p className="text-sm">Select a file to view its contents.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-xs font-medium text-muted-foreground">
        <FileText className="h-3.5 w-3.5" />
        <span className="font-mono">{path}</span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <pre
          className={cn(
            "whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground",
          )}
        >
          {content}
        </pre>
      </div>
    </div>
  );
}
