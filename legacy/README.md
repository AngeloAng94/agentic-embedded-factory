# legacy/embedfactory-v1 — snapshot di EmbedFactory v1

Questa cartella è il **fermo immagine integrale** del repository prima della
trasformazione in PY Bench Agent. È esclusa da build, lint e test
(`bunfig.toml`, `eslint.config.js`, `tsconfig.app.json`) ma **non è stata
modificata in alcun modo**: è una copia byte per byte dell'albero originale.

## Perché una cartella e non un tag git

Il tag `embedfactory-v1` **non è stato creato**: in questo ambiente i comandi
git sono bloccati dall'host (`Git and GitHub commands are blocked`), quindi non
è possibile fare `git init`, `git add`, `git commit` né `git tag`. Lo snapshot +
`MANIFEST.sha256` è il sostituto verificabile: 203 file, hash SHA-256 di ognuno.

Per verificare l'integrità:

```bash
cd legacy/embedfactory-v1
sha256sum -c MANIFEST.sha256
```

## Come ricreare il tag vero (sul tuo PC, dove git funziona)

Il tag deve puntare al contenuto di v1, non allo stato attuale. Il modo corretto
è far diventare questo snapshot il **primo commit** della storia:

```bash
tmp="$(mktemp -d)"
cp -a legacy/embedfactory-v1/. "$tmp"/
cd "$tmp"
git init -q
git add -A
git commit -qm "EmbedFactory v1 — congelato prima di PY Bench Agent"
git tag embedfactory-v1
```

Da lì puoi aggiungere il nuovo albero come commit successivo, oppure usare
`$tmp` come remote/sorgente per ricostruire la storia.

## Cosa contiene

- `src/convex/` — backend Convex (schema, azioni, auth, knowledge base statica)
- `src/pages/`, `src/components/`, `src/hooks/`, `src/*.tsx` — workspace web,
  landing, auth, Environment, Settings
- `src/lib/core/` e `runner/` — il core del vecchio prodotto (qui nella loro
  posizione originale; nel nuovo albero vivono in `core/`, `agent/`,
  `tools/runner/`)
- `desktop/` — app Electron
- `docs/` — infografiche e poster del vecchio prodotto
- `ENVIRONMENT.md`, `integrations.md`, `main.ts`, `vly-toolbar-readonly.tsx`,
  `sst-env.d.ts`, `convex.json` — integrazioni vly / hosting
- `tsconfig.*`, `vite.config.ts`, `index.html`, `postcss.config.cjs`,
  `components.json`, `package-lock.json` — configurazione del vecchio stack

## Cosa non contiene (di proposito)

- `node_modules/`, `dist/`, `.git/` — non sono codice
- `.env.local` e ogni file di ambiente locale — possono contenere segreti e non
  vanno duplicati in una cartella di snapshot
- `.env.example` — è rimasto al root del repository, non è stato toccato

## Nota

Nessun file è stato cancellato: tutto ciò che non è più nel nuovo albero esiste
qui. Lo snapshot **non va modificato** né "riparato": se serve una correzione,
va fatta nel nuovo albero.
