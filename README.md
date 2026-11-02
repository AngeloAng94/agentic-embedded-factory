# PY Bench Agent

An autonomous agent for microcontroller firmware: it writes code, **compiles it with
the real toolchain**, checks it against the chip, and reports only what a tool
actually measured. If it cannot prove something, it says so and leaves the
repository as it found it.

The product is not the generated code — models already write code. The product is
that the agent **cannot claim anything it has not measured**.

> **State: Phase 4 complete** (native tools: profile doctor with target checks,
> build, flash, `read_state` with declared mode, GDB batch, serial capture
> session, on-target test, region-based `memory_map_check` with Cortex-M vector
> checks; CMake and Zephyr `west` build adapters). The orchestrator, the CLI, the
> MCP server and the demo do not exist yet; see
> [What is not here yet](#what-is-not-here-yet). Nothing in this README
> describes them as working.
>
> There is no board and no cross toolchain in the development environment: every
> real tool answers `NOT_AVAILABLE` with the reason, and the hardware test is
> skipped. That path is tested; the real one is not. Run it with a board using
> the command below.

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
| Serial capture must start before flash/reset; a late capture is marked incomplete | `tools/serialCapture.ts` |
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

Not yet implemented, and deliberately absent from the code: on-target observation
wired into the loop, `ModelRuntime`, the CLI, MCP and the demo. The hardware
tools exist but have never run on a board in this environment.

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
               serialCapture.ts  session started before flash/reset; detects late starts
               memoryMap.ts   region VMA/LMA checks, vector table, entry point
               targetTest.ts  on-target test port; NOT_AVAILABLE until wired
               gitVcs.ts      real git implementation of VcsPort
               runner/        local HTTP runner (build / doctor / export / turn)
                              and Zephyr verification. Transitional: Phase 5
                              replaces it with MCP tools invoked in-process.
agent/         turn.ts        one Convex-free turn: prompt → plan → validated writes
               repairLoop.ts  the loop: build → compiler error → patch → rebuild
profiles/      demo-board.yaml  fictional example (DEMO-BOARD-01, no real names)
tests/         261 tests, 9 skipped without a board / toolchain / git opt-in
samples/       reference Zephyr project used by the verification tests
legacy/        frozen EmbedFactory v1 snapshot — excluded from build, lint, tests
```

`legacy/embedfactory-v1/` is a byte-for-byte copy of the previous product (Convex
backend, web workspace, desktop app) with a SHA-256 manifest. It is kept intact on
purpose: see [legacy/README.md](legacy/README.md).

## Requirements

Bun **>= 1.2.21**, the first release with `Bun.YAML`, used to parse profiles. The
minimum is pinned in `package.json` under `engines`. Everything else is a dev
dependency except the platform's `@vly-ai/integrations` scaffold: the bench code
under `core/`, `tools/` and `agent/` imports only Bun and Node built-ins.

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
bun test                     # 252 pass, 9 skip (board / toolchain / git opt-in)
bunx tsc -b --noEmit         # typecheck
bun run lint                 # eslint

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

The runner needs `west`/`cmake`/`arm-none-eabi-gcc` on the machine. Without them
every build answer is `NOT_AVAILABLE · UNKNOWN` with the reason, which is the
intended behaviour.

## How the loop reports

`agent/repairLoop.ts` has no database and no Convex dependency: persistence goes
through `RepairLoopPorts` (`applyWrites`, `record`, `onBuildRecorded`, `say`).
It returns a `RepairLoopResult` whose `status` is one of `ANSWER_ONLY`,
`CHANGES_APPLIED`, `SUCCESS`, `BUILD_NOT_AVAILABLE`, or a failure code such as
`PATCH_FAILED`, `REPAIR_LIMIT_REACHED`, `TIME_BUDGET_EXHAUSTED`.

The adapter that stores runs must derive project state from the recorded build
(`isVerifiedSuccess` / `projectStatusFor`), never from the model's prose. That
contract is what Phase 2 turns into a validated run record.

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
check.

## Legacy snapshot and the `embedfactory-v1` tag

The tag could **not** be created here: git commands are blocked in this
environment. The snapshot directory plus `MANIFEST.sha256` is the substitute, and
`legacy/README.md` contains the exact commands to recreate a real tag on a machine
where git works. This is a known gap, not a completed step.

## What is not here yet

Phases 5–9 of the plan: MCP server, `ModelRuntime` orchestrator (Claude Agent
SDK + the existing `core/llmClient.ts`), `py job` CLI, demo. The tools are not
wired into the repair loop yet: the loop still emits no `RunRecord` (that is
Phase 6), and none of the hardware tools has run against a real board here.

`memory_map_check` reports per-region usage only after the VMA/LMA checks; a
stripped ELF with no section headers is `NOT_AVAILABLE`, not a guess from the
file size. The optional real-toolchain test compiles a minimal firmware with
`arm-none-eabi-gcc`; it is skipped here because that compiler is not installed.

The web workspace and the landing page were removed from the active tree on
purpose: this is a bench/CI tool now, not a web app. There is no dev server.
