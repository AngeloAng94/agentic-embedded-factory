/**
 * Serial capture that starts before flash or reset and stays open.
 *
 * The orchestrator must start the capture first, then flash/reset, then observe.
 * A capture started late loses the boot banner that carries the acceptance
 * criteria, so `stop()` compares the capture start time with the flash/reset
 * events: if an event happened before the capture started, the result is marked
 * `complete: false` with the missed events. It is still a real capture, but it
 * cannot be used as if it covered the boot.
 *
 * Without a configured port/command or without the helper binary, starting is
 * NOT_AVAILABLE: there is no invented serial output.
 */
import type { ProductProfile } from "../core/profile";
import {
  invalidRequest,
  notAvailable,
  toolFailed,
  toolOk,
  type ToolOutcome,
} from "../core/toolResult";
import {
  systemResolver,
  tokenize,
  type BinaryResolver,
} from "./exec";

export type SerialEventKind = "flash" | "reset";

export interface SerialEvent {
  kind: SerialEventKind;
  at: number;
}

export interface SerialBackendHandle {
  stop(): Promise<string>;
}

export interface SerialBackend {
  readonly simulated: boolean;
  start(): ToolOutcome<SerialBackendHandle>;
}

export interface SerialCaptureResult {
  text: string;
  /** True only when the capture was running before every flash/reset event. */
  complete: boolean;
  reason: string | null;
  /** Flash/reset events that happened before the capture started. */
  missed: SerialEvent[];
  events: SerialEvent[];
  startedAt: number;
  stoppedAt: number;
}

async function drain(
  stream: ReadableStream<Uint8Array> | undefined,
  append: (text: string) => void,
): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      append(decoder.decode(value, { stream: true }));
    }
    append(decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

/** Real backend: spawns the profile's capture command and keeps reading it. */
export function createSerialBackend(
  profile: ProductProfile,
  options: { timeoutMs?: number; cwd?: string; resolve?: BinaryResolver } = {},
): ToolOutcome<SerialBackend> {
  const resolve = options.resolve ?? systemResolver;

  if (!profile.seriale) {
    return notAvailable("no serial port configured in the profile (seriale.porta)");
  }
  if (!profile.seriale.comando) {
    return notAvailable(
      "no serial capture command configured (seriale.comando): opening a port needs an OS-specific helper",
    );
  }

  const command = profile.seriale.comando
    .replaceAll("{porta}", profile.seriale.porta)
    .replaceAll("{baud}", String(profile.seriale.baud));
  const argv = tokenize(command);
  if (argv.length === 0) return notAvailable("seriale.comando is empty after substitution");
  if (!resolve(argv[0]!)) return notAvailable(`"${argv[0]}" is not installed or not in PATH`);

  return toolOk({
    simulated: false,
    start() {
      try {
        const proc = Bun.spawn(argv, {
          cwd: options.cwd,
          stdout: "pipe",
          stderr: "pipe",
        });
        let text = "";
        const pump = Promise.all([
          drain(proc.stdout, (chunk) => {
            text += chunk;
          }),
          drain(proc.stderr, (chunk) => {
            text += chunk;
          }),
        ]);

        const timer =
          options.timeoutMs === undefined
            ? null
            : setTimeout(() => {
                if (proc.exitCode === null) proc.kill();
              }, options.timeoutMs);

        return toolOk({
          stop: async () => {
            if (proc.exitCode === null) proc.kill();
            try {
              await pump;
            } finally {
              if (timer !== null) clearTimeout(timer);
            }
            return text;
          },
        });
      } catch (error) {
        return toolFailed(
          `cannot start serial capture: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  });
}

/** Test backend: explicitly simulated, never REAL evidence. */
export function fakeSerialBackend(text = "BOOT OK\n"): SerialBackend {
  return {
    simulated: true,
    start: () => toolOk({ stop: async () => text }, "SIMULATED"),
  };
}

interface RecordedEvent extends SerialEvent {
  order: number;
}

export class SerialCaptureSession {
  private readonly backend: SerialBackend;
  private handle: SerialBackendHandle | null = null;
  private startedAt: number | null = null;
  private startOrder: number | null = null;
  private clock = 0;
  private stopped = false;
  private verification: "REAL" | "SIMULATED" = "REAL";
  private events: RecordedEvent[] = [];

  constructor(backend: SerialBackend) {
    this.backend = backend;
  }

  get running(): boolean {
    return this.handle !== null && !this.stopped;
  }

  /** Must be called before the first flash or reset. */
  start(): ToolOutcome<{ startedAt: number }> {
    if (this.handle !== null) return invalidRequest("serial capture was already started");
    if (this.stopped) return invalidRequest("serial capture was already stopped");

    const started = this.backend.start();
    if (!started.ok) return started;

    this.handle = started.value;
    this.startedAt = performance.now();
    this.startOrder = ++this.clock;
    this.verification = started.verification;
    return toolOk({ startedAt: this.startedAt }, started.verification);
  }

  noteFlash(): void {
    this.events.push({ kind: "flash", at: performance.now(), order: ++this.clock });
  }

  noteReset(): void {
    this.events.push({ kind: "reset", at: performance.now(), order: ++this.clock });
  }

  async stop(): Promise<ToolOutcome<SerialCaptureResult>> {
    if (this.handle === null || this.startedAt === null) {
      return toolFailed(
        "serial capture was not started: start it before flash or reset, or its boot log cannot be trusted",
      );
    }
    if (this.stopped) return invalidRequest("serial capture was already stopped");
    this.stopped = true;

    let text: string;
    try {
      text = await this.handle.stop();
    } catch (error) {
      return toolFailed(
        `serial capture failed while stopping: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const stoppedAt = performance.now();
    const missed = this.events.filter((event) => event.order < this.startOrder!);
    const complete = missed.length === 0;
    const reason = complete
      ? null
      : `serial capture started after ${missed.map((event) => event.kind).join(", ")}; the boot log before it is missing`;

    return toolOk(
      {
        text,
        complete,
        reason,
        missed,
        events: this.events.map(({ kind, at }) => ({ kind, at })),
        startedAt: this.startedAt,
        stoppedAt,
      },
      this.verification,
    );
  }
}
