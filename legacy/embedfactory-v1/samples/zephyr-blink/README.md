# EmbedFactory reference Zephyr project

A minimal, **board-agnostic** Zephyr application used as the reproducible
"vertical slice" fixture: the runner compiles it with the real toolchain and
validates the artifacts it produces.

```
CMakeLists.txt   stock Zephyr application boilerplate
prj.conf         generic Kconfig (printk/serial/console)
src/main.c       printk + k_sleep loop, no board-specific headers
```

Nothing here invents board support: the sources only use portable Zephyr APIs
(`printk`, `k_sleep`, `k_uptime_get`), so whatever board Zephyr upstream ships,
this application builds for it.

## Boards

| Board                | Needs            | Produces                          |
| -------------------- | ---------------- | --------------------------------- |
| `native_sim`         | host gcc only    | `build/zephyr/zephyr.elf`         |
| `qemu_cortex_m3`     | Zephyr SDK (ARM) | `zephyr.elf`, `zephyr.bin`, `.hex` |
| `nucleo_l476rg`      | Zephyr SDK (ARM) | `zephyr.elf`, `zephyr.bin`, `.hex` |

`nucleo_l476rg` is the default reference board: it is a real ST Nucleo board
whose Zephyr board definition has shipped for many releases, so
`bun runner/index.ts doctor` can confirm it with `west boards`.

## Prerequisite check

`west build` only works from **inside a west workspace**. The runner's `doctor`
command says whether this machine is ready — it never falls back to a simulated
build:

```bash
bun runner/index.ts doctor
```

On a machine without Zephyr you get:

```
Environment      NOT_READY

Missing:
- west
- ZEPHYR_BASE
- Zephyr SDK
```

## Build it by hand

From inside your west workspace (so that `west build` can find `ZEPHYR_BASE`):

```bash
cp -r samples/zephyr-blink "$(west topdir)/embedfactory-ref"
cd "$(west topdir)/embedfactory-ref"
west build -b nucleo_l476rg -d build -p auto
ls build/zephyr/zephyr.elf build/zephyr/zephyr.bin
```

## Build it through the runner

```bash
bun runner/index.ts build --dir "$(west topdir)/embedfactory-ref" \
  --rtos zephyr --board nucleo_l476rg --json
```

The JSON result contains the exact command, cwd-independent stdout/stderr, the
exit code, duration, and byte-level artifact validation (size, sha256, format,
ELF header) plus FLASH/RAM usage when the toolchain reports it. A build is only
`verification: "REAL"` with `exitCode: 0` → `verdict: "SUCCESS"` when the real
process exited 0.

## End-to-end proof (failure → repair → success)

```bash
bun runner/index.ts verify --board nucleo_l476rg
```

This materialises the reference project inside your west workspace once with an
intentional defect (a call to a Zephyr API that does not exist), builds it,
shows the real GCC/linker error, applies the corrective patch (through the
configured LLM when `LLM_*` is set, otherwise the deterministic patch), rebuilds,
and validates the resulting `zephyr.elf`. It exits non-zero unless the final
build is a real success.
