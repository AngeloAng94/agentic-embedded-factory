import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { toast } from "sonner";
import { Loader2, PlayCircle, PlugZap } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { ControlPlaneHeader } from "@/components/app/ControlPlaneHeader";
import { StatusBadge, StatusCard, StatusValue } from "@/components/app/StatusIndicator";
import { formatCheckedAt } from "@/components/app/statusFormat";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ENVIRONMENT_HONESTY_NOTE,
  capabilityLabel,
  capabilityTone,
  connectionLabel,
  connectionTone,
  runnerLabel,
  runnerTone,
} from "@/lib/core/environmentStatus";
import { cn } from "@/lib/utils";

/**
 * Environment — what actually works on this deployment right now.
 *
 * Every value on this page comes from `api.environment.status`, which is built
 * from the real server environment plus the last *real* probe. The only button
 * that changes anything is "Run diagnostics", and it really calls the build
 * runner's `GET /doctor`.
 */
export default function Environment() {
  const status = useQuery(api.environment.status);
  const runDiagnostics = useAction(api.environmentActions.runDiagnostics);
  const testLlm = useAction(api.environmentActions.testLlm);
  const [isDiagnosing, setIsDiagnosing] = useState(false);
  const [isTestingAi, setIsTestingAi] = useState(false);

  const handleDiagnostics = async () => {
    setIsDiagnosing(true);
    try {
      const result = await runDiagnostics({});
      if (result.zephyr.state === "READY") {
        toast.success("Diagnostics finished — Zephyr is READY", {
          description: result.zephyr.toolchain ?? "the doctor reported a complete toolchain",
        });
      } else {
        toast.warning("Diagnostics finished — no verified Zephyr toolchain", {
          description:
            result.zephyr.message ??
            `runner ${runnerLabel(result.runner.state)} · Zephyr ${capabilityLabel(result.zephyr.state)}`,
        });
      }
    } catch (error) {
      toast.error("Diagnostics failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsDiagnosing(false);
    }
  };

  const handleTestAi = async () => {
    setIsTestingAi(true);
    try {
      const result = await testLlm({});
      if (result.state === "CONNECTED") {
        toast.success("AI CONNECTED", {
          description: result.message,
        });
      } else {
        toast.error(`AI ${connectionLabel(result.state)}`, { description: result.message });
      }
    } catch (error) {
      toast.error("Test connection failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsTestingAi(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <ControlPlaneHeader title="Environment">
        <Button
          size="sm"
          onClick={handleDiagnostics}
          disabled={isDiagnosing}
          className="gap-1.5 rounded-full"
        >
          {isDiagnosing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <PlayCircle className="h-4 w-4" />
          )}
          Run diagnostics
        </Button>
      </ControlPlaneHeader>

      <main className="mx-auto w-full max-w-5xl flex-1 space-y-5 px-6 py-6">
        <Alert>
          <AlertTitle className="text-xs tracking-widest uppercase">Honesty rule</AlertTitle>
          <AlertDescription className="text-xs">{ENVIRONMENT_HONESTY_NOTE}</AlertDescription>
        </Alert>

        {!status ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            {/* ------------------------------------------------------- AI --- */}
            <StatusCard
              title="AI"
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleTestAi}
                  disabled={isTestingAi}
                  className="h-7 gap-1.5 rounded-full text-xs"
                >
                  {isTestingAi ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <PlugZap className="h-3.5 w-3.5" />
                  )}
                  Test connection
                </Button>
              }
            >
              <StatusValue label="Connection">
                <StatusBadge
                  tone={connectionTone(status.llm.state)}
                  label={connectionLabel(status.llm.state)}
                />
              </StatusValue>
              <StatusValue label="Provider">
                <span className="font-mono text-xs">
                  {status.llm.provider}
                  {status.llm.explicit ? "" : " (built-in default)"}
                </span>
              </StatusValue>
              <StatusValue label="Model">
                <span className="font-mono text-xs">{status.llm.model ?? "not set"}</span>
              </StatusValue>
              <StatusValue label="Endpoint">
                <span className="font-mono text-xs break-all">
                  {status.llm.baseUrl ?? "not set"}
                </span>
              </StatusValue>
              <StatusValue label="API key">
                <span className="text-xs">{status.llm.apiKeyConfigured ? "Configured" : "Not configured"}</span>
              </StatusValue>
              <StatusValue label="Last check">
                <span className="text-xs text-muted-foreground">
                  {formatCheckedAt(status.llm.checkedAt)}
                </span>
              </StatusValue>
              {status.llm.message ? (
                <p className="border-t border-border/60 pt-3 font-mono text-[11px] leading-5 text-muted-foreground">
                  {status.llm.message}
                </p>
              ) : null}
            </StatusCard>

            {/* ---------------------------------------------- BUILD RUNNER --- */}
            <StatusCard title="Build runner">
              <StatusValue label="Status">
                <StatusBadge
                  tone={runnerTone(status.runner.state)}
                  label={runnerLabel(status.runner.state)}
                />
              </StatusValue>
              <StatusValue label="URL">
                <span className="font-mono text-xs break-all">
                  {status.runner.url ?? "BUILD_RUNNER_URL is not set"}
                </span>
              </StatusValue>
              <StatusValue label="Token">
                <span className="text-xs">
                  {status.runner.tokenConfigured ? "Configured" : "Not configured"}
                </span>
              </StatusValue>
              <StatusValue label="Latency">
                <span className="text-xs text-muted-foreground">
                  {status.runner.latencyMs === null ? "—" : `${status.runner.latencyMs} ms`}
                </span>
              </StatusValue>
              <StatusValue label="Last check">
                <span className="text-xs text-muted-foreground">
                  {formatCheckedAt(status.runner.checkedAt)}
                </span>
              </StatusValue>
              {status.runner.tools ? (
                <div className="flex flex-wrap gap-1.5 border-t border-border/60 pt-3">
                  {Object.entries(status.runner.tools).map(([tool, present]) => (
                    <span
                      key={tool}
                      className={cn(
                        "rounded border px-1.5 py-0.5 font-mono text-[10px]",
                        present
                          ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                          : "border-border/60 text-muted-foreground",
                      )}
                    >
                      {tool} {present ? "PASS" : "MISSING"}
                    </span>
                  ))}
                </div>
              ) : null}
              {status.runner.message ? (
                <p className="border-t border-border/60 pt-3 font-mono text-[11px] leading-5 text-muted-foreground">
                  {status.runner.message}
                </p>
              ) : null}
            </StatusCard>

            {/* --------------------------------------------------- ZEPHYR --- */}
            <StatusCard
              title="Zephyr"
              action={
                <StatusBadge
                  tone={capabilityTone(status.zephyr.state)}
                  label={capabilityLabel(status.zephyr.state)}
                />
              }
            >
              {status.zephyr.checks.length > 0 ? (
                <div className="grid grid-cols-[minmax(0,8rem)_4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-border/60 pt-3 font-mono text-[11px]">
                  {status.zephyr.checks.map((check) => (
                    <div key={check.id} className="col-span-3 grid grid-cols-subgrid">
                      <span className="truncate text-foreground" title={check.label}>
                        {check.label}
                      </span>
                      <span
                        className={
                          check.status === "PASS"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        }
                      >
                        {check.status}
                      </span>
                      <span className="break-words text-muted-foreground">{check.detail}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
                  {status.zephyr.message ??
                    "No doctor report yet — Run diagnostics to probe the build machine."}
                </p>
              )}

              <div className="border-t border-border/60 pt-3">
                <StatusValue label="Board detection">
                  <span className="font-mono text-xs">{status.zephyr.board ?? "not probed"}</span>
                </StatusValue>
                <StatusValue label="Boards listed by west">
                  <span className="text-xs">
                    {status.zephyr.boardsSupported
                      ? `${status.zephyr.boardsSupported.length} boards verified`
                      : "not read (west/ZEPHYR_BASE unavailable)"}
                  </span>
                </StatusValue>
                <StatusValue label="Toolchain">
                  <span className="font-mono text-xs">
                    {status.zephyr.toolchain ?? "not verified"}
                  </span>
                </StatusValue>
                <StatusValue label="Build capability">
                  <span className="text-xs">{status.zephyr.buildCapability}</span>
                </StatusValue>
                <StatusValue label="Last check">
                  <span className="text-xs text-muted-foreground">
                    {formatCheckedAt(status.zephyr.checkedAt)}
                  </span>
                </StatusValue>
              </div>

              {status.zephyr.diagnostics.length > 0 ? (
                <ul className="space-y-1 border-t border-border/60 pt-3 text-xs text-red-600 dark:text-red-400">
                  {status.zephyr.diagnostics.map((item) => (
                    <li key={item} className="font-mono">
                      {item}
                    </li>
                  ))}
                </ul>
              ) : null}

              {status.zephyr.doctorReport ? (
                <details className="border-t border-border/60 pt-3">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Raw doctor output
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 text-[11px] leading-5">
                    {status.zephyr.doctorReport}
                  </pre>
                </details>
              ) : null}
            </StatusCard>

            {/* ------------------------------------------------- FREERTOS --- */}
            <StatusCard
              title="FreeRTOS"
              action={
                <StatusBadge
                  tone={capabilityTone(status.freertos.state)}
                  label={capabilityLabel(status.freertos.state)}
                />
              }
            >
              <StatusValue label="Diagnostics">
                <span className="text-xs text-muted-foreground">
                  No FreeRTOS doctor is implemented yet. The toolchain cannot be verified, so
                  FreeRTOS is never reported as ready.
                </span>
              </StatusValue>
              <StatusValue label="Version">
                <span className="text-xs">{status.freertos.version ?? "unknown"}</span>
              </StatusValue>
              <StatusValue label="Build capability">
                <span className="text-xs">{status.freertos.buildCapability}</span>
              </StatusValue>
              {status.freertos.diagnostics.map((item) => (
                <p key={item} className="font-mono text-[11px] leading-5 text-muted-foreground">
                  {item}
                </p>
              ))}
            </StatusCard>

            {/* ------------------------------------------------ AGGREGATE --- */}
            <StatusCard title="Toolchain">
              <StatusValue label="Aggregate">
                <StatusBadge
                  tone={capabilityTone(status.toolchain)}
                  label={capabilityLabel(status.toolchain)}
                />
              </StatusValue>
              <StatusValue label="Last diagnostics">
                <span className="text-xs text-muted-foreground">
                  {formatCheckedAt(status.checkedAt)}
                </span>
              </StatusValue>
              <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
                The toolchain is only READY when the doctor on the build machine reported every
                required check as PASS. This deployment cannot inspect a toolchain by itself: it
                has no build runner, so nothing native can be executed from here.
              </p>
            </StatusCard>
          </>
        )}
      </main>
    </div>
  );
}

