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
# is this machine able to build firmware? (west, cmake, ninja, python, dtc,
# ZEPHYR_BASE, Zephyr SDK, arm-zephyr-eabi, and whether the board is recognised)
bun runner/index.ts doctor
bun runner/index.ts doctor --board native_sim --json

# real end-to-end proof: reference project builds with an intentional defect,
# the real compiler error is shown, the patch is applied, the rebuild succeeds
bun runner/index.ts verify --board nucleo_l476rg

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

| Method | Path        | Purpose                                             |
| ------ | ----------- | --------------------------------------------------- |
| GET    | `/health`   | fast probe: which tools are in PATH (`west`, …)     |
| GET    | `/doctor`   | full environment report (READY / NOT_READY)         |
| GET    | `/doctor?board=<name>` | same report, probing a specific board    |
| POST   | `/build`   | real build of the posted files                   |
| POST   | `/git`     | `git init` + `add` + `commit` on the posted files |
| POST   | `/export`  | write the export tree to `outDir`                |
| POST   | `/analyze` | return the safety analysis report                |

`/doctor` always returns the full `boardsSupported` list read from `west boards`,
and answers `200` when the environment is READY or `503` when it is NOT_READY —
the HTTP status is itself the verdict. The web app's **Environment → Run
diagnostics** button calls exactly these two endpoints through the Convex action
`environmentActions.runDiagnostics`, and stores only non-secret evidence. It never
fabricates a result, so an unreachable runner becomes `UNKNOWN`, not `READY`.

Then set in the deployment environment:

```
BUILD_RUNNER_URL=https://your-runner-host:8790
BUILD_RUNNER_TOKEN=<the same secret>
```

See [`../ENVIRONMENT.md`](../ENVIRONMENT.md) for the complete variable catalogue.

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
  "rtos": "zephyr",
  "board": "nucleo_l476rg",
  "toolchain": "West version: v1.2.0",
  "artifacts": ["build/zephyr/zephyr.elf", "build/zephyr/zephyr.bin"],
  "artifactDetails": [
    {
      "path": "build/zephyr/zephyr.elf",
      "bytes": 123456,
      "sha256": "6f1c…",
      "format": "elf",
      "elf": { "class": "ELF32", "endianness": "little", "type": "EXEC", "machine": "ARM (e_machine=40)", "entry": "0x8000…", "architecture": "ARM" }
    }
  ],
  "memory": {
    "flashUsed": 41236,
    "flashTotal": 262144,
    "ramUsed": 9536,
    "ramTotal": 65536,
    "sections": { "text": 40000, "data": 1236, "bss": 8300 },
    "report": "           FLASH:       41236 B       256 KB     15.73%"
  },
  "reason": null
}
```

- `verification`: `REAL` (a process ran) · `SIMULATED` · `NOT_AVAILABLE`
- `verdict`: `SUCCESS` · `FAILURE` · `UNKNOWN`
- `artifactDetails` is byte-level evidence: the file was read from disk, so
  the size, the sha256, the detected format and the ELF header are real.
- `memory` is FLASH/RAM usage parsed from the toolchain's own output (the
  Zephyr linker report, or the binutils `size` tool).

A missing binary produces `NOT_AVAILABLE` with
`reason: toolchain unavailable: "west" is not installed or not in PATH`.
The web app additionally downgrades any runner answer that claims `SUCCESS`
without `verification: REAL` and `exitCode: 0`.

## Security notes

- `/build`, `/git` and `/export` write into a temporary directory, and every
  path is validated against the project sandbox (no `..`, no absolute paths).
- Always set `--token` when the runner is reachable from the network.
