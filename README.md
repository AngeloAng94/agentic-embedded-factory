# EmbedFactory

Agentic workspace that turns a firmware requirement into a versioned project
skeleton, validated patches and **real** build evidence for Zephyr / FreeRTOS.

## The honesty rule

The product never claims that something was compiled, tested or verified when
that did not really happen. Every result carries two fields:

| Field            | Values                                        |
| ---------------- | --------------------------------------------- |
| `verification`   | `REAL` · `SIMULATED` · `NOT_AVAILABLE`        |
| `verdict`        | `SUCCESS` · `FAILURE` · `UNKNOWN`             |

- `SUCCESS` is only possible with `verification = REAL` **and** `exitCode = 0`
  (a runner answer that claims otherwise is downgraded to `UNKNOWN`).
- A missing toolchain produces `NOT_AVAILABLE · UNKNOWN` with
  `reason: toolchain unavailable: "west" is not installed or not in PATH`.
- A project becomes `verified` only after a real, successful build; otherwise it
  stays `unverified` (the legacy `ready` status is never written again).
- Rows created by the removed simulated engine are displayed as `LEGACY · UNVERIFIED`.

## Architecture

```
WEB (Vite + React + Convex)
  queries/mutations  → authorized data access (ownership enforced server-side)
  agent action       → server-side LLM + patch validation + build dispatch
  build job          → BUILD_RUNNER_URL → runner → real Zephyr/FreeRTOS toolchain
  export             → real ZIP built in the browser (files + README + manifest)

RUNNER (bun runner/index.ts)  ← the ONLY component that runs native toolchains
  build | git | analyze | export | serve
```

Convex cannot execute `west`/`cmake`, so the web app never fakes a build: without
a runner it reports `NOT_AVAILABLE` and the exported project can be built
locally. The desktop app (Electron) uses the same runner commands.

## Agent loop

```
user prompt → knowledge retrieval (logged) → LLM (server-side)
            → patches validated against current content (all-or-nothing)
            → real build → real compiler output
            → on failure: compiler stdout/stderr/exit code go back to the model
            → rebuild (max 3 attempts) → BUILD FAILED / REPAIR LIMIT REACHED
```

- Existing files are edited with **unified diffs**; a diff whose context does not
  match exactly is rejected with `PATCH_FAILED` and nothing is written.
- Every applied change is stored as an immutable version (`v1..vn`) with
  timestamp, author, reason, patch and build verdict; any version can be restored.
- If the provider is unreachable the turn fails explicitly: **no files created,
  no file modified, no build started**.

## Environment variables (server-side only)

| Variable                       | Purpose                                                   |
| ------------------------------ | --------------------------------------------------------- |
| `LLM_PROVIDER`                 | `ollama` (default) or `openai` (any OpenAI-compatible API) |
| `LLM_BASE_URL`                 | e.g. `http://localhost:11434` or `https://api.openai.com/v1` |
| `LLM_API_KEY`                  | required for remote OpenAI-compatible endpoints            |
| `LLM_MODEL`                    | model name (default `llama3` / `gpt-4o-mini`)              |
| `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `LLM_TEMPERATURE` | provider tuning          |
| `BUILD_RUNNER_URL`             | runner HTTP endpoint (`bun runner/index.ts serve`)         |
| `BUILD_RUNNER_TOKEN`           | shared secret for the runner                               |
| `EMBEDFACTORY_BUILD_COMMAND`   | force a specific build command (runner side)               |

Keys are read with `process.env` inside Convex node actions / the runner: they
are never sent to the browser.

## Development

```bash
bun install
bun convex dev --once      # push functions + regenerate types
bun tsc -b --noEmit        # typecheck
bun test                   # 59 tests: authz, patches, statuses, safety, runner, export
bun runner/index.ts build --dir ./project --rtos zephyr --board nucleo_l476rg --json
```

## Tests

`bun test` covers: cross-user authorization on every handler, path sandboxing,
unified-diff validation (`PATCH_FAILED`), LLM failure isolation, honest build
statuses, the repair loop and limit, real process execution (real compiler,
real exit codes, real artifacts), runner CLI contract, ZIP validity (verified
with Python's `zipfile`), knowledge retrieval budget and the safety rules.
