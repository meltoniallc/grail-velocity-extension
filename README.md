# Grail Velocity

Chromium MV3 overlay. Reads eBay as you. **Scrape this page** is always on the overlay — live search, solds, and listings. Fast-Cash still comes only from high-match **sold** comps.

## Status

v1.1.1 — scrape on every eBay tab, sold-only Fast-Cash

- [x] Stop scraping when sold titles fall off the original search (eBay relevance cliff)
- [x] Price only verified matches at 72%+ identity (set, #, print run, player) — cheap near-misses never enter Fast-Cash
- [x] Character-by-character typeahead from retained tape (no new tab until you submit)
- [x] Scrape button on live search and listings, not only sold mode
- [x] Live BIN/ask prices never write Fast-Cash or Postgres
- [x] Verified prices: Chrome tape + optional Postgres
- [x] Rejected / cliff noise / live asks: SQLite scratch (7-day TTL)

## Load

1. Download the zip: https://github.com/meltoniallc/grail-velocity-extension/releases/latest/download/grail-velocity-extension.zip
2. Unzip. Open the `grail-velocity` folder (`manifest.json` must be in it).
3. chrome://extensions → Developer mode → Load unpacked → that folder.

## Scrape

The overlay mounts on every eBay page. The first button is **Scrape this page** (or **Scrape solds** / **Scrape this listing**). Popup footer is the same action.

- Live search: high-match listings fill the list. Fast-Cash stays on cached sold tape. Open solds when you need comps.
- Sold search: high-match solds update the tape and Fast-Cash.
- Close the panel and a **Scrape** chip stays on the right edge.

## What gets kept

eBay sold search pads later rows with related junk. Grail Velocity scores each title in page order against the original query:

- Player, year, distinctive set (Mercury vs Prizm), card `#`, print-run `/99`, and parallel must match when the query has them
- Copy number `74/99` vs `12/99` of the **same** card still counts
- After three consecutive misses (or four from a cold start), it **stops**. Later rows are cliffed, not priced
- Overlay lists high-match rows from **this** page. "Show dropped" is opt-in

Fast-Cash needs two tight comps (85%+) or three verified solds. Live asks cannot pull the tape.

## Instant typeahead

Type in the popup, side panel, or overlay. Each character queries the local tape (previous high-match **sold** scans + book). Submit or click a hit to open solds.

## Tape server (Postgres + SQLite)

Optional. The extension works without it.

```bash
npm install
npm run tape
```

The terminal prints the secret and reuses the same one next boot (`data/tape.secret`). Options → paste that secret → Tape API `http://127.0.0.1:8787` → **Check connection**.

Need Postgres?

```bash
DATABASE_URL=postgres://… npm run tape
```

- `POST /tape` — verified **sold** snapshot → Postgres; rejected titles and live asks → SQLite
- `GET /suggest?q=` — prefix lookup on retained snapshots
- `GET /ping` — secret check
- `GET /health`

Chrome storage still answers typeahead instantly. Postgres is retention. SQLite is disposable noise (pruned after 7 days).
