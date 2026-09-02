# EmbedFactory Desktop

100% offline embedded firmware AI factory. No cloud required.

## Architecture

```
desktop/
├── main.js                 # Electron main process
├── preload.js              # IPC bridge
├── server/
│   ├── index.js            # Express server entry
│   ├── db.js               # SQLite database (better-sqlite3)
│   ├── api.js              # REST API (mirrors Convex mutations/queries)
│   └── templates.js        # RTOS project templates
├── renderer/               # React frontend (Vite)
│   ├── src/
│   │   ├── main.tsx        # Entry point
│   │   ├── lib/api.ts      # Local API client (replaces Convex)
│   │   ├── pages/          # Landing + Dashboard
│   │   └── components/     # UI + workspace components
│   └── vite.config.ts
└── package.json
```

## How it works

- **Backend**: Express + SQLite (local database file at `data/embedfactory.db`)
- **AI**: Ollama (local, optional) — falls back to deterministic stubs if not available
- **Frontend**: React + Tailwind + shadcn/ui (same UI as web version)
- **Desktop wrapper**: Electron

## Quick start (development)

```bash
cd desktop
npm install          # or bun install
npm run dev          # starts both Express server (port 3001) and Vite (port 5174)
```

Then open `http://localhost:5174` in your browser.

## Build for Windows (.exe)

```bash
cd desktop
npm install
npm run build:win    # builds renderer + packages as Windows installer
```

Output: `desktop/dist-electron/EmbedFactory Setup x.x.x.exe`

## Build for all platforms

```bash
npm run build:all    # builds for Windows, macOS, and Linux
```

## With Ollama (AI code generation)

```bash
# 1. Install Ollama from https://ollama.com/download
# 2. Start with CORS enabled:
OLLAMA_ORIGINS="*" ollama serve

# 3. In another terminal, pull a model:
ollama pull llama3
```

Without Ollama, the platform works with deterministic fallback stubs.

## Database

SQLite database is stored at `desktop/data/embedfactory.db`. It's created automatically on first run. To reset, delete the file.

## Tech stack

- Electron 33
- React 19 + Vite 6
- Express 4 + better-sqlite3
- Tailwind CSS 3
- shadcn/ui components
- TypeScript 5
