# Grail Velocity

Chromium MV3 overlay. Reads eBay sold tape as you. Fast-Cash is **sold tape only**. v2 also records the eBay page you are already looking at.

## Status

**v2.1.0** — RC polish: shared watching / cliff / NO TAPE copy on overlay · popup · side panel; stronger Fast-Cash · listed ask · book ref hierarchy; side panel = cut queue only (no book mental model). Invariants unchanged.

**v2.0.4** — NO TAPE desk primary **Get solds** (open/focus sold search + scrape/auto-capture).

**v2.0.3** — Options **Use Railway Tape** preset (`https://tape-production-2810.up.railway.app`), desk SYNC FAIL banner, cliff → Inspect scratch.

- Auto-capture once per page view on item (`/itm/`), sold search (`LH_Sold=1`), and active search. It does not crawl, paginate, or open tabs.
- One parser per page type. Seller names are stored only as HMAC-SHA256 with a secret you set in Options.
- Popup: global capture, eBay toggle, pause list, pause 1 hour, today's count, queue, server status, quick comp lookup.
- Limits: 1 capture per URL per 10 minutes, 300 captures per hour. The outbox is IndexedDB. `POST /observe` writes Postgres when `DATABASE_URL` is set and SQLite when it is not.
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

## Load unpacked

1. Download: https://github.com/meltoniallc/grail-velocity-extension/releases/latest/download/grail-velocity-extension.zip
   Or from a checkout: `npm run package` → `dist/grail-velocity-extension.zip`
2. Unzip. Open the `grail-velocity` folder (`manifest.json` must be in it).
3. chrome://extensions → Developer mode → Load unpacked → that folder.
4. Pin the icon. Open Options and set the seller HMAC secret if you want seller hashes. Leave it blank and captures still save, without a seller hash.
5. Popup: Capture and eBay default on. Pause 1 hour stops capture. Checkout, messages, and My eBay are on the pause list.

## Compliance

Capture only pages the user personally views. The extension does not crawl, schedule background fetches of eBay, or turn pages on its own. That limit follows the eBay User Agreement, which prohibits robots, spiders, scrapers, and other automated means of accessing eBay without eBay's permission (https://www.ebay.com/help/policies/member-behaviour-policies/user-agreement?id=4259). Turn capture off in the popup. The seller HMAC secret stays in extension storage.

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

`POST /observe` accepts batches from the extension. Existing `GET /health`, `GET /ping`, `GET /suggest`, and `POST /tape` stay. Postgres tables for capture are migrations v3 (`cards`, `observations`, `comps`, `sku_mappings`) and v4 (`embeddings`, only when pgvector can be enabled) in the same `schema_migrations` list in `server/store.js` that runs at server start.

## Loaders

Dry-run is the default. Neither script calls the network.

```bash
python3 scripts/load_cardsight.py
python3 scripts/load_cardsight.py --commit --sqlite ./data/cardsight.sqlite
python3 scripts/load_mascot.py
```

CardSight writes cards, comps (`source=cardsight`), and sku mappings. The Mascot script only reads a SKU-mapping CSV.

Hosted Tape is `https://tape-production-2810.up.railway.app` only. Options → **Use Railway Tape** fills that URL (paste `TAPE_SECRET` from the Railway `tape` service). **Use local Tape** fills `http://127.0.0.1:8787`. The extension will not send the shared secret to any other host. `TAPE_SECRET` is not printed by the Railway process. `DATABASE_URL` stays on the service, not in the extension.

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
