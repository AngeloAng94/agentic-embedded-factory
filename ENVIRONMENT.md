# EmbedFactory — environment variables

This is the canonical catalogue of every environment variable the project really
reads, so `README.md`, the control plane (Environment → Settings) and the runtime
describe the same reality.

> `.env.example` is not committed: this repository's tooling treats `.env*` as
> sensitive files and refuses to write them. The list below is the exact content
> that file would have. Copy it into your deployment's environment settings (or a
> local, git-ignored file) and fill in the values.

**Every variable here is server-side.** They are read with `process.env` inside
Convex node actions (`src/convex/environmentActions.ts`, `src/convex/agent.ts`)
or inside the local runner (`runner/index.ts`). A value is never sent to the
browser, never written to `localStorage`, and never included in an API response.
The UI only ever renders `Configured` / `Not configured` for the variables
marked **SECRET**.

The AI and build-runner groups are the same list as
`ENV_VAR_DOCS` in `src/lib/core/environmentStatus.ts` — the shared catalogue that
the Settings page renders — so the documentation and the UI cannot drift apart.

## AI / LLM

| Variable                                                              | Purpose                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `LLM_PROVIDER`                                                        | `ollama` (default) or `openai` for any OpenAI-compatible endpoint.             |
| `LLM_BASE_URL`                                                        | Base URL of the provider; required for a remote OpenAI-compatible endpoint.    |
| `LLM_API_KEY`                                                         | **SECRET.** Required when `LLM_PROVIDER=openai` and the host is not local.     |
| `LLM_MODEL`                                                           | Model used for every agent turn (`llama3` / `gpt-4o-mini` by default).          |
| `LLM_TIMEOUT_MS`                                                      | Per-request timeout in milliseconds (default `60000`).                          |
| `LLM_MAX_RETRIES`                                                     | Retries for 5xx and network errors (default `1`).                               |
| `LLM_TEMPERATURE`                                                     | Sampling temperature (default `0.2`).                                           |

```bash
LLM_PROVIDER=ollama
LLM_BASE_URL=http://localhost:11434
LLM_API_KEY=
LLM_MODEL=llama3
LLM_TIMEOUT_MS=60000
LLM_MAX_RETRIES=1
LLM_TEMPERATURE=0.2
```

## Build runner

| Variable                   | Purpose                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `BUILD_RUNNER_URL`         | HTTP endpoint of the runner (`bun runner/index.ts serve`).                   |
| `BUILD_RUNNER_TOKEN`       | **SECRET.** Must match the runner's `--token`; sent as a bearer token.       |
| `BUILD_RUNNER_TIMEOUT_MS`  | Dispatch timeout in milliseconds (default `900000`, i.e. 15 minutes).        |

```bash
BUILD_RUNNER_URL=http://127.0.0.1:8790
BUILD_RUNNER_TOKEN=
BUILD_RUNNER_TIMEOUT_MS=900000
```

Without `BUILD_RUNNER_URL` the build capability is reported as
`NOT AVAILABLE` — never as a success. The runner is the only component that
executes native toolchains.

## Toolchain (read by the runner, not by the web app)

| Variable                       | Purpose                                                                  |
| ------------------------------ | ------------------------------------------------------------------------ |
| `ZEPHYR_BASE`                  | West workspace path; `west build` can also export it itself.              |
| `ZEPHYR_SDK_INSTALL_DIR`       | Zephyr SDK directory (contains `arm-zephyr-eabi-gcc`).                    |
| `EMBEDFACTORY_BOARD`           | Board probed by `doctor` when no `--board` is passed (default `nucleo_l476rg`). |
| `EMBEDFACTORY_BUILD_COMMAND`   | Force a specific build command instead of `west build`.                   |
| `CROSS_COMPILE`                | Toolchain prefix used when looking up `<prefix>gcc`.                      |

```bash
ZEPHYR_BASE=/home/me/zephyrproject/zephyr
ZEPHYR_SDK_INSTALL_DIR=/home/me/zephyr-sdk-0.16.5
EMBEDFACTORY_BOARD=nucleo_l476rg
EMBEDFACTORY_BUILD_COMMAND=
CROSS_COMPILE=
```

## Platform (normally injected automatically)

| Variable                  | Purpose                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `VITE_CONVEX_URL`         | Convex deployment URL used by the browser client.                  |
| `CONVEX_SITE_URL`         | Issuer used by Convex Auth.                                        |
| `VLY_APP_NAME`            | App name used in the sign-in e-mail.                               |
| `VLY_CONVEX_AUTH_ISSUER`  | Federated token issuer (default `https://freebuff.com`).           |
| `VLY_INTEGRATION_KEY`     | Integration gateway key — see `integrations.md`.                   |
| `VLY_INTEGRATION_BASE_URL`| Integration gateway base URL.                                      |

```bash
VITE_CONVEX_URL=
CONVEX_SITE_URL=
VLY_APP_NAME=
VLY_CONVEX_AUTH_ISSUER=https://freebuff.com
VLY_INTEGRATION_KEY=
VLY_INTEGRATION_BASE_URL=https://integrations.freebuff.com/
```

No secret belongs in a `VITE_*` variable: those are inlined into the browser
bundle by Vite.

## How to verify a configuration

```bash
bun runner/index.ts doctor        # is this machine able to build firmware?
bun runner/index.ts serve         # then: Environment → Run diagnostics in the app
```

The control plane never guesses. `Environment → Settings → Test connection`
performs a real generation request, and `Test runner` performs a real
`GET /health` on the runner.
