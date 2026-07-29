import { AlertCircle, CheckCircle2, Shield } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ProjectFile {
  path: string;
  content: string;
  type: string;
}

interface SafetyPanelProps {
  files: ProjectFile[];
  rtos: "freertos" | "zephyr" | string;
}

export function SafetyPanel({ files, rtos }: SafetyPanelProps) {
  const checks = runChecks(files, rtos);
  const passed = checks.filter((c) => c.ok).length;

  return (
    <div className="flex h-full flex-col border-l border-border/60 bg-card/30">
      <div className="border-b border-border/60 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Safety Gate
      </div>
      <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
        <Shield className="h-3.5 w-3.5" />
        <span>
          {passed}/{checks.length} checks passed
        </span>
      </div>
      <div className="flex-1 space-y-2 overflow-auto p-4">
        {checks.map((check) => (
          <div
            key={check.id}
            className={cn(
              "rounded-lg border px-3 py-2 text-xs",
              check.ok
                ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-700"
                : "border-red-500/20 bg-red-500/5 text-red-700",
            )}
          >
            <div className="flex items-start gap-2">
              {check.ok ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : (
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              <div>
                <p className="font-medium">{check.label}</p>
                <p className="mt-0.5 opacity-80">{check.hint}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function runChecks(files: ProjectFile[], rtos: string) {
  const checks: { id: string; label: string; hint: string; ok: boolean }[] = [];

  const content = files.map((f) => f.content).join("\n");
  const lower = content.toLowerCase();

  checks.push({
    id: "entrypoint",
    label: "Entrypoint present",
    hint: "src/main.c should contain the main entrypoint.",
    ok: files.some((f) => f.path === "src/main.c"),
  });

  checks.push({
    id: "heap",
    label: "Dynamic allocation minimised",
    hint: "Avoid malloc/free in deterministic real-time paths.",
    ok: !lower.includes("malloc(") && !lower.includes("free(") && !lower.includes("calloc(") && !lower.includes("realloc(") ,
  });

  if (rtos === "freertos") {
    checks.push({
      id: "static_alloc",
      label: "Static allocation preferred",
      hint: "Use xTaskCreateStatic and configSUPPORT_STATIC_ALLOCATION.",
      ok: lower.includes("static allocation") || lower.includes("xtaskcreatestatic") || lower.includes("configsupport_static_allocation"),
    });

    checks.push({
      id: "stack_overflow",
      label: "Stack overflow guard",
      hint: "Enable configCHECK_FOR_STACK_OVERFLOW in FreeRTOSConfig.h.",
      ok: lower.includes("configcheck_for_stack_overflow"),
    });

    checks.push({
      id: "isr_safe",
      label: "ISR-safe API usage",
      hint: "Use FromISR API variants inside interrupt handlers.",
      ok: !lower.includes("printf(") || lower.includes("fromisr"),
    });
  }

  if (rtos === "zephyr") {
    checks.push({
      id: "main_stack",
      label: "Main stack configured",
      hint: "CONFIG_MAIN_STACK_SIZE should be defined in prj.conf.",
      ok: lower.includes("config_main_stack_size"),
    });

    checks.push({
      id: "printk_safe",
      label: "Logging via printk safe",
      hint: "Use printk/LOG APIs, avoid printf in ISR context.",
      ok: !lower.includes("printf(") || lower.includes("printk("),
    });
  }

  return checks;
}
