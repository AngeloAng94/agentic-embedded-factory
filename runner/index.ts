#!/usr/bin/env bun
/**
 * EmbedFactory local runner — the only component that executes native
 * toolchains.
 *
 *   bun runner/index.ts build   --dir <projectDir> [--rtos zephyr] [--board b] [--command "west build ..."] [--json]
 *   bun runner/index.ts build   --files <files.json> [--json]
 *   bun runner/index.ts git     --dir <projectDir> [--message "..."] [--json]
 *   bun runner/index.ts analyze --dir <projectDir> [--json]
 *   bun runner/index.ts export  --files <files.json> --out <dir> [--json]
 *   bun runner/index.ts serve   [--port 8790] [--token <secret>] [--workdir <dir>]
 *
 * Every build result comes from a real process: real stdout, real stderr, real
 * exit code. When a toolchain is missing the answer is NOT_AVAILABLE — this
 * runner never fabricates a success.
 */

import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  gitInitCommit,
  resolveExecutable,
  runProjectBuild,
} from "../src/lib/core/buildEngine";
import { analyzeProject } from "../src/lib/core/safety";
import { isPathAllowed } from "../src/lib/core/pathSafety";
import { buildExportEntries } from "../src/lib/core/projectExport";
import { detectRtos } from "../src/lib/core/rtos";
import { runAgentTurn, type TurnFile, type TurnWrite } from "./lib/turn";

interface RunnerFile {
  path: string;
  content: string;
}

interface BuildRequest {
  projectName?: string;
  rtos?: string;
  board?: string | null;
  command?: string | null;
  files?: RunnerFile[];
  timeoutMs?: number;
  attempt?: number;
}

function parseArgs(argv: string[]): { command: string; flags: Record<string, string>; rest: string[] } {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(token);
    }
  }
  return { command, flags, rest: positional };
}

export function materialize(
  files: RunnerFile[],
  dir: string,
): { written: string[]; rejected: string[] } {
  const written: string[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    if (!isPathAllowed(file.path)) {
      rejected.push(file.path);
      continue;
    }
    const target = path.join(dir, file.path);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
      rejected.push(file.path);
      continue;
    }
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, file.content, "utf8");
    written.push(file.path);
  }
  return { written, rejected };
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function projectDirFromFlags(flags: Record<string, string>): { dir: string; temporary: boolean } {
  if (flags.dir) return { dir: path.resolve(flags.dir), temporary: false };
  const dir = mkdtempSync(path.join(tmpdir(), "embedfactory-"));
  return { dir, temporary: true };
}

function loadFiles(flags: Record<string, string>): RunnerFile[] {
  if (!flags.files) return [];
  const parsed = readJson(flags.files);
  if (!Array.isArray(parsed)) throw new Error("--files must point to a JSON array");
  return parsed
    .filter((entry): entry is RunnerFile =>
      Boolean(entry) && typeof entry.path === "string" && typeof entry.content === "string",
    )
    .map((entry) => ({ path: entry.path, content: entry.content }));
}

export function applyWrites(files: TurnFile[], writes: TurnWrite[]): TurnFile[] {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  for (const write of writes) byPath.set(write.path, write.content);
  return [...byPath.entries()].map(([filePath, content]) => ({ path: filePath, content }));
}

function emit(payload: unknown, json: boolean, humanLines: string[] = []): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${humanLines.join("\n")}\n`);
}

async function buildFromRequest(request: BuildRequest) {
  let dir: string;
  let temporary = false;
  let rejected: string[] = [];

  if (request.files && request.files.length > 0) {
    dir = mkdtempSync(path.join(tmpdir(), "embedfactory-"));
    temporary = true;
    rejected = materialize(request.files, dir).rejected;
  } else {
    throw new Error("build requires files (or --dir on the CLI)");
  }

  const rtos =
    request.rtos === "zephyr" || request.rtos === "freertos"
      ? request.rtos
      : (detectRtos(request.files.map((file) => file.path + " " + file.content).join(" ")) ??
        "zephyr");

  try {
    const result = await runProjectBuild({
      dir,
      rtos,
      board: request.board ?? null,
      commandOverride: request.command ?? process.env.EMBEDFACTORY_BUILD_COMMAND ?? null,
      timeoutMs: request.timeoutMs,
      attempt: request.attempt ?? 1,
    });
    return { ...result, rejectedPaths: rejected };
  } finally {
    if (temporary) rmSync(dir, { recursive: true, force: true });
  }
}

async function serve(flags: Record<string, string>): Promise<void> {
  const port = Number(flags.port ?? 8790);
  const token = flags.token ?? process.env.BUILD_RUNNER_TOKEN ?? null;
  const workRoot = flags.workdir ? path.resolve(flags.workdir) : null;
  if (workRoot) mkdirSync(workRoot, { recursive: true });

  const server = createServer((req, res) => {
    const respond = (status: number, payload: unknown) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    };

    if (req.method === "GET" && req.url === "/health") {
      respond(200, {
        ok: true,
        runner: "embedfactory",
        tools: {
          west: Boolean(resolveExecutable("west")),
          cmake: Boolean(resolveExecutable("cmake")),
          make: Boolean(resolveExecutable("make")),
          cc: Boolean(resolveExecutable("cc")) || Boolean(resolveExecutable("gcc")),
          git: Boolean(resolveExecutable("git")),
        },
      });
      return;
    }

    if (req.method !== "POST") {
      respond(405, { ok: false, message: "only POST is supported" });
      return;
    }

    if (token && req.headers.authorization !== `Bearer ${token}`) {
      respond(401, { ok: false, message: "invalid runner token" });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        respond(413, { ok: false, message: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", async () => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        respond(400, { ok: false, message: "invalid JSON body" });
        return;
      }

      try {
        if (req.url === "/build") {
          const result = await buildFromRequest(payload as BuildRequest);
          respond(200, result);
          return;
        }

        if (req.url === "/git") {
          const files = (payload.files as RunnerFile[] | undefined) ?? [];
          const dir = mkdtempSync(path.join(tmpdir(), "embedfactory-git-"));
          try {
            materialize(files, dir);
            const outcome = await gitInitCommit(
              dir,
              typeof payload.message === "string"
                ? payload.message
                : "Initial commit from EmbedFactory",
            );
            respond(200, outcome);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
          return;
        }

        if (req.url === "/export") {
          const files = (payload.files as RunnerFile[] | undefined) ?? [];
          const outDir = path.resolve(
            typeof payload.outDir === "string" && payload.outDir !== ""
              ? payload.outDir
              : path.join(workRoot ?? process.cwd(), String(payload.projectName ?? "project")),
          );
          const { entries, manifest } = buildExportEntries(
            {
              name: String(payload.projectName ?? "project"),
              rtos: payload.rtos === "freertos" ? "freertos" : "zephyr",
              board: (payload.board as string | null) ?? null,
              mcu: null,
            },
            files,
          );
          const written = materialize(
            entries.map((entry) => ({ path: entry.path, content: entry.content })),
            outDir,
          );
          respond(200, { ok: true, outDir, written: written.written.length, manifest });
          return;
        }

        if (req.url === "/analyze") {
          const files = (payload.files as RunnerFile[] | undefined) ?? [];
          const rtos = typeof payload.rtos === "string" ? payload.rtos : "zephyr";
          respond(200, analyzeProject(files, rtos));
          return;
        }

        respond(404, { ok: false, message: `unknown endpoint ${req.url}` });
      } catch (error) {
        respond(500, {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });

  server.listen(port, () => {
    process.stdout.write(
      `EmbedFactory runner listening on http://127.0.0.1:${port} (token ${
        token ? "required" : "not set"
      })\n`,
    );
  });
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const json = flags.json === "true";

  switch (command) {
    case "build": {
      const { dir, temporary } = projectDirFromFlags(flags);
      try {
        const fromFiles = loadFiles(flags);
        if (fromFiles.length > 0) materialize(fromFiles, dir);
        const rtos = flags.rtos === "freertos" ? "freertos" : "zephyr";
        const result = await runProjectBuild({
          dir,
          rtos,
          board: flags.board ?? null,
          commandOverride: flags.command ?? process.env.EMBEDFACTORY_BUILD_COMMAND ?? null,
          attempt: 1,
        });
        emit(result, json, [
          `verification=${result.verification} verdict=${result.verdict} exit=${
            result.exitCode ?? "n/a"
          }`,
          result.stdout.trim(),
          result.stderr.trim(),
        ]);
        process.exitCode = result.verdict === "SUCCESS" && result.verification === "REAL" ? 0 : 1;
      } finally {
        if (temporary) rmSync(dir, { recursive: true, force: true });
      }
      return;
    }

    case "git": {
      const { dir, temporary } = projectDirFromFlags(flags);
      try {
        const fromFiles = loadFiles(flags);
        if (fromFiles.length > 0) materialize(fromFiles, dir);
        const outcome = await gitInitCommit(
          dir,
          flags.message ?? "Initial commit from EmbedFactory",
        );
        emit(outcome, json, [
          outcome.ok ? "git ok" : `git failed: ${outcome.message}`,
          ...outcome.steps.map((step) => `${step.command} → exit ${step.exitCode}`),
        ]);
        process.exitCode = outcome.ok ? 0 : 1;
      } finally {
        if (temporary) rmSync(dir, { recursive: true, force: true });
      }
      return;
    }

    case "analyze": {
      const { dir, temporary } = projectDirFromFlags(flags);
      try {
        const fromFiles = loadFiles(flags);
        if (fromFiles.length > 0) materialize(fromFiles, dir);
        const files = fromFiles.length > 0 ? fromFiles : [];
        const report = analyzeProject(files, flags.rtos ?? "zephyr");
        emit(report, json, [
          `${report.summary.pass} PASS / ${report.summary.warning} WARNING / ${report.summary.fail} FAIL`,
          ...report.findings.map(
            (finding) =>
              `[${finding.status}] ${finding.rule} ${finding.file}${
                finding.line === null ? "" : `:${finding.line}`
              } — ${finding.explanation}`,
          ),
        ]);
      } finally {
        if (temporary) rmSync(dir, { recursive: true, force: true });
      }
      return;
    }

    case "turn": {
      const files = loadFiles(flags);
      const knowledgeRaw = flags.knowledge ? readJson(flags.knowledge) : [];
      const outcome = await runAgentTurn({
        projectName: flags.name ?? "project",
        rtos: flags.rtos ?? "zephyr",
        board: flags.board ?? null,
        mcu: flags.mcu ?? null,
        userMessage: flags.request ?? "",
        files,
        knowledge: Array.isArray(knowledgeRaw) ? (knowledgeRaw as never) : [],
      });

      let build: Awaited<ReturnType<typeof runProjectBuild>> | null = null;
      if (outcome.ok && outcome.requestBuild && flags.build === "true") {
        const dir = mkdtempSync(path.join(tmpdir(), "embedfactory-turn-"));
        try {
          materialize(applyWrites(files, outcome.writes), dir);
          build = await runProjectBuild({
            dir,
            rtos: flags.rtos === "freertos" ? "freertos" : "zephyr",
            board: flags.board ?? null,
            commandOverride: flags.command ?? process.env.EMBEDFACTORY_BUILD_COMMAND ?? null,
          });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }

      const payload = { ...outcome, build };
      emit(payload, json, [
        outcome.ok
          ? `status=${outcome.status} writes=${outcome.writes.length} (${outcome.writes
              .map((write) => `${write.path} ${write.kind}`)
              .join(", ") || "none"})`
          : `error=${outcome.code}: ${outcome.message}`,
        outcome.ok ? outcome.knowledgeLog : "",
        build ? `build: ${build.verification} · ${build.verdict}` : "",
      ]);
      process.exitCode = outcome.ok && (!build || build.verdict !== "FAILURE") ? 0 : 1;
      return;
    }

    case "export": {
      const out = flags.out;
      if (!out) throw new Error("export requires --out <directory>");
      const files = loadFiles(flags);
      const { entries, manifest } = buildExportEntries(
        {
          name: flags.name ?? "project",
          rtos: flags.rtos === "freertos" ? "freertos" : "zephyr",
          board: flags.board ?? null,
          mcu: null,
        },
        files,
      );
      const written = materialize(
        entries.map((entry) => ({ path: entry.path, content: entry.content })),
        path.resolve(out),
      );
      emit({ ok: true, outDir: path.resolve(out), ...written, manifest }, json, [
        `wrote ${written.written.length} file(s) to ${path.resolve(out)}`,
      ]);
      return;
    }

    case "serve":
      await serve(flags);
      return;

    default: {
      process.stdout.write(
        [
          "EmbedFactory runner",
          "",
          "  build   --dir <dir> | --files <files.json> [--rtos zephyr|freertos] [--board <b>] [--command \"...\"] [--json]",
          "  turn    --files <files.json> --request \"...\" [--knowledge <kb.json>] [--build] [--json]",
          "  git     --dir <dir> | --files <files.json> [--message \"...\"] [--json]",
          "  analyze --files <files.json> [--rtos zephyr|freertos] [--json]",
          "  export  --files <files.json> --out <dir> [--json]",
          "  serve   [--port 8790] [--token <secret>]",
          "",
          "A build is only reported as SUCCESS when a real process exits 0.",
          "",
        ].join("\n"),
      );
      return;
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  });
}

export { buildFromRequest, materialize as materializeProjectFiles };
