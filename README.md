# PY Bench Agent

An autonomous agent for microcontroller firmware: it writes code, **compiles it with
the real toolchain**, checks it against the chip, and reports only what a tool
actually measured. If it cannot prove something, it says so and leaves the
repository as it found it.

The product is not the generated code — models already write code. The product is
that the agent **cannot claim anything it has not measured**.

> **State: Phase 6c complete** (the Phase 5 corrections, no implicit acceptance
> criterion, a `ModelRuntime` with the existing LLM client, Claude Agent SDK and
> an explicitly marked fake test double, and the end-to-end orchestrator). Phase
> 6d (branch/report/restore) does not exist yet; see
> [What is not here yet](#what-is-not-here-yet). Nothing in this README describes
> 6d as working.
>
> There is no board and no cross toolchain in the development environment: every
> real tool answers `NOT_AVAILABLE` with the reason, and the hardware test is
> skipped. The MCP integration test uses the explicit `--simulate` flag and never
> claims it ran on a board.

## Non-negotiable rules

| Rule | Where it is enforced today |
| --- | --- |
| `SUCCESS` only with `verification = REAL` **and** `exitCode = 0` | `core/buildStatus.ts`, `core/buildDispatch.ts` (a runner claiming otherwise is downgraded to `UNKNOWN`) |
| Every result carries `verification` (`REAL`/`SIMULATED`/`NOT_AVAILABLE`) and `verdict` (`SUCCESS`/`FAILURE`/`UNKNOWN`) | `core/types.ts` |
| A project is `verified` only after a real successful build | `core/buildStatus.ts → projectStatusFor` |
| No build runner → `NOT_AVAILABLE`, never a simulated success | `core/buildDispatch.ts` |
| No binary, no debugger, no serial helper → `NOT_AVAILABLE` with the reason | `tools/doctor.ts`, `tools/build.ts`, `tools/flash.ts`, `tools/debug.ts`, `tools/serialCapture.ts` |
| `read_state` declares its mode: `stable` needs identical reads, `progressing` needs movement in the declared direction | `tools/readState.ts` |
| A flash mismatch is a doctor FAIL and makes every later read unreliable (`read_state` refuses) | `tools/doctor.ts`, `tools/probe.ts`, `tools/readState.ts` |
| A busy probe or a blocked/unreachable core is a FAIL; unknown is `NOT_AVAILABLE` with the reason | `tools/doctor.ts` |
| Serial capture must start before flash/reset; a late capture is marked incomplete; `status` reports the session and missed events | `tools/serialCapture.ts`, `tools/mcp/server.ts` |
| `flash` refuses unless the current run record has a `memory_map_check` SUCCESS for the same ELF SHA-256 and the latest doctor did not mark the target unreliable | `tools/mcp/runState.ts`, `tools/mcp/server.ts` |
| `flash` accepts an ELF, or a `.bin`/`.hex` only when the tool derived it from a checked ELF; the run record stores `sha256 ELF → sha256 bin/hex`, and an external binary without that derivation is refused | `tools/mcp/artifacts.ts`, `tools/mcp/runState.ts`, `tools/mcp/server.ts` |
| A profile without acceptance criteria is valid: the run stops at `compiled`, the verdict stays `UNKNOWN`, and the reason is carried in the run report | `agent/repairLoop.ts`, `core/runRecord.ts`, `core/profile.ts` |
| The orchestrator uses the same build, `memory_map_check`, flash gate, flash, serial and on-target-test functions as the MCP server; it never reimplements a gate | `agent/orchestrator.ts`, `tools/build.ts`, `tools/memoryMap.ts`, `tools/mcp/runState.ts`, `tools/flash.ts`, `tools/serialCapture.ts`, `tools/targetTest.ts` |
| Every orchestrated run has a total-time and flash budget from the profile (`budget.tempo_totale_ms`, `budget.flash_max`), with prudent defaults; exceeding either stops the run and records why | `core/profile.ts`, `agent/orchestrator.ts` |
| The orchestrator starts serial capture before build/flash; an incomplete capture leaves serial criteria unevaluated (never failed) and cannot reach `observed` | `agent/orchestrator.ts`, `tools/serialCapture.ts`, `core/verificationLevels.ts` |
| Deterministic repair is also block-scoped: an include or layout fix outside `[AI_START_*]` is refused and handed to the model with the reason | `agent/deterministicRepair.ts`, `core/blockPatch.ts` |
| The run report ends with the acceptance-criterion → outcome table; there is no prose after it | `agent/runReport.ts`, `agent/orchestrator.ts` |
| The generation provider is selected by the profile; the fake runtime is a marked test double that requires an explicit opt-in and never falls back to a real provider | `core/profile.ts`, `agent/modelRuntime.ts`, `agent/turn.ts` |
| `debug` uses a GDB allowlist: breakpoints, halt/continue, RAM/register reads and writes, detach; `load`, `restore` into FLASH, programming monitors and OpenOCD/probe-rs flash commands are refused | `tools/debugPolicy.ts`, `tools/debug.ts`, `tools/mcp/server.ts` |
| `target_test` that loads firmware passes through the same flash gate as `flash` | `tools/mcp/server.ts`, `tools/mcp/runState.ts` |
| Every MCP response carries `verification`, `verdict`, `actor` and structured `evidence`; the read-only and side-effect groups are declared in the server instructions and annotations | `tools/mcp/server.ts` |
| `--simulate` forces `SIMULATED` on every response, marks the run record simulated, and caps the level at `compiled` | `tools/mcp/index.ts`, `tools/mcp/runState.ts`, `core/verificationLevels.ts` |
| Every allocated section's VMA is inside a declared region of the right type, and every section with file bytes and an LMA has its LMA inside FLASH; a section copied to RAM is valid whatever its flags | `tools/memoryMap.ts`, `core/elfImage.ts` |
| The Cortex-M vector table has an 8-byte-aligned initial SP in RAM (the inclusive region end is valid) and a Thumb reset handler in FLASH | `tools/memoryMap.ts` |
| `chip.vettori`, when present, is a hex address inside a declared FLASH region | `core/profile.ts`, `tools/memoryMap.ts` |
| `chip.regioni` is the only memory declaration; `flash_kb`/`ram_kb` are rejected with a migration error | `core/profile.ts` |
| A profile cannot choose a flash tool without its target or a Zephyr build without a board | `core/profile.ts` |
| The model proposes; only validated patches reach the files, all-or-nothing | `agent/turn.ts` |
| Repair stops at 3 attempts, then the run fails and says so | `agent/repairLoop.ts` |
| The LLM answer never decides a verdict | `agent/repairLoop.ts` (verdicts come from the build result only) |
| Levels `written → compiled → flashed → observed → confirmed` come from evidence only, consecutive, and `confirmed` needs a human | `core/verificationLevels.ts` |
| A run record cannot store a level or a verdict: the schema rejects those fields | `core/runRecord.ts` |
| Existing files change only inside `// [AI_START_<block>]`, for blocks declared in the profile; one bad edit writes nothing | `core/blockPatch.ts`, `agent/turn.ts` |
| Every job works on its own branch and a failure discards it | `core/vcs.ts`, `tools/gitVcs.ts` |
| The repair loop emits a validated `RunRecord` through `recordRun`; its level and status are derived from the evidence, never from the model or the build alone | `agent/repairLoop.ts`, `core/runRecord.ts` |
| A model answer is only a proposal: `runAgentTurn` passes it through the same validated-patch path regardless of whether the runtime is the LLM client, Claude Agent SDK or the fake double | `agent/turn.ts`, `agent/modelRuntime.ts` |

Not yet implemented, and deliberately absent from the code: branch/commit/restore
per run, `report.md`, `known_issues.yaml`, the CLI and the demo (Phase 6d and
later). The hardware tools are wired into the orchestrator but have never run on
a board in this environment.

## Layout

```
core/          types, verdicts, build engine + dispatch, LLM client (Ollama /
               OpenAI-compatible), path safety, doctor, artifact inspection,
               project export, static safety analysis
               vcs.ts               VcsPort + FAKE in-memory double
               verificationLevels.ts  written → … → confirmed, from evidence
               runRecord.ts         validated record; level/verdict are derived
               profile.ts           product profile parser + total validation
               blockPatch.ts        edits inside [AI_START_*] markers only
               toolResult.ts        REAL / SIMULATED / NOT_AVAILABLE outcomes
               elfImage.ts          ELF32/64 segments and sections, no readelf
tools/         exec.ts        argv execution (no shell) + PATH resolver
               doctor.ts      environment checks + flash/ELF, probe and core state
               probe.ts       GDB probe: busy, core state, flash dump
               build.ts       cmake (STM32) | zephyr-west (Zephyr) from the profile
               flash.ts       STM32_Programmer_CLI | openocd | probe-rs | west
               readState.ts   stable | progressing, declared by the caller
               debug.ts       GDB batch with explicit commands
               debugPolicy.ts allowlist for GDB commands; no FLASH writes
               serialCapture.ts  session started before flash/reset; detects late starts
               memoryMap.ts   region VMA/LMA checks, vector table, entry point, SHA-256
               targetTest.ts  on-target test port; NOT_AVAILABLE until wired
               gitVcs.ts      real git implementation of VcsPort
               mcp/           stdio MCP server, declared tool groups, run-state
                              flash gate, ELF → bin/hex derivation, structured
                              result envelopes and `--simulate`
               runner/        local HTTP runner (build / doctor / export / turn)
                              and Zephyr verification. The MCP surface is separate
                              and invoked over stdio.
agent/         turn.ts        one Convex-free turn: prompt → plan → validated writes
               modelRuntime.ts  provider boundary: llmClient, Claude Agent SDK,
                              explicit fake test double
               deterministicRepair.ts  parser ring for common GCC/linker errors;
                              every fix is still a blockPatch edit
               orchestrator.ts  serial start → build → map → flash → observe →
                              criteria → RunRecord/report, with budgets and
                              the same gates as the MCP server
               runReport.ts   report derived from evidence; criterion table last
               repairLoop.ts  the loop: build → compiler error → patch → rebuild;
                              emits the validated RunRecord through `recordRun`
profiles/      demo-board.yaml  fictional example (DEMO-BOARD-01, no real names)
tests/         322 tests: 312 pass, 10 skipped without a board / toolchain / git / Claude key
samples/       reference Zephyr project used by the verification tests
legacy/        frozen EmbedFactory v1 snapshot — excluded from build, lint, tests
```

`legacy/embedfactory-v1/` is a byte-for-byte copy of the previous product (Convex
backend, web workspace, desktop app) with a SHA-256 manifest. It is kept intact on
purpose: see [legacy/README.md](legacy/README.md).

## Requirements

Bun **>= 1.2.21**, the first release with `Bun.YAML`, used to parse profiles. The
minimum is pinned in `package.json` under `engines`. The MCP transport uses
`@modelcontextprotocol/sdk` and `zod`; the bench code under `core/`, `tools/` and
`agent/` otherwise imports only Bun and Node built-ins. `@anthropic-ai/claude-agent-sdk`
is the Claude runtime implementation and is imported lazily only when that
provider is selected; its API key is `ANTHROPIC_API_KEY` in the process that runs
the agent. The platform's `@vly-ai/integrations` scaffold remains available for
other integrations.

## Chip regions

`chip.regioni` is the only source of memory ranges. Each region has a `nome`, a
`tipo` (`flash` or `ram`), an `origine` hex address and a `dimensione` in bytes;
more than one region of type `ram` is allowed. The old `flash_kb`/`ram_kb` pair
is rejected with an explicit error that asks for the regions, never accepted as
a fallback.

`chip.vettori` is optional. It is the hex address of the Cortex-M vector table
for an application loaded behind a bootloader; when present, `memory_map_check`
reads the table there instead of at a named vector section or at the start of
FLASH. The address must lie in a declared FLASH region:

```yaml
chip:
  famiglia: stm32
  # optional: application vectors after a bootloader
  vettori: 0x08004000
  regioni:
    - { nome: FLASH, tipo: flash, origine: 0x08000000, dimensione: 2097152 }
    - { nome: RAM,   tipo: ram,   origine: 0x20000000, dimensione: 655360 }
```

## Commands

```bash
bun install
bun test                     # 312 pass, 10 skip (322 tests; board / toolchain / git / Claude key opt-in)
bunx tsc -b --noEmit         # typecheck
bun run lint                 # eslint

bun run mcp                  # stdio MCP server with the default profile
bun run doctor               # real toolchain probe; reports MISSING, never invents
bun run runner:serve         # local build runner on 127.0.0.1:8790 (see tools/runner/README.md)

# the real-board test, skipped without the opt-in and the four paths
PY_BENCH_ALLOW_REAL_HW=1 \
PY_BENCH_HW_PROFILE=profiles/demo-board.yaml \
PY_BENCH_HW_PROJECT=/path/to/firmware \
PY_BENCH_HW_ARTIFACT=/path/to/firmware/build/app.elf \
bun test tests/hw.real.test.ts

# a real ELF compiled by arm-none-eabi-gcc, skipped without the opt-in/toolchain
PY_BENCH_ALLOW_REAL_TOOLCHAIN=1 bun test tests/memoryMap.real.test.ts

# real git integration tests, skipped by default (the dev sandbox forbids git)
PY_BENCH_ALLOW_REAL_GIT=1 bun test tests/git.real.test.ts
```

The agent-loop tests start a **local HTTP server** (`Bun.serve` on 127.0.0.1, port 0)
that speaks the Ollama/OpenAI-compatible shape: no network, no Ollama installed,
deterministic. The only unreachable-provider case points at `127.0.0.1:1` on purpose.

The runner and MCP server need `west`/`cmake`/`arm-none-eabi-gcc` on the machine.
Without them every real build answer is `NOT_AVAILABLE · UNKNOWN` with the reason,
which is the intended behaviour.

## MCP server

`bun run mcp` starts a stdio MCP server. It reads a profile with `--profile` (or
`PY_BENCH_MCP_PROFILE`) and a project base directory with `--project-dir` (or
`PY_BENCH_MCP_PROJECT_DIR`). The project directory defaults to the current
working directory and the profile defaults to `profiles/demo-board.yaml` under it.
`--simulate` is the only simulation switch: it never comes from an environment
variable, and it is intended for demos and the MCP integration test.

The server declares two groups in its instructions and in every tool description:

- **read-only**: `doctor`, `memory_map_check`, `read_state`, `serial_capture`,
  `run_record`;
- **side effects** (board or project writes): `build`, `flash`, `debug`,
  `target_test`.

Every tool answer is a structured envelope with `verification`, `verdict`,
`actor`, `evidence`, the tool result and the current run record; text is a
summary, never the only result. The working rules are repeated in each tool
description: verify on the board before claiming, read twice with the declared
mode, and check the memory map before flash.

### The flash gate

`flash` does not trust the caller. It hashes the exact ELF being flashed and
requires a `memory_map_check` **SUCCESS** for the same SHA-256 in the current run
record. A check on a different build, or a check followed by a newer failure for
the same bytes, is refused with an explanation of what to run. If the latest
`doctor` reported `target.readsReliable = false`, flash is refused until a later
doctor run reports a reliable target. Only a successful flash records a `flash`
event on the serial session.

A `.bin` or `.hex` is accepted only when the tool derived it from a checked ELF:
`flash` writes a temporary image from the ELF's FLASH sections, compares its
SHA-256 with the supplied file, and records `sha256 ELF → sha256 bin/hex`. An
external image without a matching derivation is refused, and a byte mismatch is
refused too. `target_test` uses the same gate whenever it loads firmware.

### Debug without FLASH writes

`debug` first passes every command through `tools/debugPolicy.ts`. The allowlist
covers breakpoints, halt/continue, detach, reads, RAM writes and register writes.
`load`, `restore` with a FLASH address, programming `monitor` commands
(`program`, `flash write_image`, …) and OpenOCD/probe-rs flash commands are
refused with the reason before GDB is even looked up. Writes require an explicit
numeric RAM address: symbolic or arithmetic expressions that could resolve into
FLASH are refused.

### Serial session

`serial_capture` is one session per MCP server: `start`, `stop`, `status`.
Starting it before `flash` or a reset is supported and is the intended order;
`status` reports the events seen and whether the capture missed any. A late
start is still a real capture, but `complete` is false and `missed` names the
events that happened before it. Events that happen after `stop` are reported in
`afterStop` and also make `complete` false.

### MCP tests

The integration test launches `bun run mcp --simulate` through the official MCP
stdio client, lists all nine tools and calls every one at least once. The flag is
the explicit test-only double: every response is `SIMULATED`, every evidence
entry stays `SIMULATED`, and the flash test still passes through the same
SHA-256 gate. A normal run never selects this mode and never turns it into
`REAL`; the run record is marked simulated with `maxLevel = "compiled"`.

## How the loop reports

`agent/repairLoop.ts` has no database and no Convex dependency: persistence goes
through `RepairLoopPorts` (`applyWrites`, `record`, `onBuildRecorded`, `say`,
and the Phase 6 `recordRun`). It returns a `RepairLoopResult` whose `status` is
one of `ANSWER_ONLY`, `CHANGES_APPLIED`, `SUCCESS`, `BUILD_NOT_AVAILABLE`, or a
failure code such as `PATCH_FAILED`, `REPAIR_LIMIT_REACHED`,
`TIME_BUDGET_EXHAUSTED`.

Every outcome also carries `runRecord`: `{ record, level, status, simulated,
reason }`, where `record` is the validated `RunRecord` with the profile name,
request, criteria, applied changes, model transcript and structured evidence.
The loop records `written` evidence only after `applyWrites` persisted the
files, and `compiled` evidence only from the final build result; evidence from a
simulated run is `SIMULATED`. `recordRun` receives the record plus the level and
status derived from it. The stored record contains no level or verdict:
`validateRunRecord` rejects those fields. The adapter that stores project state
still derives it from the recorded build (`isVerifiedSuccess` /
`projectStatusFor`), never from the model's prose.

There is no implicit `build` criterion. A request/profile with no criteria
produces an empty criteria list; the record can reach at most `compiled`, the
status is `UNKNOWN`, and `reason` states that no criterion was evaluated on the
target. `reason` is derived from the record by `runRecordReason`, not written by
the model.

## The orchestrated run

`agent/orchestrator.ts` runs the complete sequence for a profile:

```
serial start → build → memory_map_check → canFlash gate → flash → serial stop
             → acceptance criteria → RunRecord → report
```

Build failures first go to `agent/deterministicRepair.ts`, which recognizes the
common GCC/linker errors. An undefined symbol gets a stub **inside a declared
block**, through `applyBlockEdits`; a missing include, region overflow or type
clash is refused with the reason and handed to `runAgentTurn` together with the
real compiler output and any exact-text known-issue hints. A deterministic fix
that would require an edit outside the markers is never applied.

The serial session is started before the build and flash. If `stop()` reports
`complete: false` because a flash/reset happened first, the orchestrator records
the serial criteria as unevaluated (`NOT_AVAILABLE`/`UNKNOWN`, not failed) and
`observed` is unreachable. The report's last line is always the criterion table:

```
| Criterio di accettazione | Esito |
| --- | --- |
| serial output contains "BOOT OK" (`seriale_contiene[0]`) | PASS |
```

Every run reads `budget.tempo_totale_ms` and `budget.flash_max` from the profile;
when absent, the parser defaults to 8 minutes and 2 flashes. A budget stop is
written into the run record's `reason`. `RunRecord` still stores no level or
verdict: `level` and `status` are derived from the evidence.

## Model runtime and profile selection

`agent/modelRuntime.ts` is the provider boundary used by `agent/turn.ts`:

- `llmClient` (default): the existing Ollama / OpenAI-compatible client;
- `claude-agent-sdk`: one tool-free Claude Agent SDK turn, imported lazily;
- `fake`: a test double, marked `fake: true` and `simulated: true`.

The profile selects it, independently of the board facts:

```yaml
llm:
  provider: llmClient   # llmClient | claude-agent-sdk | fake
  model: llama3         # optional
```

`fake` is never a fallback. `createModelRuntime` refuses it without
`allowFake: true`, and tests that need a scripted answer pass it explicitly. A
fake answer still goes through the same validated-patch gate before any file is
written.

`ANTHROPIC_API_KEY` is required only when `claude-agent-sdk` is selected. The
optional Agent SDK test is skipped when the key is absent; the adapter's
missing-key path fails before importing or spawning the SDK.

## Target checks and capture order

`read_state` has no default mode. `stable` is for a halted core or configuration
registers (two identical reads); `progressing` is for a counter that proves the
core executes and requires `direction: "increasing" | "decreasing"`. A stable
read that moves, a progressing read that does not move, and movement in the
wrong direction are all failures.

The doctor compares the flash with the expected ELF through GDB, reports whether
the probe is busy and whether the core is running, halted, blocked or
unreachable, and sets `target.readsReliable`. A flash mismatch marks later
readings unreliable; `read_state` accepts that flag and refuses to report them.
Without gdb or hardware every target check is `NOT_AVAILABLE` with the reason.

The serial session must be started **before** flash or reset. `stop()` reports
`complete: false` and lists the missed events when a flash/reset happened before
the capture started, because the boot banner may contain the acceptance criteria.

`memory_map_check` checks addresses, not just sizes: every allocated section's
VMA must end inside a region of the expected type, and every section with file
bytes and an LMA must load from FLASH. A section with its LMA in FLASH and its
VMA in RAM is copied to RAM and is valid whatever its flags; this covers
`.ramfunc` (executable, not writable) as well as `.data`. The Cortex-M vector
words are read from `chip.vettori` when configured, otherwise from the
`.isr_vector` (`.vectors`) section or from the start of the lowest FLASH region.
The initial SP must be in RAM and 8-byte aligned; the inclusive end of a RAM
region is a valid stack top, one byte past it is not. The reset handler must be
in FLASH with bit 0 set. The ELF entry point is a secondary executable-section
check. The report carries the SHA-256 of the exact bytes that were parsed; the
MCP `flash` gate compares it with the ELF it is about to write.

## Legacy snapshot and the `embedfactory-v1` tag

The tag could **not** be created here: git commands are blocked in this
environment. The snapshot directory plus `MANIFEST.sha256` is the substitute, and
`legacy/README.md` contains the exact commands to recreate a real tag on a machine
where git works. This is a known gap, not a completed step.

## What is not here yet

Phase 6d (one VCS branch per run, one commit per attempt, restore on failure,
`report.md` and `known_issues.yaml`) does not exist yet. The hardware tools are
wired into the orchestrator, but none of them has run against a real board here.
The MCP run record remains session-scoped; it is not the persistent store for
repair-loop records. Phases 7–9 (the `py job` CLI and demo) are also absent.

`memory_map_check` reports per-region usage only after the VMA/LMA checks; a
stripped ELF with no section headers is `NOT_AVAILABLE`, not a guess from the
file size. The optional real-toolchain test compiles a minimal firmware with
`arm-none-eabi-gcc`; it is skipped here because that compiler is not installed.

The web workspace and the landing page were removed from the active tree on
purpose: this is a bench/CI tool now, not a web app. There is no dev server.
