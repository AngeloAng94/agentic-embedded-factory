# PY Bench Agent

An autonomous agent for microcontroller firmware: it writes code, **compiles it with
the real toolchain**, checks it against the chip, and reports only what a tool
actually measured. If it cannot prove something, it says so and leaves the
repository as it found it.

The product is not the generated code — models already write code. The product is
that the agent **cannot claim anything it has not measured**.

> **State: Phase 1 complete** (structure and honesty-preserving extraction).
> The CLI, the MCP server, flashing and the profile format do not exist yet; see
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

Not yet implemented, and deliberately absent from the code: flashing, on-target
observation, memory-map checking, block-scoped patching, `ModelRuntime`.

## Layout

```
core/          types, verdicts, build engine + dispatch, LLM client (Ollama /
               OpenAI-compatible), unified diff + path safety, doctor, artifact
               inspection, project export, static safety analysis
agent/         turn.ts        one Convex-free turn: prompt → plan → validated writes
               repairLoop.ts  the loop: build → compiler error → patch → rebuild
tools/runner/  local HTTP runner (build / doctor / export / turn) and Zephyr
               end-to-end verification. Transitional: Phase 3/5 replace it with
               MCP tools invoked in-process.
tests/         104 tests, 1 gated on a real Zephyr toolchain
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
```

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

Phases 2–9 of the plan: validated run record, `profiles/py.yaml`, block-scoped
patching (`// [AI_START_…]`), STM32 tooling (flash, double `read_state`, GDB batch,
serial capture, `target_test`), memory map check, MCP server, `ModelRuntime`
orchestrator (Claude Agent SDK + the existing `core/llmClient.ts`), `py job` CLI,
demo.

The web workspace and the landing page were removed from the active tree on
purpose: this is a bench/CI tool now, not a web app. There is no dev server.
