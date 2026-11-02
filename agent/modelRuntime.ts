/**
 * Generation runtime boundary.
 *
 * `agent/turn.ts` never talks to a provider directly. It asks a `ModelRuntime`
 * for one answer, so the same validated patch/build cycle can run on:
 *
 *   - `llmClient`        the existing Ollama / OpenAI-compatible client;
 *   - `claude-agent-sdk` Claude Agent SDK;
 *   - `fake`             a test double, explicitly marked FAKE.
 *
 * The fake runtime is not a silent fallback: it must be passed explicitly (or
 * selected by a profile with `allowFake: true`), and every answer is marked
 * `fake: true`.
 */
import {
  callLlm,
  resolveLlmConfig,
  type LlmErrorCode,
} from "../core/llmClient";
import type { ModelConfig, ModelRuntimeProvider, ProductProfile } from "../core/profile";

export type ModelRuntimeErrorCode =
  | LlmErrorCode
  | "MODEL_RUNTIME_UNAVAILABLE"
  | "MODEL_RUNTIME_FAKE_DISABLED"
  | "MODEL_RUNTIME_ERROR";

export interface ModelRuntimeRequest {
  /** Fixed agent instructions, e.g. the JSON patch protocol. */
  system: string;
  /** Turn-specific project/files/build context. */
  prompt: string;
}

export interface ModelRuntimeSuccess {
  ok: true;
  text: string;
  provider: ModelRuntimeProvider;
  /** True only for the explicitly marked test double. */
  fake: boolean;
  model: string;
  endpoint: string | null;
  attempts: number;
  durationMs: number;
}

export interface ModelRuntimeFailure {
  ok: false;
  code: ModelRuntimeErrorCode;
  message: string;
  provider: ModelRuntimeProvider;
  fake: boolean;
  model: string | null;
  endpoint: string | null;
  attempts: number;
  durationMs: number;
}

export type ModelRuntimeResult = ModelRuntimeSuccess | ModelRuntimeFailure;

export interface ModelRuntime {
  readonly provider: ModelRuntimeProvider;
  /** True only for the test double; never inferred from a provider name. */
  readonly fake: boolean;
  generate(request: ModelRuntimeRequest): Promise<ModelRuntimeResult>;
}

const DEFAULT_CLAUDE_TIMEOUT_MS = 180_000;

/* ------------------------------------------------------------------ llmClient */

export interface LlmClientRuntimeOptions {
  env?: Record<string, string | undefined>;
  /** Applied on top of the environment (e.g. model from the profile). */
  model?: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  log?: (message: string) => void;
}

/** The existing Ollama / OpenAI-compatible client behind the runtime contract. */
export class LlmClientRuntime implements ModelRuntime {
  readonly provider = "llmClient" as const;
  readonly fake = false;

  private readonly env: Record<string, string | undefined>;
  private readonly model: string | undefined;
  private readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly log: (message: string) => void;

  constructor(options: LlmClientRuntimeOptions = {}) {
    this.env = options.env ?? process.env;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl;
    this.log = options.log ?? (() => {});
  }

  async generate(request: ModelRuntimeRequest): Promise<ModelRuntimeResult> {
    const started = Date.now();
    const resolved = resolveLlmConfig(
      this.env,
      this.model === undefined ? {} : { model: this.model },
    );
    if (!resolved.ok) {
      return {
        ok: false,
        code: "LLM_NOT_CONFIGURED",
        message: resolved.reason,
        provider: this.provider,
        fake: false,
        model: this.model ?? null,
        endpoint: null,
        attempts: 0,
        durationMs: Date.now() - started,
      };
    }

    const result = await callLlm(resolved.config, `${request.system}\n\n${request.prompt}`, {
      fetchImpl: this.fetchImpl,
      log: this.log,
    });
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message: result.message,
        provider: this.provider,
        fake: false,
        model: resolved.config.model,
        endpoint: result.endpoint,
        attempts: result.attempts,
        durationMs: Date.now() - started,
      };
    }

    return {
      ok: true,
      text: result.text,
      provider: this.provider,
      fake: false,
      model: result.model,
      endpoint: result.endpoint,
      attempts: result.attempts,
      durationMs: result.durationMs,
    };
  }
}

/* ------------------------------------------------------------ claude-agent-sdk */

/** The tiny part of the SDK's query function this adapter needs. */
export type ClaudeAgentSdkQuery = (params: {
  prompt: string;
  options?: import("@anthropic-ai/claude-agent-sdk").Options;
}) => AsyncIterable<import("@anthropic-ai/claude-agent-sdk").SDKMessage>;

export interface ClaudeAgentSdkRuntimeOptions {
  env?: Record<string, string | undefined>;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Injected in tests; production uses the package's exported `query`. */
  queryImpl?: ClaudeAgentSdkQuery;
}

/**
 * Claude Agent SDK runtime. It runs one tool-free turn: the model may only
 * answer, while the validated patch gate in `turn.ts` remains the only path to
 * a file. The SDK spawns the Claude Code binary, so importing the package and
 * spawning happen only when this runtime is actually selected.
 */
export class ClaudeAgentSdkRuntime implements ModelRuntime {
  readonly provider = "claude-agent-sdk" as const;
  readonly fake = false;

  private readonly env: Record<string, string | undefined>;
  private readonly model: string | undefined;
  private readonly cwd: string | undefined;
  private readonly timeoutMs: number;
  private readonly queryImpl: ClaudeAgentSdkQuery | undefined;

  constructor(options: ClaudeAgentSdkRuntimeOptions = {}) {
    this.env = options.env ?? process.env;
    this.model = options.model;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS;
    this.queryImpl = options.queryImpl;
  }

  async generate(request: ModelRuntimeRequest): Promise<ModelRuntimeResult> {
    const started = Date.now();
    const env = { ...process.env, ...this.env };
    if (!env.ANTHROPIC_API_KEY?.trim()) {
      return {
        ok: false,
        code: "LLM_NOT_CONFIGURED",
        message:
          "ANTHROPIC_API_KEY is not set. The Claude Agent SDK reads it from the environment of the process that runs the agent.",
        provider: this.provider,
        fake: false,
        model: this.model ?? null,
        endpoint: null,
        attempts: 0,
        durationMs: Date.now() - started,
      };
    }

    let query = this.queryImpl;
    if (!query) {
      try {
        const sdk = await import("@anthropic-ai/claude-agent-sdk");
        query = sdk.query;
      } catch (error) {
        return {
          ok: false,
          code: "MODEL_RUNTIME_UNAVAILABLE",
          message: `Claude Agent SDK could not be loaded: ${
            error instanceof Error ? error.message : String(error)
          }`,
          provider: this.provider,
          fake: false,
          model: this.model ?? null,
          endpoint: null,
          attempts: 0,
          durationMs: Date.now() - started,
        };
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const stream = query({
        prompt: request.prompt,
        options: {
          systemPrompt: request.system,
          model: this.model,
          tools: [],
          disallowedTools: ["*"],
          settingSources: [],
          persistSession: false,
          maxTurns: 1,
          permissionMode: "dontAsk",
          permissionPrompts: "none",
          ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
          env,
          abortController: controller,
        },
      });

      for await (const message of stream) {
        if (message.type !== "result") continue;

        if (message.subtype === "success" && !message.is_error) {
          const text = message.result.trim();
          if (text === "") {
            return {
              ok: false,
              code: "LLM_EMPTY_RESPONSE",
              message: "Claude Agent SDK answered with an empty completion",
              provider: this.provider,
              fake: false,
              model: this.model ?? "claude-agent-sdk",
              endpoint: null,
              attempts: 1,
              durationMs: Date.now() - started,
            };
          }
          return {
            ok: true,
            text,
            provider: this.provider,
            fake: false,
            model: this.model ?? "claude-agent-sdk",
            endpoint: null,
            attempts: 1,
            durationMs: Date.now() - started,
          };
        }

        const reason =
          message.subtype === "success"
            ? message.result
            : message.errors.join("; ") || message.subtype;
        return {
          ok: false,
          code: controller.signal.aborted ? "LLM_TIMEOUT" : "MODEL_RUNTIME_ERROR",
          message: `Claude Agent SDK failed: ${reason || "unknown error"}`,
          provider: this.provider,
          fake: false,
          model: this.model ?? "claude-agent-sdk",
          endpoint: null,
          attempts: 1,
          durationMs: Date.now() - started,
        };
      }

      return {
        ok: false,
        code: controller.signal.aborted ? "LLM_TIMEOUT" : "MODEL_RUNTIME_ERROR",
        message: "Claude Agent SDK ended without a result message",
        provider: this.provider,
        fake: false,
        model: this.model ?? "claude-agent-sdk",
        endpoint: null,
        attempts: 1,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        code: controller.signal.aborted ? "LLM_TIMEOUT" : "MODEL_RUNTIME_ERROR",
        message: `Claude Agent SDK query failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        provider: this.provider,
        fake: false,
        model: this.model ?? "claude-agent-sdk",
        endpoint: null,
        attempts: 1,
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ----------------------------------------------------------------------- fake */

export type FakeModelResponder = (
  request: ModelRuntimeRequest,
  call: number,
) => string | Promise<string>;

export interface FakeModelRuntimeOptions {
  model?: string;
}

/**
 * FAKE — test double, not a provider.
 *
 * It never opens a socket and every answer carries `fake: true`. Use it only
 * through tests or through `createModelRuntime(..., { allowFake: true })`.
 */
export class FakeModelRuntime implements ModelRuntime {
  readonly provider = "fake" as const;
  readonly fake = true;
  readonly simulated = true;

  private readonly responder: FakeModelResponder;
  private readonly model: string;
  private calls = 0;

  constructor(
    responses: FakeModelResponder | readonly string[],
    options: FakeModelRuntimeOptions = {},
  ) {
    this.responder =
      typeof responses === "function"
        ? responses
        : (() => {
            const list = [...responses];
            return (_request: ModelRuntimeRequest, call: number) => {
              const text = list[Math.min(call - 1, list.length - 1)];
              if (text === undefined) {
                throw new Error("FakeModelRuntime has no response configured");
              }
              return text;
            };
          })();
    this.model = options.model ?? "fake-model";
  }

  describe(): string {
    return "FAKE model runtime (test double) — no provider was contacted";
  }

  get callCount(): number {
    return this.calls;
  }

  async generate(request: ModelRuntimeRequest): Promise<ModelRuntimeResult> {
    this.calls += 1;
    try {
      const text = await this.responder(request, this.calls);
      if (text.trim() === "") {
        return {
          ok: false,
          code: "LLM_EMPTY_RESPONSE",
          message: "fake runtime produced an empty completion",
          provider: this.provider,
          fake: true,
          model: this.model,
          endpoint: null,
          attempts: 1,
          durationMs: 0,
        };
      }
      return {
        ok: true,
        text,
        provider: this.provider,
        fake: true,
        model: this.model,
        endpoint: null,
        attempts: 1,
        durationMs: 0,
      };
    } catch (error) {
      return {
        ok: false,
        code: "MODEL_RUNTIME_ERROR",
        message: error instanceof Error ? error.message : String(error),
        provider: this.provider,
        fake: true,
        model: this.model,
        endpoint: null,
        attempts: 1,
        durationMs: 0,
      };
    }
  }
}

/* -------------------------------------------------------------------- factory */

export interface ModelRuntimeFactoryOptions {
  env?: Record<string, string | undefined>;
  allowFake?: boolean;
  /** Scripted answers for the fake runtime; tests must provide them. */
  fakeResponses?: FakeModelResponder | readonly string[];
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  log?: (message: string) => void;
  cwd?: string;
  timeoutMs?: number;
  queryImpl?: ClaudeAgentSdkQuery;
}

export type ModelRuntimeFactoryResult =
  | { ok: true; runtime: ModelRuntime }
  | { ok: false; code: ModelRuntimeErrorCode; message: string };

/**
 * Selects the provider declared by the profile. No provider silently falls
 * back to another one; fake needs an explicit test/demo opt-in.
 */
export function createModelRuntime(
  config: ModelConfig | undefined,
  options: ModelRuntimeFactoryOptions = {},
): ModelRuntimeFactoryResult {
  const provider = config?.provider ?? "llmClient";

  if (provider === "fake") {
    if (!options.allowFake) {
      return {
        ok: false,
        code: "MODEL_RUNTIME_FAKE_DISABLED",
        message:
          "the profile selects the fake model runtime; it is a test double and requires allowFake: true",
      };
    }
    return {
      ok: true,
      runtime: new FakeModelRuntime(options.fakeResponses ?? [], { model: config?.model }),
    };
  }

  if (provider === "claude-agent-sdk") {
    return {
      ok: true,
      runtime: new ClaudeAgentSdkRuntime({
        env: options.env,
        model: config?.model,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        queryImpl: options.queryImpl,
      }),
    };
  }

  return {
    ok: true,
    runtime: new LlmClientRuntime({
      env: options.env,
      model: config?.model,
      fetchImpl: options.fetchImpl,
      log: options.log,
    }),
  };
}

/** Convenience wrapper for callers that already loaded the product profile. */
export function createModelRuntimeFromProfile(
  profile: Pick<ProductProfile, "llm">,
  options: ModelRuntimeFactoryOptions = {},
): ModelRuntimeFactoryResult {
  return createModelRuntime(profile.llm, options);
}
