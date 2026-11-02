#!/usr/bin/env bun
/**
 * `bun run mcp`: stdio MCP server.
 *
 * Configuration:
 *   --profile <path>       profile YAML (default: PY_BENCH_MCP_PROFILE or profiles/demo-board.yaml)
 *   --project-dir <path>   base directory for relative tool paths
 *
 * The test double is selected only by PY_BENCH_MCP_SIMULATE=1. It is explicit
 * and every result stays SIMULATED; normal runs never use it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadProfile } from "../../core/profile";
import { createPyBenchMcpServer, type McpMode } from "./server";

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const projectDir =
    flagValue(argv, "--project-dir") ??
    process.env.PY_BENCH_MCP_PROJECT_DIR ??
    process.cwd();
  const profilePath =
    flagValue(argv, "--profile") ??
    process.env.PY_BENCH_MCP_PROFILE ??
    path.resolve(projectDir, "profiles/demo-board.yaml");
  const mode: McpMode = process.env.PY_BENCH_MCP_SIMULATE === "1" ? "simulated" : "real";

  let text: string;
  try {
    text = readFileSync(profilePath, "utf8");
  } catch (error) {
    process.stderr.write(
      `py-bench mcp: cannot read profile ${profilePath}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 2;
    return;
  }

  const loaded = loadProfile(text);
  if (!loaded.ok) {
    process.stderr.write(`py-bench mcp: invalid profile ${profilePath}:\n${loaded.errors.join("\n")}\n`);
    process.exitCode = 2;
    return;
  }

  const server = createPyBenchMcpServer({
    profile: loaded.profile,
    mode,
    projectDir,
  });
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  });
}
