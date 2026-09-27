/**
 * Server-side LLM client.
 *
 * Runs inside Convex node actions, the local runner and the desktop Express
 * server. API keys never reach the browser.
 *
 * There is NO fake generation path: when the provider cannot be reached the
 * caller gets an explicit error and must not touch any file or start a build.
 */

export type LlmProvider = "ollama" | "openai";

export type LlmErrorCode =
  | "LLM_NOT_CONFIGURED"
  | "LLM_UNREACHABLE"
  | "LLM_TIMEOUT"
  | "LLM_HTTP_ERROR"
  | "LLM_EMPTY_RESPONSE";

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  temperature: number;
}

export type LlmConfigResult =
  | { ok: true; config: LlmConfig }
  | { ok: false; code: "LLM_NOT_CONFIGURED"; reason: string };

export type LlmCallResult =
  | {
      ok: true;
      text: string;
      attempts: number;
      durationMs: number;
      model: string;
      endpoint: string;
    }
  | {
      ok: false;
      code: LlmErrorCode;
      message: string;
      attempts: number;
      endpoint: string | null;
    };

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 1;

function isLocalHost(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "0.0.0.0" ||
      url.hostname === "::1" ||
      url.hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

export function resolveLlmConfig(
  env: Record<string, string | undefined>,
  overrides: Partial<LlmConfig> = {},
): LlmConfigResult {
  const provider = (overrides.provider ??
    (env.LLM_PROVIDER?.toLowerCase() === "openai" ? "openai" : "ollama")) as LlmProvider;

  const baseUrl =
    overrides.baseUrl ??
    env.LLM_BASE_URL ??
    (provider === "ollama" ? "http://localhost:11434" : "");

  const model =
    overrides.model ??
    env.LLM_MODEL ??
    (provider === "ollama" ? "llama3" : "gpt-4o-mini");

  const apiKey = overrides.apiKey ?? env.LLM_API_KEY ?? null;
  const timeoutMs = overrides.timeoutMs ?? Number(env.LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const maxRetries = overrides.maxRetries ?? Number(env.LLM_MAX_RETRIES ?? DEFAULT_RETRIES);
  const temperature = overrides.temperature ?? Number(env.LLM_TEMPERATURE ?? 0.2);

  if (baseUrl.trim() === "") {
    return {
      ok: false,
      code: "LLM_NOT_CONFIGURED",
      reason:
        "LLM_BASE_URL is not set. Configure an OpenAI-compatible endpoint (LLM_PROVIDER=openai) or reach a local Ollama.",
    };
  }

  if (provider === "openai" && !apiKey && !isLocalHost(baseUrl)) {
    return {
      ok: false,
      code: "LLM_NOT_CONFIGURED",
      reason:
        "LLM_API_KEY is not set for a remote OpenAI-compatible provider. Add the key in the Keys/API keys panel.",
    };
  }

  return {
    ok: true,
    config: {
      provider,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey,
      model,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
      maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : DEFAULT_RETRIES,
      temperature: Number.isFinite(temperature) ? temperature : 0.2,
    },
  };
}

function extractOllamaText(payload: Record<string, unknown>): string {
  return typeof payload.response === "string" ? payload.response : "";
}

function extractOpenAiText(payload: Record<string, unknown>): string {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  return typeof message?.content === "string" ? message.content : "";
}

function isRetryable(code: LlmErrorCode, status?: number): boolean {
  if (code === "LLM_UNREACHABLE" || code === "LLM_TIMEOUT") return true;
  if (code === "LLM_HTTP_ERROR" && status !== undefined && status >= 500) return true;
  return false;
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export async function callLlm(
  config: LlmConfig,
  prompt: string,
  options: { fetchImpl?: FetchLike; log?: (message: string) => void } = {},
): Promise<LlmCallResult> {
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const log = options.log ?? (() => {});
  const started = Date.now();

  const endpoint =
    config.provider === "ollama"
      ? `${config.baseUrl}/api/generate`
      : `${config.baseUrl}/chat/completions`;

  const body =
    config.provider === "ollama"
      ? JSON.stringify({
          model: config.model,
          prompt,
          stream: false,
          format: "json",
          options: { temperature: config.temperature },
        })
      : JSON.stringify({
          model: config.model,
          temperature: config.temperature,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Answer with a single JSON object, no prose." },
            { role: "user", content: prompt },
          ],
        });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.provider === "openai" && config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const maxAttempts = Math.max(1, config.maxRetries + 1);
  let lastCode: LlmErrorCode = "LLM_UNREACHABLE";
  let lastMessage = "unknown error";
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      log(
        `[llm] provider=${config.provider} model=${config.model} endpoint=${endpoint} attempt=${attempt}/${maxAttempts}`,
      );
      const response = await doFetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        lastCode = "LLM_HTTP_ERROR";
        lastStatus = response.status;
        lastMessage = `provider returned HTTP ${response.status}: ${text.slice(0, 400)}`;
        log(`[llm] ${lastMessage}`);
        if (isRetryable(lastCode, lastStatus) && attempt < maxAttempts) continue;
        return { ok: false, code: lastCode, message: lastMessage, attempts: attempt, endpoint };
      }

      const payload = (await response.json().catch(() => null)) as unknown;
      const record = (payload ?? {}) as Record<string, unknown>;
      const text =
        config.provider === "ollama"
          ? extractOllamaText(record)
          : extractOpenAiText(record);

      if (text.trim() === "") {
        lastCode = "LLM_EMPTY_RESPONSE";
        lastMessage = "provider answered with an empty completion";
        log(`[llm] ${lastMessage}`);
        if (attempt < maxAttempts) continue;
        return { ok: false, code: lastCode, message: lastMessage, attempts: attempt, endpoint };
      }

      return {
        ok: true,
        text,
        attempts: attempt,
        durationMs: Date.now() - started,
        model: config.model,
        endpoint,
      };
    } catch (error) {
      clearTimeout(timer);
      const aborted = error instanceof Error && error.name === "AbortError";
      lastCode = aborted ? "LLM_TIMEOUT" : "LLM_UNREACHABLE";
      lastMessage =
        error instanceof Error
          ? `${aborted ? "provider did not answer within" : "provider unreachable:"} ${error.message}`
          : String(error);
      log(`[llm] ${lastMessage}`);
      if (isRetryable(lastCode) && attempt < maxAttempts) continue;
      return { ok: false, code: lastCode, message: lastMessage, attempts: attempt, endpoint };
    }
  }

  return {
    ok: false,
    code: lastCode,
    message: lastMessage,
    attempts: maxAttempts,
    endpoint,
  };
}

export const LLM_UNAVAILABLE_MESSAGE =
  "LLM unavailable — no files were created or modified and no build was started.";
