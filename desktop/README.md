# EmbedFactory Desktop (Electron + local Express + SQLite)

Offline variant of EmbedFactory. It uses the **same runner** as the web app, so
there is a single implementation of the LLM turn, patch validation and the real
build contract.

```
Electron renderer (React)
        ↓  HTTP localhost:3001
Express server (desktop/server)  → SQLite (desktop/data/embedfactory.db)
        ↓  spawn
runner/index.ts  (repo root) → LLM provider + real west/cmake/git toolchain
```

The renderer never talks to an LLM provider directly and never computes a build
result: it calls `POST /api/projects/:id/agent`, which runs the whole turn
server-side.

## Requirements

- [Bun](https://bun.sh) (recommended) or Node 22.6+ with `--experimental-strip-types`
- The repository `runner/` directory (the desktop app spawns it)
- Zephyr (`west`, `ZEPHYR_BASE`) and/or `cmake` for real builds
- Optional: an LLM provider (Ollama with `OLLAMA_ORIGINS="*" ollama serve`, or an
  OpenAI-compatible endpoint)

## Environment (server side)

```
LLM_PROVIDER=ollama            # or openai
LLM_BASE_URL=http://localhost:11434
LLM_API_KEY=                   # required for remote endpoints
LLM_MODEL=llama3
BUILD_RUNNER_TOKEN=            # optional shared secret (HTTP runner mode)
```

This is the same catalogue as the web app — see
[`../ENVIRONMENT.md`](../ENVIRONMENT.md). Secrets stay server side in both
variants; neither UI ever displays a key or a token (only *Configured* /
*Not configured*), and neither one claims `READY`/`CONNECTED` without a real check.

## API

| Method | Path                              | Purpose                                              |
| ------ | --------------------------------- | ---------------------------------------------------- |
| POST   | `/api/projects/bootstrap`         | create the skeleton (status `unverified`, no build)   |
| POST   | `/api/projects/:id/agent`         | LLM → validated patches → real build, repair loop ≤ 3 |
| POST   | `/api/projects/:id/build`         | real build of the current files                       |
| GET    | `/api/projects/:id/runs`          | run evidence (`evidence` JSON: verification/verdict/…) |
| GET    | `/api/projects/:id/versions`      | version history (v1..vn)                              |
| POST   | `/api/projects/:id/rollback`      | restore a version (writes a new version)              |
| POST   | `/api/projects/:id/export`        | write the project tree + README + manifest to `outDir` |
| POST   | `/api/projects/:id/git`           | `git init` + `add` + `commit` on the project files     |

## Honesty rules (identical to the web app)

- A run is `REAL / SIMULATED / NOT_AVAILABLE` and `SUCCESS / FAILURE / UNKNOWN`.
- `SUCCESS` requires `REAL` + `exitCode === 0`; anything else is downgraded to
  `UNKNOWN` and shown as `NOT AVAILABLE` or `LEGACY · UNVERIFIED`.
- A project becomes `verified` only after a real successful build.
- If the provider is unreachable: explicit error, **no file change, no build**.

## Development

```bash
cd desktop
npm install
npm run dev            # electron + local server
npm run build:win      # installer
```

Known gap: the History/Export/Git **buttons** are not wired in the renderer yet —
the endpoints above are implemented and usable, but only the chat/rebuild flow
has UI controls. The web app has the full control set.
