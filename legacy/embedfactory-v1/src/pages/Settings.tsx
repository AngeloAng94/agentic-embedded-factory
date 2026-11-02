import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { toast } from "sonner";
import { Loader2, PlugZap, ServerCog } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { LlmTestResult, RunnerTestResult } from "@/convex/environmentActions";
import { ControlPlaneHeader } from "@/components/app/ControlPlaneHeader";
import { StatusBadge, StatusCard } from "@/components/app/StatusIndicator";
import { formatCheckedAt } from "@/components/app/statusFormat";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { MAX_REPAIR_ATTEMPTS } from "@/lib/core/buildStatus";
import { resolveRunnerConfig } from "@/lib/core/buildDispatch";
import {
  ENV_VAR_DOCS,
  connectionLabel,
  connectionTone,
  envVarsFor,
  runnerLabel,
  runnerTone,
  secretLabel,
  type EnvVarDoc,
  type LlmStatus,
  type RunnerStatus,
} from "@/lib/core/environmentStatus";
import { cn } from "@/lib/utils";

/**
 * Settings — the server-side configuration this deployment really reads.
 *
 * There is no secret storage in the browser and no "keys" write API: the values
 * live in the deployment environment and are read with `process.env` inside
 * Convex node actions and the runner. This page therefore *describes* the
 * resolved configuration (never a credential) and offers real tests:
 *
 *   Test connection → one real generation request with the configured provider
 *   Test runner     → one real `GET /health` on the build runner
 */

function aiValue(name: string, llm: LlmStatus): string {
  switch (name) {
    case "LLM_PROVIDER":
      return llm.provider;
    case "LLM_BASE_URL":
      return llm.baseUrl ?? "not set";
    case "LLM_API_KEY":
      return secretLabel(llm.apiKeyConfigured);
    case "LLM_MODEL":
      return llm.model ?? "not set";
    case "LLM_TIMEOUT_MS":
      return llm.timeoutMs === null ? "not set" : `${llm.timeoutMs} ms`;
    case "LLM_MAX_RETRIES":
      return llm.maxRetries === null ? "not set" : String(llm.maxRetries);
    case "LLM_TEMPERATURE":
      return llm.temperature === null ? "not set" : String(llm.temperature);
    default:
      return "not set";
  }
}

function runnerValue(name: string, runner: RunnerStatus): string {
  if (name === "BUILD_RUNNER_URL") return runner.url ?? "not set";
  if (name === "BUILD_RUNNER_TOKEN") return secretLabel(runner.tokenConfigured);
  return "not set";
}

export default function Settings() {
  const status = useQuery(api.environment.status);
  const testLlm = useAction(api.environmentActions.testLlm);
  const testRunner = useAction(api.environmentActions.testRunner);
  const [isTestingAi, setIsTestingAi] = useState(false);
  const [isTestingRunner, setIsTestingRunner] = useState(false);
  const [llmResult, setLlmResult] = useState<LlmTestResult | null>(null);
  const [runnerResult, setRunnerResult] = useState<RunnerTestResult | null>(null);

  // The runner timeout is a real, non-duplicated setting read from the core.
  const runnerTimeoutMs = resolveRunnerConfig({}).timeoutMs;

  const handleTestAi = async () => {
    setIsTestingAi(true);
    setLlmResult(null);
    try {
      const result = await testLlm({});
      setLlmResult(result);
      if (result.state === "CONNECTED") {
        toast.success("AI CONNECTED", { description: result.message });
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

  const handleTestRunner = async () => {
    setIsTestingRunner(true);
    setRunnerResult(null);
    try {
      const result = await testRunner({});
      setRunnerResult(result);
      if (result.state === "CONNECTED") {
        toast.success("Build runner CONNECTED", {
          description: `${result.latencyMs ?? "?"} ms · ${result.zephyrBase ?? "ZEPHYR_BASE not set"}`,
        });
      } else {
        toast.error(`Build runner ${runnerLabel(result.state)}`, {
          description: result.message ?? "no answer from the runner",
        });
      }
    } catch (error) {
      toast.error("Test runner failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsTestingRunner(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <ControlPlaneHeader title="Settings" />

      <main className="mx-auto w-full max-w-4xl flex-1 space-y-5 px-6 py-6">
        <Alert>
          <ServerCog className="h-4 w-4" />
          <AlertTitle className="text-xs tracking-widest uppercase">
            Configuration is server-side
          </AlertTitle>
          <AlertDescription className="text-xs">
            These variables live in the deployment environment and are read with{" "}
            <code className="font-mono">process.env</code> inside Convex node actions and the local
            runner. They are never stored in the browser, never returned by an API and never logged.
            A secret is only ever displayed as <em>Configured</em> / <em>Not configured</em>.
          </AlertDescription>
        </Alert>

        {!status ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            {/* -------------------------------------------- AI / LLM ------ */}
            <StatusCard
              title="AI / LLM"
              action={
                <div className="flex items-center gap-2">
                  <StatusBadge
                    tone={connectionTone(status.llm.state)}
                    label={connectionLabel(status.llm.state)}
                  />
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
                </div>
              }
            >
              <p className="text-xs text-muted-foreground">
                {status.llm.explicit
                  ? "At least one LLM_* variable is set on this deployment."
                  : "No LLM_* variable is set: the agent falls back to the built-in Ollama defaults, which will only work if Ollama runs on the machine that serves the action."}
              </p>

              <EnvTable rows={envVarsFor("ai")} valueOf={(row) => aiValue(row.name, status.llm)} />

              <div className="flex items-center justify-between border-t border-border/60 pt-3 text-xs text-muted-foreground">
                <span>Last check: {formatCheckedAt(status.llm.checkedAt)}</span>
                {status.llm.latencyMs !== null ? <span>{status.llm.latencyMs} ms</span> : null}
              </div>

              {llmResult ? (
                <Alert
                  variant={llmResult.state === "CONNECTED" ? "default" : "destructive"}
                  className="text-xs"
                >
                  <AlertTitle className="font-mono text-xs">
                    {llmResult.state === "CONNECTED"
                      ? "CONNECTED"
                      : llmResult.state === "NOT_CONFIGURED"
                        ? "NOT CONFIGURED"
                        : "CONNECTION FAILED"}
                  </AlertTitle>
                  <AlertDescription className="text-xs">
                    <span className="break-words">{llmResult.message}</span>
                    {llmResult.endpoint ? (
                      <span className="font-mono text-[11px] break-all">{llmResult.endpoint}</span>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}
            </StatusCard>

            {/* ---------------------------------------- BUILD RUNNER ------ */}
            <StatusCard
              title="Build runner"
              action={
                <div className="flex items-center gap-2">
                  <StatusBadge
                    tone={runnerTone(status.runner.state)}
                    label={runnerLabel(status.runner.state)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleTestRunner}
                    disabled={isTestingRunner}
                    className="h-7 gap-1.5 rounded-full text-xs"
                  >
                    {isTestingRunner ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <PlugZap className="h-3.5 w-3.5" />
                    )}
                    Test runner
                  </Button>
                </div>
              }
            >
              <p className="text-xs text-muted-foreground">
                Convex cannot execute `west`/`cmake`. A build is dispatched over HTTP to the runner
                started with <code className="font-mono">bun runner/index.ts serve</code>. Without a
                runner the build capability is reported as NOT AVAILABLE, never as a success.
              </p>

              <EnvTable
                rows={envVarsFor("runner")}
                valueOf={(row) => runnerValue(row.name, status.runner)}
              />

              <div className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
                Last check: {formatCheckedAt(status.runner.checkedAt)}
              </div>

              {runnerResult ? (
                <Alert
                  variant={runnerResult.state === "CONNECTED" ? "default" : "destructive"}
                  className="text-xs"
                >
                  <AlertTitle className="font-mono text-xs">{runnerResult.state}</AlertTitle>
                  <AlertDescription className="text-xs">
                    {runnerResult.message ? (
                      <span className="break-words">{runnerResult.message}</span>
                    ) : (
                      <span>
                        answered in {runnerResult.latencyMs ?? "?"} ms · ZEPHYR_BASE{" "}
                        {runnerResult.zephyrBase ?? "not set"}
                      </span>
                    )}
                    {runnerResult.tools ? (
                      <span className="flex flex-wrap gap-1.5 pt-1">
                        {Object.entries(runnerResult.tools).map(([tool, present]) => (
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
                      </span>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}
            </StatusCard>

            {/* ---------------------------------------------- GENERAL ----- */}
            <StatusCard title="General">
              <dl className="grid gap-2 text-sm">
                <GeneralRow
                  label="Verification model"
                  value="REAL · SIMULATED · NOT_AVAILABLE — a build is only SUCCESS with a real exit code 0"
                />
                <GeneralRow
                  label="Automatic repair attempts"
                  value={`${MAX_REPAIR_ATTEMPTS} per cycle (compiler output is fed back to the model)`}
                />
                <GeneralRow
                  label="Build timeout"
                  value={`${Math.round(runnerTimeoutMs / 60_000)} min per dispatched build`}
                />
                <GeneralRow
                  label="Knowledge base"
                  value="seeded automatically per account; retrieval is logged as evidence for every turn"
                />
                <GeneralRow
                  label="Diagnostics source"
                  value="the build runner's GET /doctor — the only machine that can inspect a toolchain"
                />
              </dl>
              <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
                Nothing on this page is writable from the browser: that is deliberate, so a
                credential can never be entered, stored or leaked client-side.
              </p>
            </StatusCard>
          </>
        )}
      </main>
    </div>
  );
}

function EnvTable({
  rows,
  valueOf,
}: {
  rows: EnvVarDoc[];
  valueOf: (row: EnvVarDoc) => string;
}) {
  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      {rows.map((row) => {
        const value = valueOf(row);
        const missing = value === "not set";
        return (
          <div key={row.name} className="grid gap-0.5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-x-4">
            <span className="font-mono text-xs text-foreground">
              {row.name}
              {row.secret ? <span className="ml-1.5 text-[10px] text-muted-foreground">secret</span> : null}
            </span>
            <div className="min-w-0">
              <span
                className={cn(
                  "font-mono text-xs break-all",
                  missing ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {value}
              </span>
              <p className="text-[11px] leading-4 text-muted-foreground">{row.description}</p>
            </div>
          </div>
        );
      })}
      <p className="pt-1 text-[11px] text-muted-foreground">
        {ENV_VAR_DOCS.length} deployment variables in total · the complete catalogue (including the
        runner-side toolchain variables) lives in <code className="font-mono">ENVIRONMENT.md</code>
      </p>
    </div>
  );
}

function GeneralRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
      <dt className="w-52 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-xs">{value}</dd>
    </div>
  );
}
