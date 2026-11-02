import { cn } from "@/lib/utils";
import type { StatusTone } from "@/lib/core/environmentStatus";

/**
 * Control-plane status primitives.
 *
 * The tone is always computed in the core (`connectionTone`, `runnerTone`,
 * `capabilityTone`) — these components only map a tone to classes. No component
 * decides on its own that something is ready.
 */

const DOT: Record<StatusTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-red-500",
  idle: "bg-muted-foreground/40",
};

const TEXT: Record<StatusTone, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-red-600 dark:text-red-400",
  idle: "text-muted-foreground",
};

export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT[tone], className)}
    />
  );
}

export function StatusBadge({
  tone,
  label,
  className,
}: {
  tone: StatusTone;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase",
        TEXT[tone],
        className,
      )}
    >
      <StatusDot tone={tone} />
      {label}
    </span>
  );
}

/** Shared card shell so every control-plane section looks identical. */
export function StatusCard({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-border/60 bg-card/40", className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
        <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          {title}
        </h2>
        {action}
      </header>
      <div className="space-y-3 px-4 py-4">{children}</div>
    </section>
  );
}

/** One `label / value` line inside a card. */
export function StatusValue({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm", className)}>
      <span className="w-40 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}
