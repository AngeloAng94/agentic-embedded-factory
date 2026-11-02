# PY Bench Agent

An autonomous agent for microcontroller firmware: it writes code, **compiles it with
the real toolchain**, checks it against the chip, and reports only what a tool
actually measured. If it cannot prove something, it says so and leaves the
repository as it found it.

The product is not the generated code — models already write code. The product is
that the agent **cannot claim anything it has not measured**.

> **State: Phase 2 complete** (VCS boundary, run record, verification levels,
> validated product profile, block-scoped patching). The orchestrator, the CLI,
> the MCP server and the hardware tools do not exist yet; see
> [What is not here yet](#what-is-not-here-yet). Nothing in this README describes
> them as working.

## Non-negotiable rules

| Rule | Where it is enforced today |
| --- | --- |
| `SUCCESS` only with `verification = REAL` **and** `exitCode = 0` | `core/buildStatus.ts`, `core/buildDispatch.ts` (a runner claiming otherwise is downgraded to `UNKNOWN`) |
| Every result carries `verification` (`REAL`/`SIMULATED`/`NOT_AVAILABLE`) and `verdict` (`SUCCESS`/`FAILURE`/`UNKNOWN`) | `core/types.ts` |
| A project is `verified` only after a real successful build | `core/buildStatus.ts → projectStatusFor` |
| No build runner → `NOT_AVAILABLE`, never a simulated success | `core/buildDispatch.ts` |
| The model proposes; only validated patches reach the files, all-or-nothing | `agent/turn.ts` |
| Repair stops at 3 attempts, then the run fails and says so | `agent/repairLoop.ts` |
| The LLM answer never decides a verdict | `agent/repairLoop.ts` (verdicts come from the build result only) |
| Levels `written → compiled → flashed → observed → confirmed` come from evidence only, consecutive, and `confirmed` needs a human | `core/verificationLevels.ts` |
| A run record cannot store a level or a verdict: the schema rejects those fields | `core/runRecord.ts` |
| Existing files change only inside `// [AI_START_<block>]`, for blocks declared in the profile; one bad edit writes nothing | `core/blockPatch.ts`, `agent/turn.ts` |
| Every job works on its own branch and a failure discards it | `core/vcs.ts`, `tools/gitVcs.ts` |

Not yet implemented, and deliberately absent from the code: flashing, on-target
observation, memory-map checking, `ModelRuntime`, the CLI and MCP.

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
tools/         gitVcs.ts      real git implementation of VcsPort
               runner/        local HTTP runner (build / doctor / export / turn)
                              and Zephyr verification. Transitional: Phase 3/5
                              replace it with MCP tools invoked in-process.
agent/         turn.ts        one Convex-free turn: prompt → plan → validated writes
               repairLoop.ts  the loop: build → compiler error → patch → rebuild
profiles/      demo-board.yaml  fictional example (DEMO-BOARD-01, no real names)
tests/         151 tests, 3 skipped without a toolchain / without git opt-in
samples/       reference Zephyr project used by the verification tests
legacy/        frozen EmbedFactory v1 snapshot — excluded from build, lint, tests
```

`legacy/embedfactory-v1/` is a byte-for-byte copy of the previous product (Convex
backend, web workspace, desktop app) with a SHA-256 manifest. It is kept intact on
purpose: see [legacy/README.md](legacy/README.md).

## Commands

```bash
bun install
bun test                     # 103 pass, 1 skip (needs a real Zephyr toolchain)
bunx tsc -b --noEmit         # typecheck
bun run lint                 # eslint

bun run doctor               # real toolchain probe; reports MISSING, never invents
bun run runner:serve         # local build runner on 127.0.0.1:8790 (see tools/runner/README.md)

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

## Legacy snapshot and the `embedfactory-v1` tag

The tag could **not** be created here: git commands are blocked in this
environment. The snapshot directory plus `MANIFEST.sha256` is the substitute, and
`legacy/README.md` contains the exact commands to recreate a real tag on a machine
where git works. This is a known gap, not a completed step.

## What is not here yet

Phases 3–9 of the plan: STM32 tooling (flash, double `read_state`, GDB batch,
serial capture, `target_test`), memory map check, MCP server, `ModelRuntime`
orchestrator (Claude Agent SDK + the existing `core/llmClient.ts`), `py job` CLI,
demo.

The web workspace and the landing page were removed from the active tree on
purpose: this is a bench/CI tool now, not a web app. There is no dev server.
