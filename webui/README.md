# SORESPO Web UI

The SORESPO Web UI is a SvelteKit application built as a static SPA and
embedded into the `sorespo` binary: the StratoWeave HTTP server serves the UI
on the same port as the APIs (80 by default), with an `index.html` fallback
for client-routed pages. There is no separate Web UI container or server.

## Test Environments

Choose an environment under `test/` and run its Make targets from the
repository root. For example:

```bash
TESTENV=test/quicklab-srl
make -C "$TESTENV" start
```

The `sweave` container publishes the SORESPO HTTP port on
<http://localhost:3000>; the Web UI appears there as soon as SORESPO is
running inside `sweave` (`make -C "$TESTENV" tutorial` does all of it). Set
`WEBUI_PORT` to change the host port.

```bash
make -C "$TESTENV" stop
```

## Local Development

Install [Bun](https://bun.sh/) and the frontend dependencies:

```bash
cd webui
bun install --frozen-lockfile
cd ..
```

With the selected test environment running, start Vite:

```bash
make -C "$TESTENV" dev-webui
```

Vite serves <http://localhost:5173> (`WEBUI_DEV_PORT`), proxies API requests
to the running `sweave` container (`STRATOWEAVE_API_ORIGIN`), and reloads
changes under `webui/src`. The embedded UI at `WEBUI_PORT` is unaffected.

```bash
make -C "$TESTENV" stop-dev-webui
```

Run checks and builds from `webui/`:

```bash
bun run check
bun run test
bun run build
```

## Authentication

When HTTP authentication is enabled in StratoWeave, the UI starts with a
sign-in page offering the configured OIDC provider and local fallback account.
The backend performs the OIDC exchange and token refresh; the browser receives
an opaque HttpOnly session cookie and session metadata. The UI keeps its CSRF
token in memory and sends it on API mutations. It does not use browser storage
for authentication credentials.

An expired session hides the workspace and pauses API polling until sign-in.
Local sign-in preserves open drafts; provider sign-in navigates away, so save
edits before starting it. Explicit sign-out clears the mounted workspace.

The Vite proxy includes `/auth` as well as the application APIs. To authenticate
through Vite, configure the backend's public application origin to the Vite URL
(normally `http://localhost:5173`) and register that origin's
`/auth/oidc/callback` URL with the provider. Use that same origin throughout the
login flow: origin checks and host-only cookies are intentional. Ordinary
development against an authentication-disabled backend and the standalone
demo continue to work without a sign-in page.

## Embedded Assets

The production UI ships inside the sorespo binary. After changing the UI,
regenerate the embedded-assets module and commit it:

```bash
make gen-webui   # builds webui/ and rewrites src/sorespo/webui_assets.act
```

The module is a single `ASSETS: dict[str, str]` constant (URL path -> file
content) with every file embedded verbatim as a raw string literal.

CI regenerates the module and fails on any diff, so the build must stay
deterministic (see `kit.version` in `svelte.config.js`). Only text assets can
be embedded (the HTTP server sends `str` bodies); binary files such as images
must be inlined into the bundle — the logo is imported in Svelte and inlined
as a data URI via `assetsInlineLimit` in `vite.config.ts`.

## Demo

The static demo uses in-memory sample data and does not require SORESPO:

```bash
cd webui
bun run build:demo
PUBLIC_DEMO=1 bun run dev
```

`build:demo` writes the deployable static site to `build/`. Demo mode powers
the [interactive tour](https://www.stratoweave.org/tutorials/exploring-the-webui/).
