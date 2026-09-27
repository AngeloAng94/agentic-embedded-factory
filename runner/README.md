# EmbedFactory local runner

The runner is the **only** component that executes native toolchains. The web
app (Convex) cannot run `west`/`cmake`, so a build is a job:

```
WEB → Build Job → Runner (HTTP) → real Zephyr/FreeRTOS toolchain
```

If no runner is configured, the web reports the build as
`NOT_AVAILABLE · UNKNOWN` — never as a success.

## Requirements

- [Bun](https://bun.sh) (runs the TypeScript directly), or Node 22.6+ with
  `--experimental-strip-types`
- Zephyr: `west` in `PATH` and `ZEPHYR_BASE` set (a west workspace)
- FreeRTOS: `cmake` + a C toolchain

## CLI

```bash
# build the current project directory with the real toolchain
bun runner/index.ts build --dir ./my-project --rtos zephyr --board nucleo_l476rg

# build files coming from a JSON array [{ "path": "src/main.c", "content": "..." }]
bun runner/index.ts build --files ./files.json --json

# git init + add + commit (uses -c user.name/-c user.email: no global config touched)
bun runner/index.ts git --dir ./my-project --message "Initial commit"

# structural safety analysis (rules with file, line, severity)
bun runner/index.ts analyze --files ./files.json --rtos zephyr --json

# write the full export tree (files + README + BUILD.md + manifest) to a directory
bun runner/index.ts export --files ./files.json --out ./exported-project
```

## HTTP mode (used by the web app)

```bash
bun runner/index.ts serve --port 8790 --token <secret>
```

Endpoints:

| Method | Path       | Purpose                                          |
| ------ | ---------- | ------------------------------------------------ |
| GET    | `/health`  | which tools are available (`west`, `cmake`, …)   |
| POST   | `/build`   | real build of the posted files                   |
| POST   | `/git`     | `git init` + `add` + `commit` on the posted files |
| POST   | `/export`  | write the export tree to `outDir`                |
| POST   | `/analyze` | return the safety analysis report                |

Then set in the deployment environment:

```
BUILD_RUNNER_URL=https://your-runner-host:8790
BUILD_RUNNER_TOKEN=<the same secret>
```

## Honest result contract

```json
{
  "verification": "REAL",
  "verdict": "SUCCESS",
  "command": "west build -b nucleo_l476rg -d build -p auto",
  "exitCode": 0,
  "durationMs": 18400,
  "stdout": "...",
  "stderr": "...",
  "artifacts": ["build/zephyr/zephyr.elf"],
  "toolchain": "West version: v1.2.0",
  "reason": null
}
```

- `verification`: `REAL` (a process ran) · `SIMULATED` · `NOT_AVAILABLE`
- `verdict`: `SUCCESS` · `FAILURE` · `UNKNOWN`

A missing binary produces `NOT_AVAILABLE` with
`reason: toolchain unavailable: "west" is not installed or not in PATH`.
The web app additionally downgrades any runner answer that claims `SUCCESS`
without `verification: REAL` and `exitCode: 0`.

## Security notes

- `/build`, `/git` and `/export` write into a temporary directory, and every
  path is validated against the project sandbox (no `..`, no absolute paths).
- Always set `--token` when the runner is reachable from the network.
