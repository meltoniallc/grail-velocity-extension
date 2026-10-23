# Grail Velocity

Chromium MV3 overlay. Reads eBay sold tape as you. Fast-Cash is **sold tape only**. v2 also records the eBay page you are already looking at.

## Status

**v2.1.0** — RC polish: shared watching / cliff / NO TAPE copy on overlay · popup · side panel; stronger Fast-Cash · listed ask · book ref hierarchy; side panel = cut queue only (no book mental model). Invariants unchanged.

**v2.0.4** — NO TAPE desk primary **Get solds** (open/focus sold search + scrape/auto-capture).

**v2.0.3** — Options **Use Railway Tape** preset (`https://tape-production-2810.up.railway.app`), desk SYNC FAIL banner, cliff → Inspect scratch.

- Auto-capture once per page view on item (`/itm/`), sold search (`LH_Sold=1`), and active search. It does not crawl, paginate, or open tabs.
- One parser per page type. Seller usernames are hashed only when a seller HMAC secret is already in storage (not exposed in Options).
- Popup: capture toggle, eBay toggle, pause 1 hour, today's count, queue, server status, quick comp lookup.
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

1. Download a Release asset named `grail-velocity-2.1.0-meltonia.zip` when published, or from a checkout: `npm run package` → `dist/grail-velocity-2.1.0-meltonia.zip`
2. Unzip. Open the `grail-velocity` folder (`manifest.json` must be in it).
3. chrome://extensions → Developer mode → Load unpacked → that folder.
4. Pin the icon. Meltonia zip: Tape URL + secret are already baked — Options is Check connection only (no paste). Auto-capture on.
5. Popup: Capture and eBay default on. Pause 1 hour stops capture. Checkout, messages, and My eBay stay on the built-in pause list.

## Compliance

Capture only pages the user personally views. The extension does not crawl, schedule background fetches of eBay, or turn pages on its own. That limit follows the eBay User Agreement, which prohibits robots, spiders, scrapers, and other automated means of accessing eBay without eBay's permission (https://www.ebay.com/help/policies/member-behaviour-policies/user-agreement?id=4259). Turn capture off in the popup or Options auto-capture switch.

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

Local Tape is for agents/dev only (`http://127.0.0.1:8787`). Meltonia desk uses the baked Railway host from the Meltonia zip — no Options secret field.

`POST /observe` accepts batches from the extension. Existing `GET /health`, `GET /ping`, `GET /suggest`, and `POST /tape` stay. Postgres tables for capture are migrations v3 (`cards`, `observations`, `comps`, `sku_mappings`) and v4 (`embeddings`, only when pgvector can be enabled) in the same `schema_migrations` list in `server/store.js` that runs at server start.

## Loaders

Dry-run is the default. Neither script calls the network.

```bash
python3 scripts/load_cardsight.py
python3 scripts/load_cardsight.py --commit --sqlite ./data/cardsight.sqlite
python3 scripts/load_mascot.py
```

CardSight writes cards, comps (`source=cardsight`), and sku mappings. The Mascot script only reads a SKU-mapping CSV.

Hosted Tape is `https://tape-production-2810.up.railway.app`. The private Meltonia zip bakes that URL and the matching `TAPE_SECRET` into `lib/meltonia-defaults.js` at package time (`MELTONIA_TAPE_SECRET=… npm run package`, or `MELTONIA_PACKAGE_STRICT=1` to refuse an empty bake). Meltonia never pastes the secret in Options. Agents own Railway `TAPE_SECRET` + the bake; the git tree keeps an empty stub so a live secret is never committed. The extension only sends the secret to the allowlisted Tape host.

Shared Meltonia Postgres: point the Railway `tape` service `DATABASE_URL` at the same Postgres meltonia-automation already runs (event-spine / pgvector host), and set `PG_SCHEMA=grail_tape`. Tape creates that schema and keeps `verified_prices` / `tape_snapshots` / observe tables there — additive only; it does not drop or rewrite other schemas. Scratch stays SQLite on the Tape service.

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
