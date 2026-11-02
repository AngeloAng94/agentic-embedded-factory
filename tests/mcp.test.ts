import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadProfile } from "../core/profile";
import type { ProfileDoctorReport } from "../tools/doctor";
import { checkMemoryMap } from "../tools/memoryMap";
import { deriveFromElf } from "../tools/mcp/artifacts";
import { McpRunState } from "../tools/mcp/runState";
import { buildElf32, vectorBytes } from "./helpers/elfFixture";

const PROFILE_YAML = [
  "prodotto: DEMO-BOARD-MCP",
  "chip:",
  "  famiglia: stm32",
  "  regioni:",
  "    - { nome: FLASH, tipo: flash, origine: 0x08000000, dimensione: 65536 }",
  "    - { nome: RAM, tipo: ram, origine: 0x20000000, dimensione: 16384 }",
  'build: { sistema: cmake, toolchain: arm-none-eabi-gcc, comando: "cmake --build build" }',
  "flash: { tool: STM32_Programmer_CLI, interfaccia: swd }",
  "debug: { gdb_server: st, access_port: 0 }",
  "ancore: [APP]",
  "criteri:",
  '  - seriale_contiene: "BOOT OK"',
  "  - test_su_target: pass",
  "tentativi_max: 3",
].join("\n");

const profile = (() => {
  const result = loadProfile(PROFILE_YAML);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.profile;
})();

function elf(marker: number): Uint8Array {
  return buildElf32({
    entry: 0x0800_0201,
    sections: [
      {
        name: ".vectors",
        flags: 2,
        address: 0x0800_0000,
        loadAddress: 0x0800_0000,
        bytes: vectorBytes(0x2000_4000, 0x0800_0201),
      },
      {
        name: ".text",
        flags: 6,
        address: 0x0800_0200,
        loadAddress: 0x0800_0200,
        bytes: new Array<number>(16).fill(marker),
      },
      {
        name: ".data",
        flags: 3,
        address: 0x2000_0000,
        loadAddress: 0x0800_1000,
        bytes: [1, 2, 3, 4],
      },
    ],
  });
}

const dir = mkdtempSync(path.join(tmpdir(), "py-bench-mcp-test-"));
const profilePath = path.join(dir, "board.yaml");
const elfA = path.join(dir, "app-a.elf");
const elfB = path.join(dir, "app-b.elf");
const externalBin = path.join(dir, "external-b.bin");
writeFileSync(profilePath, PROFILE_YAML);
writeFileSync(elfA, elf(1));
writeFileSync(elfB, elf(2));
const derivedB = deriveFromElf(profile, elfB, "bin");
if (!derivedB.ok) throw new Error(derivedB.reason);
writeFileSync(externalBin, readFileSync(derivedB.value.artifact));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Structured = Record<string, unknown>;

interface Response extends Structured {
  ok: boolean;
  tool: string;
  group: string;
  verification: string;
  verdict: string;
  actor: string;
  actorId: string;
  evidence: unknown[];
  result: Structured | null;
  reason: string | null;
  runRecord: Structured;
  serial: Structured;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Response> {
  const result = await client.callTool({ name, arguments: args });
  const structured = result.structuredContent;
  if (!structured) throw new Error(`${name} returned no structuredContent`);
  return structured as unknown as Response;
}

function baseEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  env.PY_BENCH_MCP_PROFILE = profilePath;
  env.PY_BENCH_MCP_PROJECT_DIR = dir;
  return env;
}

function doctorReport(readsReliable: boolean): ProfileDoctorReport {
  const check = {
    id: "target.flash",
    label: "flash image",
    required: true,
    status: readsReliable ? "PASS" : "FAIL",
    detail: readsReliable ? "flash matches the ELF" : "flash differs from the ELF",
  } as const;
  return {
    profile: profile.prodotto,
    checks: [{ ...check }],
    target: {
      state: readsReliable ? "READY" : "NOT_READY",
      readsReliable,
      reason: readsReliable ? null : "flash differs from the ELF",
      checks: [{ ...check }],
    },
    state: "READY",
  };
}

describe("MCP run-state flash gate", () => {
  test("requires a successful memory_map_check for the exact SHA-256", () => {
    const run = new McpRunState(profile);
    expect(run.canFlash(elfA).ok).toBe(false);

    const checked = checkMemoryMap(profile, { artifactPath: elfA });
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.value.verdict).toBe("SUCCESS");
      run.recordMemoryMap(checked.value);
    }

    expect(run.canFlash(elfA).ok).toBe(true);
    const other = run.canFlash(elfB);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.reason).toContain("sha256");
  });

  test("a later failed check for the same ELF revokes the success", () => {
    const run = new McpRunState(profile);
    const checked = checkMemoryMap(profile, { artifactPath: elfA });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    run.recordMemoryMap(checked.value);
    run.recordMemoryMap({ ...checked.value, verdict: "FAILURE" });
    expect(run.canFlash(elfA).ok).toBe(false);
  });

  test("an unreliable doctor blocks flash until a later reliable doctor run", () => {
    const run = new McpRunState(profile);
    const checked = checkMemoryMap(profile, { artifactPath: elfA });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    run.recordMemoryMap(checked.value);

    run.recordDoctor(doctorReport(false));
    const blocked = run.canFlash(elfA);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain("doctor");

    run.recordDoctor(doctorReport(true));
    expect(run.canFlash(elfA).ok).toBe(true);
  });
});

describe("MCP stdio server", () => {
  test("lists both groups and every tool can be called with structured evidence", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", "mcp", "--simulate"],
      cwd: path.resolve(import.meta.dir, ".."),
      env: baseEnv(),
      stderr: "pipe",
    });
    const stderr = transport.stderr;
    let stderrText = "";
    stderr?.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString();
    });

    const client = new Client({ name: "py-bench-mcp-test", version: "0.1.0" });
    try {
      await client.connect(transport);

      const listed = await client.listTools();
      const tools = listed.tools;
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual(
        ["build", "debug", "doctor", "flash", "memory_map_check", "read_state", "run_record", "serial_capture", "target_test"].sort(),
      );

      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("Read-only group");
      expect(instructions).toContain("Side-effect group");
      expect(instructions).toContain("verify on the board before claiming");

      const readOnly = new Set([
        "doctor",
        "memory_map_check",
        "read_state",
        "serial_capture",
        "run_record",
      ]);
      for (const tool of tools) {
        expect(tool.description ?? "").toContain("verify on the board before claiming");
        expect(tool.description ?? "").toContain("read twice with the declared mode");
        expect(tool.description ?? "").toContain("check the memory map before flash");
        expect(tool.description ?? "").toContain(readOnly.has(tool.name) ? "[read-only]" : "[side-effects]");
        expect(tool.annotations?.readOnlyHint).toBe(readOnly.has(tool.name));
      }

      const responses: Response[] = [];

      const noCheck = await call(client, "flash", { artifact: elfA });
      responses.push(noCheck);
      expect(noCheck.ok).toBe(false);
      expect(noCheck.verdict).toBe("FAILURE");
      expect(String(noCheck.reason)).toContain("memory_map_check");

      const mapA = await call(client, "memory_map_check", { artifact: elfA });
      responses.push(mapA);
      expect(mapA.ok).toBe(true);
      expect(mapA.verdict).toBe("SUCCESS");
      expect((mapA.result as Structured).sha256).toMatch(/^[0-9a-f]{64}$/);

      const different = await call(client, "flash", { artifact: elfB });
      responses.push(different);
      expect(different.ok).toBe(false);
      expect(String(different.reason)).toContain("sha256");

      const doctor = await call(client, "doctor", {});
      responses.push(doctor);
      expect(doctor.ok).toBe(true);
      expect(doctor.verification).toBe("SIMULATED");
      expect(doctor.verdict).toBe("SUCCESS");

      const started = await call(client, "serial_capture", { action: "start" });
      responses.push(started);
      expect(started.ok).toBe(true);
      expect((started.result as Structured).state).toBe("running");

      const mapB = await call(client, "memory_map_check", { artifact: elfB });
      responses.push(mapB);
      expect(mapB.ok).toBe(true);
      expect(mapB.verdict).toBe("SUCCESS");

      const externalNoDerivation = await call(client, "flash", { artifact: externalBin });
      responses.push(externalNoDerivation);
      expect(externalNoDerivation.ok).toBe(false);
      expect(String(externalNoDerivation.reason)).toContain("externally");

      const targetNoGate = await call(client, "target_test", { artifact: externalBin });
      responses.push(targetNoGate);
      expect(targetNoGate.ok).toBe(false);
      expect(String(targetNoGate.reason)).toContain("externally");

      const flashed = await call(client, "flash", {
        artifact: externalBin,
        source: elfB,
      });
      responses.push(flashed);
      expect(flashed.ok).toBe(true);
      expect(flashed.verification).toBe("SIMULATED");
      expect(flashed.verdict).toBe("SUCCESS");
      expect((flashed.runRecord as Structured).derivations).toBeArray();

      const read = await call(client, "read_state", {
        mode: "stable",
        address: "0x20000000",
        length: 4,
        criterion: "serial-contains-1",
      });
      responses.push(read);
      expect(read.ok).toBe(true);
      expect((read.result as Structured).relation).toBe("equal");

      const build = await call(client, "build", {});
      responses.push(build);
      expect(build.ok).toBe(true);
      expect(build.verification).toBe("SIMULATED");
      expect(build.verdict).toBe("SUCCESS");

      const unsafeDebug = await call(client, "debug", { commands: ["load app.elf"] });
      responses.push(unsafeDebug);
      expect(unsafeDebug.ok).toBe(false);
      expect(String(unsafeDebug.reason)).toContain("flash");

      for (const commands of [
        ["set {int}0x08000000 = 1"],
        ["restore app.bin 0x08000000"],
        ["monitor program app.elf"],
      ]) {
        const refused = await call(client, "debug", { commands });
        responses.push(refused);
        expect(refused.ok).toBe(false);
        expect(String(refused.reason)).toContain("flash");
      }

      const debug = await call(client, "debug", { commands: ["monitor reset"] });
      responses.push(debug);
      expect(debug.ok).toBe(true);
      expect(debug.verification).toBe("SIMULATED");
      expect(debug.verdict).toBe("SUCCESS");

      const target = await call(client, "target_test", {
        criterion: "target-test-1",
        artifact: externalBin,
      });
      responses.push(target);
      expect(target.ok).toBe(true);
      expect((target.result as Structured).passed).toBe(true);
      expect((target.result as Structured).artifact).toBe(externalBin);

      const status = await call(client, "serial_capture", { action: "status" });
      responses.push(status);
      expect((status.result as Structured).state).toBe("running");
      expect(
        ((status.result as Structured).events as Array<{ kind: string }>).map((event) => event.kind),
      ).toEqual(["flash", "reset"]);

      const stopped = await call(client, "serial_capture", { action: "stop" });
      responses.push(stopped);
      expect(stopped.ok).toBe(true);
      expect((stopped.result as Structured).complete).toBe(true);
      expect((stopped.result as Structured).missed).toEqual([]);
      expect(String((stopped.result as Structured).text)).toContain("BOOT OK");

      const record = await call(client, "run_record", {});
      responses.push(record);
      expect(record.ok).toBe(true);
      expect((record.result as Structured).evidence).toBeArray();
      expect(((record.result as Structured).evidence as unknown[]).length).toBeGreaterThan(0);
      expect(((record.result as Structured).memoryMapChecks as unknown[]).length).toBe(2);
      expect((record.result as Structured).doctor).not.toBeNull();
      expect((record.result as Structured).serial).toMatchObject({ state: "stopped", complete: true });
      expect(((record.result as Structured).derivations as unknown[]).length).toBe(1);

      for (const response of responses) {
        expect(response.verification).toBe("SIMULATED");
        expect(response.verdict).toBeString();
        expect(response.actor).toBe("tool");
        expect(response.actorId).toBeString();
        expect(response.simulated).toBe(true);
        expect(response.runRecord).toBeObject();
        expect((response.runRecord as Structured).simulated).toBe(true);
        expect((response.runRecord as Structured).maxLevel).toBe("compiled");
        expect(response.evidence).toBeArray();
        for (const evidence of response.evidence as Array<Record<string, unknown>>) {
          expect(evidence.verification).toBe("SIMULATED");
        }
      }
      expect(stderrText).not.toContain("Error");
    } finally {
      await client.close();
    }
  }, 30_000);
});
