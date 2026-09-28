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
  doctor | verify | build | git | analyze | export | serve
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

## Real Zephyr toolchain (the vertical slice)

The engine is proven against a **real** toolchain on the machine that owns one.
Nothing in this repository simulates a Zephyr build.

### 1. Install prerequisites

- `west`, `cmake`, `ninja`, `python3`, `dtc` (`sudo apt install cmake ninja-build
  device-tree-compiler python3-dev` + `pipx install west`)
- the **Zephyr SDK** (`ZEPHYR_SDK_INSTALL_DIR`, includes `arm-zephyr-eabi-gcc`)

### 2. Install Zephyr

```bash
west init ~/zephyrproject && cd ~/zephyrproject && west update
```

### 3. Configure the environment

```bash
export ZEPHYR_BASE=~/zephyrproject/zephyr
export ZEPHYR_SDK_INSTALL_DIR=~/zephyr-sdk-0.16.5
```

### 4. Run the doctor (never falls back to a simulated build)

```bash
bun runner/index.ts doctor
```

```
EmbedFactory Environment

west             PASS   West version: v1.2.0
cmake            PASS   cmake version 3.28.3
ninja            PASS   ninja found
python           PASS   Python 3.11.6
dtc              PASS   devicetree compiler found
ZEPHYR_BASE      PASS   /home/me/zephyrproject/zephyr (from ZEPHYR_BASE)
Zephyr SDK       PASS   /home/me/zephyr-sdk-0.16.5 (0.16.5)
arm-zephyr-eabi  PASS   arm-zephyr-eabi-gcc 12.2.0
board            PASS   "nucleo_l476rg" recognised by west (312 boards)

Environment      READY
```

```
Environment      NOT_READY

Missing:
- west
- ZEPHYR_BASE
```

### 5. Start the runner (web/desktop builds go through it)

```bash
bun runner/index.ts serve --port 8790 --token <secret>
# then: BUILD_RUNNER_URL=http://127.0.0.1:8790, BUILD_RUNNER_TOKEN=<secret>
```

`GET /health` is a fast probe (filesystem lookups only); `GET /doctor` runs the
full diagnostic.

### 6. Create a project, then build it

The reference, reproducible project lives in [`samples/zephyr-blink`](samples/zephyr-blink)
(`CMakeLists.txt`, `prj.conf`, `src/main.c` — portable Zephyr APIs only, so it
builds for whatever upstream board you pass).

```bash
bun runner/index.ts build --dir ~/zephyrproject/embedfactory-ref \
  --rtos zephyr --board nucleo_l476rg --json
```

`west build` really runs, from the correct working directory, and the result
tells the truth:

```
REAL · SUCCESS · exitCode=0
command    west build -b nucleo_l476rg -d build -p auto
artifacts  build/zephyr/zephyr.elf  123456 B  ELF  sha256:…  ARM
memory     FLASH 41236 B / 256 KB · RAM 9536 B / 64 KB
```

### 7. Prove failure → repair → success end to end

```bash
bun runner/index.ts verify --board nucleo_l476rg
```

This builds the reference project with an intentional wrong Zephyr API, shows
the **real** GCC/linker error, applies the corrective patch (through the
configured LLM when `LLM_*` is set, otherwise deterministically), rebuilds, and
validates the resulting `zephyr.elf` (size, sha256, format, ELF header) plus the
FLASH/RAM usage and the ZIP export manifest — which carries the board profile:

```json
{
  "rtos": "zephyr",
  "board": "nucleo_l476rg",
  "toolchain": "West version: v1.2.0",
  "verification": "REAL · SUCCESS",
  "verdict": "SUCCESS"
}
```

If the Zephyr toolchain is not installed the command prints
`SKIPPED — Zephyr toolchain unavailable` and exits non-zero. It never fabricates
a build.

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
bun test                   # authz, patches, statuses, safety, runner, export, doctor
bun runner/index.ts doctor                 # is this machine able to build firmware?
bun runner/index.ts verify --board nucleo_l476rg   # real failure -> repair -> success
```

## Tests

`bun test` covers: cross-user authorization on every handler, path sandboxing,
unified-diff validation (`PATCH_FAILED`), LLM failure isolation, honest build
statuses, the repair loop and limit, real process execution (real compiler,
real exit codes, real artifacts), runner CLI contract, ZIP validity (verified
with Python's `zipfile`), knowledge retrieval budget and the safety rules.

The Zephyr-specific tests are **gated on the real toolchain**: they parse the
ELF header from real bytes, parse a real linker memory report, and — when the
environment is READY — run `west build` for a genuine
failure → repair → success cycle. On a machine without Zephyr they report
`SKIPPED — Zephyr toolchain unavailable` instead of a fake PASS.
