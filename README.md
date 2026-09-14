# Grail Velocity

Chromium MV3 overlay. Reads eBay sold tape as you. Keeps only high-match comps. Writes Fast-Cash on Revise.

## Status

High-match tape + instant typeahead (v1.1.0)

- [x] Stop scraping when sold titles fall off the original search (eBay relevance cliff)
- [x] Price only verified matches at 72%+ identity (set, #, print run, player) — cheap near-misses never enter Fast-Cash
- [x] Character-by-character typeahead from retained tape (no new tab until you submit)
- [x] Verified prices: Chrome tape + optional Postgres
- [x] Rejected / cliff noise: SQLite scratch (7-day TTL)

## Load

1. Download the zip: https://github.com/meltoniallc/grail-velocity-extension/releases/latest/download/grail-velocity-extension.zip
2. Unzip. Open the `grail-velocity` folder (`manifest.json` must be in it).
3. chrome://extensions → Developer mode → Load unpacked → that folder.

## What gets kept

eBay sold search pads later rows with related junk. Grail Velocity scores each title in page order against the original query:

- Player, year, distinctive set (Mercury vs Prizm), card `#`, print-run `/99`, and parallel must match when the query has them
- Copy number `74/99` vs `12/99` of the **same** card still counts
- After three consecutive misses (or four from a cold start), it **stops**. Later rows are cliffed, not priced
- Overlay lists verified solds only. "Show dropped" is opt-in

Fast-Cash needs two tight comps (85%+) or three verified. One weak $5 lot cannot pull the tape.

## Instant typeahead

Type in the popup, side panel, or overlay. Each character queries the local tape (previous high-match scans + book). Submit or click a hit to open solds. Page-switching reuses the cached tape so Fast-Cash is already there when the next sold page loads.

## Tape server (Postgres + SQLite)

Optional. The extension works without it. With it, verified prices persist in Postgres and rejected titles land in SQLite.

```bash
npm install
DATABASE_URL=postgres://… TAPE_SECRET=$(openssl rand -hex 32) SQLITE_PATH=./data/scratch.sqlite npm run tape
```

- `POST /tape` — verified snapshot → Postgres; rejected listings → SQLite
- `GET /suggest?q=` — prefix lookup on retained snapshots
- `GET /health`

In the extension: **Options → Tape API** `http://127.0.0.1:8787` and the same secret.

Chrome storage still answers typeahead instantly. Postgres is retention. SQLite is disposable noise (pruned after 7 days).
