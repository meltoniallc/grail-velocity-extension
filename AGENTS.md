# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

Grail Velocity is a Chromium **Manifest V3** extension (`manifest.json` at the repo
root) with an optional Node "tape" backend. There is no build step — the extension
files are loaded directly. Core matching/velocity logic lives in `lib/core.js` and is
shared by the content script, popup, side panel, and tests.

## Environment & setup

- `npm install` — installs the single runtime dependency (`pg`). A committed
  `package-lock.json` keeps this reproducible.
- `npm run tape` — starts the optional tape server on `http://127.0.0.1:8787`
  (`GET /health`, `GET /suggest`, `POST /tape`). It works without Postgres: set
  `DATABASE_URL` to enable Postgres, otherwise verified prices are skipped and
  rejected listings are parked in a local Node SQLite scratch DB (`node:sqlite`,
  requires Node ≥ 22). Optional env: `PORT`, `SQLITE_PATH`, `TAPE_SECRET`.

The Cloud Agent environment (`.cursor/environment.json`) runs `npm install` on setup
and starts the tape server in a `tape-server` terminal.

## Testing

- `npm test` — runs the Node test suite (`node --test test/*.test.js`). Covers the
  match/relevance-cliff logic, tape merge, typeahead, the SQLite scratch store, and
  the HTTP server. Run this for any change to `lib/`, `server/`, or `content/`.
- `test/harness.html` — a self-contained preview that renders the on-eBay overlay UI
  using the real `lib/core.js` engine (no extension runtime or eBay needed). Open it
  with a `?q=` query string to exercise typeahead.

## Browser testing (loading the extension)

Branded Google Chrome **137+ removed the `--load-extension` command-line flag**, and
extensions cannot load in `--headless` mode. To side-load the unpacked extension for
manual/automated UI testing, use the helper script, which loads it via the DevTools
`Extensions.loadUnpacked` method over the CDP pipe transport (with
`--enable-unsafe-extension-debugging`) against a headed Chrome on an X display
(it auto-starts `Xvfb` when no `DISPLAY` is present):

```bash
npm run load-extension                       # load + screenshot the popup
npm run load-extension -- --type Wembanyama  # exercise instant typeahead
npm run load-extension -- --page options     # screenshot the options page
npm run load-extension -- --keep-open        # load and keep Chrome running, print the id
```

Useful flags: `--page <popup|options|sidepanel|URL>`, `--out <file.png>`,
`--type <text>`, `--display <:N>`, `--user-data-dir <dir>`. Set `GV_CHROME` to point
at a specific Chrome/Chromium binary. Run `node scripts/load-extension.js --help` for
the full list. Chrome for Testing (which still honors `--load-extension`) is an
alternative if you prefer a plain remote-debugging port.

The full on-eBay flow (Fast-Cash on revise, sold-tape scraping) requires a signed-in
eBay session and cannot be exercised headlessly; use `test/harness.html` and the
popup/options pages to validate the engine and UI in isolation.

## Conventions

- CommonJS with `"use strict"`; keep `require`s at the top of the module.
- The extension ships unbundled — don't add a bundler or transpile step. Keep
  browser-facing code compatible with the MV3 runtime.
