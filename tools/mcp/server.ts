/**
 * MCP server for the bench tools.
 *
 * The server is deliberately a thin, honest boundary:
 *
 *  - read-only tools observe; board-effect tools can change hardware/files;
 *  - every call returns structured evidence, not only prose;
 *  - `flash` is refused unless this session recorded a SUCCESSful
 *    `memory_map_check` for the exact SHA-256 of the ELF being flashed;
 *  - a target the latest doctor marked unreliable blocks flash until the doctor
 *    is run again and reports `readsReliable: true`.
 *
 * `simulated` is the explicit `--simulate` mode for tests and demos (never an
 * environment variable). It is marked in every result and never returns REAL.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { z } from "zod";
import type { ProductProfile } from "../../core/profile";
import { toolOk, type ToolOutcome } from "../../core/toolResult";
import type { Verdict, Verification } from "../../core/types";
import { runBuild } from "../build";
import { runGdbBatch } from "../debug";
import { validateDebugCommands } from "../debugPolicy";
import { runProfileDoctor, type DoctorCheck, type ProfileDoctorReport } from "../doctor";
import type { ExecResult } from "../exec";
import { runFlash } from "../flash";
import { checkMemoryMap, type MemoryMapReport } from "../memoryMap";
import {
  gdbReader,
  readState,
  type ReadDirection,
  type ReadOnceResult,
  type ReadStateMode,
  type ReadStateValue,
} from "../readState";
import {
  createSerialBackend,
  fakeSerialBackend,
  SerialCaptureSession,
  type SerialBackend,
  type SerialCaptureResult,
  type SerialCaptureStatus,
} from "../serialCapture";
import { runTargetTest } from "../targetTest";
import {
  McpRunState,
  type McpRunRecord,
  type ToolEvidence,
  type ToolGroup,
} from "./runState";

export const READ_ONLY_TOOL_NAMES = [
  "doctor",
  "memory_map_check",
  "read_state",
  "serial_capture",
  "run_record",
] as const;

export const SIDE_EFFECT_TOOL_NAMES = [
  "build",
  "flash",
  "debug",
  "target_test",
] as const;

export const WORK_RULES =
  "Work rules: verify on the board before claiming; read twice with the declared mode (stable or progressing); check the memory map before flash.";

export const MCP_INSTRUCTIONS = [
  "PY Bench Agent exposes two declared groups.",
  `Read-only group: ${READ_ONLY_TOOL_NAMES.join(", ")}.`,
  `Side-effect group (changes the board or the project): ${SIDE_EFFECT_TOOL_NAMES.join(", ")}.`,
  WORK_RULES,
  "flash is refused unless the current run record contains a SUCCESS memory_map_check for the same ELF SHA-256, and the latest doctor did not mark the target unreliable.",
  "serial_capture is a session: start it before flash or reset, then stop it to read the captured boot log.",
  "Every response carries verification, verdict, actor, and the structured evidence for the current run.",
].join(" ");

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const EFFECT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const FLASH_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const DEBUG_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const TARGET_TEST_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

function withRules(description: string): string {
  return `${description} ${WORK_RULES}`;
}

export type McpMode = "real" | "simulated";

export interface McpServerOptions {
  profile: ProductProfile;
  mode?: McpMode;
  projectDir?: string;
  /** Injectable for unit tests; normally created from the profile. */
  serialBackend?: SerialBackend;
}

export interface ToolResponse<T> {
  ok: boolean;
  tool: string;
  group: ToolGroup;
  verification: Verification;
  verdict: Verdict;
  actor: "tool";
  actorId: string;
  simulated: boolean;
  maxLevel: "compiled" | null;
  evidence: ToolEvidence[];
  result: T | null;
  reason: string | null;
  artifact: string | null;
  sha256: string | null;
  runRecord: McpRunRecord;
  serial: SerialCaptureStatus;
}

function textResult<T>(response: ToolResponse<T>): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
} {
  const suffix = response.reason ? ` — ${response.reason}` : "";
  return {
    content: [
      {
        type: "text",
        text: `${response.tool}: ${response.verification} · ${response.verdict}${suffix}`,
      },
    ],
    structuredContent: response as unknown as Record<string, unknown>,
    isError: !response.ok,
  };
}

function simulatedDoctor(profile: ProductProfile): ProfileDoctorReport {
  const check: DoctorCheck = {
    id: "mcp.simulated",
    label: "simulated target",
    required: true,
    status: "PASS",
    detail: "SIMULATED: MCP test mode; no board was contacted",
  };
  return {
    profile: profile.prodotto,
    checks: [check],
    target: {
      state: "READY",
      readsReliable: true,
      reason: null,
      checks: [check],
    },
    state: "READY",
  };
}

function simulatedExec(command: string): ExecResult {
  return {
    argv: ["[simulated]", command],
    display: `[simulated] ${command}`,
    exitCode: 0,
    stdout: `[simulated] ${command} ok\n`,
    stderr: "",
    durationMs: 0,
    timedOut: false,
  };
}

function simulatedReader(
  mode: ReadStateMode,
  direction: ReadDirection | undefined,
): () => Promise<ReadOnceResult> {
  let count = 0;
  return async () => {
    count += 1;
    const value = direction === "decreasing" ? 10 - count : count;
    return {
      ok: true,
      bytes: mode === "stable" ? [0xde, 0xad, 0xbe, 0xef] : [value],
      verification: "SIMULATED",
      tool: "mcp-simulation",
    };
  };
}

function isResetCommand(command: string): boolean {
  return /(^|[\s;])(reset|restart)([\s;]|$)/i.test(command);
}

function failureVerification(reason: string, mode: McpMode): Verification {
  if (mode === "simulated") return "SIMULATED";
  if (
    /not installed|not in PATH|not available|no serial|no artifact|cannot read|no .* configured|unreliable/i.test(
      reason,
    )
  ) {
    return "NOT_AVAILABLE";
  }
  return "REAL";
}

function failureVerdict(verification: Verification): Verdict {
  return verification === "NOT_AVAILABLE" ? "UNKNOWN" : "FAILURE";
}

function outcomeVerdict(exitCode: number | null): Verdict {
  if (exitCode === 0) return "SUCCESS";
  if (exitCode === null) return "UNKNOWN";
  return "FAILURE";
}

function resolvePath(projectDir: string, input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(projectDir, input);
}

function serialSession(
  profile: ProductProfile,
  mode: McpMode,
  injected: SerialBackend | undefined,
  projectDir: string,
): SerialCaptureSession {
  if (injected) return new SerialCaptureSession(injected);
  if (mode === "simulated") return new SerialCaptureSession(fakeSerialBackend());
  const backend = createSerialBackend(profile, { cwd: projectDir });
  if (backend.ok) return new SerialCaptureSession(backend.value);
  return new SerialCaptureSession({
    simulated: false,
    start: () => backend,
  });
}

function toolResponse<T>(
  run: McpRunState,
  serial: SerialCaptureSession,
  input: {
    tool: string;
    group: ToolGroup;
    ok: boolean;
    verification: Verification;
    verdict: Verdict;
    result: T | null;
    reason: string | null;
    detail: string;
    artifact?: string | null;
    sha256?: string | null;
    record?: boolean;
  },
): ToolResponse<T> {
  const artifact = input.artifact ?? null;
  const sha256 = input.sha256 ?? null;
  const verification: Verification = run.simulated ? "SIMULATED" : input.verification;
  if (input.record !== false) {
    run.recordEvidence({
      tool: input.tool,
      group: input.group,
      verification,
      verdict: input.verdict,
      detail: input.detail,
      artifact,
      sha256,
    });
  }
  return {
    ok: input.ok,
    tool: input.tool,
    group: input.group,
    verification,
    verdict: input.verdict,
    actor: "tool",
    actorId: "py-bench-mcp",
    simulated: run.simulated,
    maxLevel: run.simulated ? "compiled" : null,
    evidence: run.evidence.map((entry) => ({ ...entry })),
    result: input.result,
    reason: input.reason,
    artifact,
    sha256,
    runRecord: run.snapshot(),
    serial: serial.getStatus(),
  };
}

export function createPyBenchMcpServer(options: McpServerOptions): McpServer {
  const profile = options.profile;
  const mode: McpMode = options.mode ?? "real";
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const run = new McpRunState(profile, { simulated: mode === "simulated" });
  const serial = serialSession(profile, mode, options.serialBackend, projectDir);

  const server = new McpServer(
    { name: "py-bench-agent", version: "0.1.0" },
    { instructions: MCP_INSTRUCTIONS },
  );

  server.registerTool(
    "doctor",
    {
      title: "Doctor",
      description: withRules(
        "[read-only] Run the environment and target doctor. Verify the target on the board before trusting any later read; a flash mismatch or an unreadable probe marks the target unreliable.",
      ),
      inputSchema: {
        artifact: z
          .string()
          .optional()
          .describe("ELF that should be on the board, for the real flash comparison"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ artifact }) => {
      const artifactPath = artifact ? resolvePath(projectDir, artifact) : undefined;
      const report =
        mode === "simulated"
          ? simulatedDoctor(profile)
          : runProfileDoctor(profile, { artifactPath });
      run.recordDoctor(report);
      const verdict: Verdict =
        report.target.state === "READY"
          ? "SUCCESS"
          : report.target.state === "NOT_READY"
            ? "FAILURE"
            : "UNKNOWN";
      const verification: Verification = mode === "simulated" ? "SIMULATED" : "REAL";
      const response = toolResponse(run, serial, {
        tool: "doctor",
        group: "read-only",
        ok: true,
        verification,
        verdict,
        result: report,
        reason: report.target.reason,
        detail: `doctor target ${report.target.state}; readsReliable=${report.target.readsReliable}`,
        artifact: artifactPath ?? null,
      });
      return textResult(response);
    },
  );

  server.registerTool(
    "memory_map_check",
    {
      title: "Memory map check",
      description: withRules(
        "[read-only] Check the real ELF addresses, LMA/VMA placements, vector table and entry point against the chip regions. Flash is refused until this returns SUCCESS for the exact same ELF SHA-256.",
      ),
      inputSchema: {
        artifact: z.string().min(1).describe("ELF to check"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ artifact }) => {
      const artifactPath = resolvePath(projectDir, artifact);
      const checked = checkMemoryMap(profile, { artifactPath });
      if (!checked.ok) {
        const verification = failureVerification(checked.reason, mode);
        const response = toolResponse(run, serial, {
          tool: "memory_map_check",
          group: "read-only",
          ok: false,
          verification,
          verdict: failureVerdict(verification),
          result: null,
          reason: checked.reason,
          detail: checked.reason,
          artifact: artifactPath,
        });
        return textResult(response);
      }

      const report: MemoryMapReport = checked.value;
      run.recordMemoryMap(report);
      const response = toolResponse(run, serial, {
        tool: "memory_map_check",
        group: "read-only",
        ok: true,
        verification: checked.verification,
        verdict: report.verdict,
        result: report,
        reason: report.verdict === "SUCCESS" ? null : `memory map verdict is ${report.verdict}`,
        detail: `memory map ${report.verdict} for sha256 ${report.sha256}`,
        artifact: artifactPath,
        sha256: report.sha256,
      });
      return textResult(response);
    },
  );

  server.registerTool(
    "read_state",
    {
      title: "Read target state",
      description: withRules(
        "[read-only] Read a target value twice with the mode the caller declares. stable requires identical reads; progressing requires movement in the declared direction. A single read is not evidence.",
      ),
      inputSchema: {
        mode: z.enum(["stable", "progressing"]).describe("stable or progressing"),
        direction: z
          .enum(["increasing", "decreasing"])
          .optional()
          .describe("required when mode is progressing"),
        address: z
          .union([z.string(), z.number()])
          .describe("target address, for example 0x20000000"),
        length: z.number().int().positive().default(4).describe("bytes per read"),
        criterion: z
          .string()
          .optional()
          .describe("profile criterion this reading is evidence for"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ mode: requestedMode, direction, address, length, criterion }) => {
      const target = run.doctor
        ? {
            reliable: run.doctor.report.target.readsReliable,
            reason: run.doctor.report.target.reason,
          }
        : undefined;
      const readOnce =
        mode === "simulated"
          ? simulatedReader(requestedMode, direction as ReadDirection | undefined)
          : gdbReader(profile, { address, length });
      const read = await readState(readOnce, {
        mode: requestedMode,
        direction: direction as ReadDirection | undefined,
        target,
      });

      if (!read.ok) {
        const verification = failureVerification(read.reason, mode);
        const response = toolResponse(run, serial, {
          tool: "read_state",
          group: "read-only",
          ok: false,
          verification,
          verdict: failureVerdict(verification),
          result: null,
          reason: read.reason,
          detail: read.reason,
          artifact: null,
        });
        return textResult(response);
      }

      const value: ReadStateValue = read.value;
      const response = toolResponse(run, serial, {
        tool: "read_state",
        group: "read-only",
        ok: true,
        verification: read.verification,
        verdict: "SUCCESS",
        result: value,
        reason: null,
        detail: `read_state ${value.mode}: ${value.firstValue} → ${value.secondValue} (${value.relation})${
          criterion ? `; criterion=${criterion}` : ""
        }`,
        artifact: null,
      });
      return textResult(response);
    },
  );

  server.registerTool(
    "serial_capture",
    {
      title: "Serial capture session",
      description: withRules(
        "[read-only] Session control for serial capture: start, stop, status. Start before flash or reset so the boot banner is not missed; stop returns complete=false and the missed events if the capture started late.",
      ),
      inputSchema: {
        action: z.enum(["start", "stop", "status"]).describe("session action"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ action }) => {
      if (action === "status") {
        const status = serial.getStatus();
        const verdict: Verdict =
          status.state === "stopped"
            ? status.complete === true
              ? "SUCCESS"
              : "FAILURE"
            : "UNKNOWN";
        const response = toolResponse(run, serial, {
          tool: "serial_capture",
          group: "read-only",
          ok: true,
          verification: status.verification,
          verdict,
          result: status,
          reason: status.reason,
          detail: `serial capture ${status.state}; complete=${String(status.complete)}`,
          artifact: null,
          record: false,
        });
        return textResult(response);
      }

      if (action === "start") {
        const started = serial.start();
        if (!started.ok) {
          const verification = failureVerification(started.reason, mode);
          const response = toolResponse(run, serial, {
            tool: "serial_capture",
            group: "read-only",
            ok: false,
            verification,
            verdict: failureVerdict(verification),
            result: serial.getStatus(),
            reason: started.reason,
            detail: started.reason,
            artifact: null,
          });
          return textResult(response);
        }
        const status = serial.getStatus();
        const response = toolResponse(run, serial, {
          tool: "serial_capture",
          group: "read-only",
          ok: true,
          verification: started.verification,
          verdict: "SUCCESS",
          result: status,
          reason: null,
          detail: `serial capture started at ${status.startedAt ?? "unknown"}`,
          artifact: null,
        });
        return textResult(response);
      }

      const stopped = await serial.stop();
      if (!stopped.ok) {
        const verification = failureVerification(stopped.reason, mode);
        const response = toolResponse(run, serial, {
          tool: "serial_capture",
          group: "read-only",
          ok: false,
          verification,
          verdict: failureVerdict(verification),
          result: serial.getStatus(),
          reason: stopped.reason,
          detail: stopped.reason,
          artifact: null,
        });
        return textResult(response);
      }

      const result: SerialCaptureResult = stopped.value;
      const response = toolResponse(run, serial, {
        tool: "serial_capture",
        group: "read-only",
        ok: true,
        verification: stopped.verification,
        verdict: result.complete ? "SUCCESS" : "FAILURE",
        result,
        reason: result.reason,
        detail: `serial capture stopped; complete=${result.complete}; missed=${result.missed.length}`,
        artifact: null,
      });
      return textResult(response);
    },
  );

  server.registerTool(
    "run_record",
    {
      title: "Run record",
      description: withRules(
        "[read-only] Return the current run record: profile criteria, structured evidence, memory checks, doctor state and serial state. It is a log, not a permission to claim success.",
      ),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const result = {
        ...run.snapshot(),
        serial: serial.getStatus(),
      };
      const response = toolResponse(run, serial, {
        tool: "run_record",
        group: "read-only",
        ok: true,
        verification: mode === "simulated" ? "SIMULATED" : "REAL",
        verdict: "SUCCESS",
        result,
        reason: null,
        detail: "current MCP run record",
        artifact: run.artifact,
        record: false,
      });
      return textResult(response);
    },
  );

  server.registerTool(
    "build",
    {
      title: "Build",
      description: withRules(
        "[side-effects] Run the profile build command in the project directory. This may write build files. A missing toolchain is NOT_AVAILABLE, never a simulated success.",
      ),
      inputSchema: {
        cwd: z.string().optional().describe("project directory; defaults to the server project directory"),
      },
      annotations: EFFECT_ANNOTATIONS,
    },
    async ({ cwd }) => {
      const workdir = cwd ? resolvePath(projectDir, cwd) : projectDir;
      const built: ToolOutcome<ExecResult> =
        mode === "simulated"
          ? toolOk(simulatedExec("build"), "SIMULATED")
          : runBuild(profile, { cwd: workdir });

      if (!built.ok) {
        const verification = failureVerification(built.reason, mode);
        const response = toolResponse(run, serial, {
          tool: "build",
          group: "side-effects",
          ok: false,
          verification,
          verdict: failureVerdict(verification),
          result: null,
          reason: built.reason,
          detail: built.reason,
          artifact: null,
        });
        return textResult(response);
      }

      const result = built.value;
      const verdict = outcomeVerdict(result.exitCode);
      const response = toolResponse(run, serial, {
        tool: "build",
        group: "side-effects",
        ok: true,
        verification: built.verification,
        verdict,
        result,
        reason: verdict === "FAILURE" ? `build exited with ${result.exitCode}` : null,
        detail: `build exit ${result.exitCode ?? "unknown"}`,
        artifact: null,
      });
      return textResult(response);
    },
  );

  server.registerTool(
    "flash",
    {
      title: "Flash",
      description: withRules(
        "[side-effects] Write the ELF to the board. It is refused unless the current run record has memory_map_check SUCCESS for the exact same ELF SHA-256 and the latest doctor did not mark the target unreliable. A refusal explains what to do next.",
      ),
      inputSchema: {
        artifact: z.string().min(1).describe("ELF, or a .bin/.hex derived from a checked ELF"),
        source: z
          .string()
          .optional()
          .describe(
            "checked source ELF when flashing a .bin/.hex; the server must derive and verify the exact file",
          ),
      },
      annotations: FLASH_ANNOTATIONS,
    },
    async ({ artifact, source }) => {
      const artifactPath = resolvePath(projectDir, artifact);
      const sourcePath = source ? resolvePath(projectDir, source) : undefined;
      const gate = run.canFlash(artifactPath, sourcePath);
      if (!gate.ok) {
        const verification: Verification = gate.sha256 === null ? "NOT_AVAILABLE" : "REAL";
        const response = toolResponse(run, serial, {
          tool: "flash",
          group: "side-effects",
          ok: false,
          verification,
          verdict: failureVerdict(verification),
          result: null,
          reason: gate.reason,
          detail: gate.reason,
          artifact: artifactPath,
          sha256: gate.sha256,
        });
        return textResult(response);
      }

      const flashed: ToolOutcome<ExecResult> =
        mode === "simulated"
          ? toolOk(simulatedExec("flash"), "SIMULATED")
          : runFlash(profile, gate.flashPath, { cwd: projectDir });

      if (!flashed.ok) {
        const verification = failureVerification(flashed.reason, mode);
        const response = toolResponse(run, serial, {
          tool: "flash",
          group: "side-effects",
          ok: false,
          verification,
          verdict: failureVerdict(verification),
          result: null,
          reason: flashed.reason,
          detail: flashed.reason,
          artifact: artifactPath,
          sha256: gate.sha256,
        });
        return textResult(response);
      }

      const result = flashed.value;
      const verdict = outcomeVerdict(result.exitCode);
      if (verdict === "SUCCESS") serial.noteFlash();
      const response = toolResponse(run, serial, {
        tool: "flash",
        group: "side-effects",
        ok: true,
        verification: flashed.verification,
        verdict,
        result,
        reason: verdict === "FAILURE" ? `flash exited with ${result.exitCode}` : null,
        detail: `flash ${verdict.toLowerCase()} for sha256 ${gate.sha256}`,
        artifact: artifactPath,
        sha256: gate.sha256,
      });
      return textResult(response);
    },
  );

  server.registerTool(
    "debug",
    {
      title: "Debug (GDB batch, may write)",
      description: withRules(
        "[side-effects] Execute explicit GDB batch commands against the target. Commands may write registers or memory; a reset is noted on the serial session. Missing GDB is NOT_AVAILABLE, never an invented register value.",
      ),
      inputSchema: {
        commands: z
          .array(z.string().min(1))
          .min(1)
          .describe("GDB -ex commands; a reset/restart is noted on the serial session"),
      },
      annotations: DEBUG_ANNOTATIONS,
    },
    async ({ commands }) => {
      // The policy is part of `debug`, not of the real GDB adapter: a simulated
      // backend must not be a bypass for load/FLASH writes either.
      const policy = validateDebugCommands(profile, commands);
      if (!policy.ok) {
        const verification = failureVerification(policy.reason, mode);
        const response = toolResponse(run, serial, {
          tool: "debug",
          group: "side-effects",
          ok: false,
          verification,
          verdict: failureVerdict(verification),
          result: null,
          reason: policy.reason,
          detail: policy.reason,
          artifact: null,
        });
        return textResult(response);
      }

      const debugged: ToolOutcome<ExecResult> =
        mode === "simulated"
          ? toolOk(simulatedExec("gdb"), "SIMULATED")
          : runGdbBatch(profile, commands, { cwd: projectDir });

      if (!debugged.ok) {
        const verification = failureVerification(debugged.reason, mode);
        const response = toolResponse(run, serial, {
          tool: "debug",
          group: "side-effects",
          ok: false,
          verification,
          verdict: failureVerdict(verification),
          result: null,
          reason: debugged.reason,
          detail: debugged.reason,
          artifact: null,
        });
        return textResult(response);
      }

      const result = debugged.value;
      const verdict = outcomeVerdict(result.exitCode);
      if (verdict === "SUCCESS" && commands.some(isResetCommand)) serial.noteReset();
      const response = toolResponse(run, serial, {
        tool: "debug",
        group: "side-effects",
        ok: true,
        verification: debugged.verification,
        verdict,
        result,
        reason: verdict === "FAILURE" ? `gdb exited with ${result.exitCode}` : null,
        detail: `debug exit ${result.exitCode ?? "unknown"}`,
        artifact: null,
      });
      return textResult(response);
    },
  );

  server.registerTool(
    "target_test",
    {
      title: "On-target test",
      description: withRules(
        "[side-effects] Run the on-target test. Without a real test runner this is NOT_AVAILABLE, never passed=true; the result is evidence only when it really ran.",
      ),
      inputSchema: {
        criterion: z
          .string()
          .optional()
          .describe("profile criterion this test is evidence for"),
        artifact: z
          .string()
          .optional()
          .describe("firmware the on-target test loads; it must pass the same flash gate"),
        source: z
          .string()
          .optional()
          .describe("checked source ELF when artifact is a .bin/.hex"),
      },
      annotations: TARGET_TEST_ANNOTATIONS,
    },
    async ({ criterion, artifact, source }) => {
      let artifactPath: string | null = null;
      if (artifact) {
        artifactPath = resolvePath(projectDir, artifact);
        const gate = run.canFlash(
          artifactPath,
          source ? resolvePath(projectDir, source) : undefined,
        );
        if (!gate.ok) {
          const response = toolResponse(run, serial, {
            tool: "target_test",
            group: "side-effects",
            ok: false,
            verification: gate.sha256 === null ? "NOT_AVAILABLE" : "REAL",
            verdict: failureVerdict(gate.sha256 === null ? "NOT_AVAILABLE" : "REAL"),
            result: null,
            reason: gate.reason,
            detail: gate.reason,
            artifact: artifactPath,
            sha256: gate.sha256,
          });
          return textResult(response);
        }
      }

      const tested = await runTargetTest(
        mode === "simulated"
          ? async () => toolOk({ passed: true }, "SIMULATED")
          : null,
      );
      if (!tested.ok) {
        const verification = failureVerification(tested.reason, mode);
        const response = toolResponse(run, serial, {
          tool: "target_test",
          group: "side-effects",
          ok: false,
          verification,
          verdict: failureVerdict(verification),
          result: null,
          reason: tested.reason,
          detail: tested.reason,
          artifact: null,
        });
        return textResult(response);
      }

      const value = tested.value;
      const response = toolResponse(run, serial, {
        tool: "target_test",
        group: "side-effects",
        ok: true,
        verification: tested.verification,
        verdict: value.passed ? "SUCCESS" : "FAILURE",
        result: { ...value, criterion: criterion ?? null, artifact: artifactPath },
        reason: value.passed ? null : "the on-target test did not pass",
        detail: `on-target test ${value.passed ? "passed" : "failed"}${
          criterion ? `; criterion=${criterion}` : ""
        }`,
        artifact: null,
      });
      return textResult(response);
    },
  );

  return server;
}
