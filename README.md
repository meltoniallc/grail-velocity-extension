# Grail Velocity

Chromium MV3 overlay. Reads eBay sold tape as you. Fast-Cash is **sold tape only**. v2 also records the eBay page you are already looking at.

## Status

**v2.0.0**

- Auto-capture once per page view on item (`/itm/`), sold search (`LH_Sold=1`), and active search. It does not crawl, paginate, or open tabs.
- One parser per page type. Seller names are stored only as HMAC-SHA256 with a secret you set in Options.
- Popup: global capture, eBay toggle, pause list, pause 1 hour, today's count, queue, server status, quick comp lookup.
- Limits: 1 capture per URL per 10 minutes, 300 captures per hour. The outbox is IndexedDB. `POST /observe` writes Postgres when `DATABASE_URL` is set and SQLite when it is not.
- Fast-Cash chip says **TAPE** or **NO TAPE**. Catalog book price is labeled Book ref and cannot be Applied.
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
| Fast-Cash **NO TAPE** | No price. Open solds and scrape. |
| Book ref | Stale catalog ask from `catalog.json`. Display only. |
| Listed | Live ask on this page. Empty on sold search. Catalog BIN is Book ref only. |
| kept / dropped | Title identity vs the search (set, #, print run, player) |

Need 2 tight (85%+) or 3 verified solds. One cheap near-miss cannot pull the tape.

## Tape server (optional)

```bash
npm install
DATABASE_URL=postgres://… TAPE_SECRET=$(openssl rand -hex 32) SQLITE_PATH=./data/scratch.sqlite npm run tape
```

Options → Tape API `http://127.0.0.1:8787` + the printed secret. Skip this unless you want Postgres retention.

`POST /observe` accepts batches from the extension. Existing `GET /health`, `GET /ping`, `GET /suggest`, and `POST /tape` stay. Numbered SQL lives in `db/migrations`. The embeddings table is applied only when pgvector is installed.

## Loaders

Dry-run is the default. Neither script calls the network.

```bash
python3 scripts/load_cardsight.py
python3 scripts/load_cardsight.py --commit --sqlite ./data/cardsight.sqlite
python3 scripts/load_mascot.py
```

CardSight writes cards, comps (`source=cardsight`), and sku mappings. The Mascot script only reads a SKU-mapping CSV.
