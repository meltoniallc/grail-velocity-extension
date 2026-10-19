# Grail Velocity

Chromium MV3 overlay. Reads eBay sold tape as you. Fast-Cash is **sold tape only**.

## Status

**v2.0.1** — snappier capture + comps (see Performance)

- Fast-Cash chip says **TAPE** or **NO TAPE**. Catalog book price is labeled Book ref and cannot be Applied.
- Auto-capture (preference-gated) + capture meta; Continue solds pagination on sold search only.
- Local-first typeahead; optional Tape API suggest fallback + Postgres pull/hydrate.
- Scratch inspector (Options + `GET /scratch`); chrome.storage snapshot prune; Postgres `schema_migrations`.
- Scrape any eBay tab. Live BIN/asks never write Fast-Cash.
- High-match keep (72%+). Cliff after 3 consecutive misses.
- Optional tape server (Postgres + SQLite). Extension works without it.
- Tape server: 1MB body cap, pre-auth `/health` is `{ok:true}` with no CORS, secret file is `0600`.
- Operator UX: SPA MutationObserver rescan (keeps toggles), Alt+Shift+G panel toggle, Copy findings, status feedback, side panel last-read + Copy queue.
- Operator UX helpers live in `lib/overlay.js` and ship in the zip (required by the overlay).
- SPA navigation clears the previous card's sold tape so Fast-Cash cannot leak across queries.
- Live captions like "3 sold" stay asks. Sold comps need a Sold date or a sold-search page.

## Load

1. Download: https://github.com/meltoniallc/grail-velocity-extension/releases/latest/download/grail-velocity-extension.zip
   Or from a checkout: `npm run package` → `dist/grail-velocity-extension.zip`
2. Unzip. Open the `grail-velocity` folder (`manifest.json` must be in it).
3. chrome://extensions → Developer mode → Load unpacked → that folder.

## What the numbers are

| Field | Source |
|---|---|
| Fast-Cash **TAPE** | P25 × 0.98 of verified **sold** comps on/cached for this query |
| Fast-Cash **NO TAPE** | No price. Desk says: open solds or wait for auto-capture. |
| Book ref | Catalog ask from `catalog.json`. Display only — never Apply. |
| Listed ask | Live BIN/ask on this page. Empty on sold search. Never sets Fast-Cash. |
| kept / dropped | Title identity vs the search (set, #, print run, player) |

Need 2 tight (85%+) or 3 verified solds. One cheap near-miss cannot pull the tape.

## Tape server (optional)

```bash
npm install
DATABASE_URL=postgres://… TAPE_SECRET=$(openssl rand -hex 32) SQLITE_PATH=./data/scratch.sqlite npm run tape
```

Options → Tape API `http://127.0.0.1:8787` + the printed secret. Skip this unless you want Postgres retention.

A hosted Tape service on `https://….up.railway.app` works in the same field. The extension may call that host (`https://*.up.railway.app/*`). Loopback is unchanged. The Railway service variable `TAPE_SECRET` is the shared secret; `DATABASE_URL` stays on the service, not in the extension.

## Performance (2.0.1)

- Capture answers the overlay as soon as Chrome tape is written; `POST /tape` goes through a persisted
  outbox (`tapeOutbox`, FIFO, retry with backoff, flushed on worker start).
- Service worker serves hot `chrome.storage` keys from memory (refreshed via `storage.onChanged`).
- Remote calls have deadlines (suggest 1.2s, pull 2.5s); remote suggest hits are memoized 20s.
- Overlay starts the tape lookup and the DOM scrape in parallel.
- Server: SQLite WAL + one transaction per write; Postgres migrations once per process, snapshot +
  verified solds in one transaction with a single `unnest` batch upsert, parallel `/tape` reads,
  migration v2 indexes (prefix, `updated_at`, `(query_norm, seen_at)`, optional `pg_trgm`), gzip ≥1KB,
  keep-alive.

Bench (local, no eBay traffic): `node bench/latency.js` (add `DATABASE_URL=…` for Postgres — it
**truncates** the tape tables, so point it at a scratch DB; `BENCH_RTT_MS=80` models a remote server).
`TEST_DATABASE_URL=… npm test` also runs the live Postgres test.
