# Grail Velocity

Chromium MV3 overlay. Reads eBay sold tape as you. Fast-Cash is **sold tape only**.

## Status

**v1.2.1**

- Fast-Cash chip says **TAPE** or **NO TAPE**. Catalog book price is labeled Book ref and cannot be Applied.
- Scrape any eBay tab. Live BIN/asks never write Fast-Cash.
- High-match keep (72%+). Cliff after 3 consecutive misses.
- Optional tape server (Postgres + SQLite). Extension works without it.

## Load

1. Download: https://github.com/meltoniallc/grail-velocity-extension/releases/latest/download/grail-velocity-extension.zip
   Or from a checkout: `npm run package` → `dist/grail-velocity-extension.zip`
2. Unzip. Open the `grail-velocity` folder (`manifest.json` must be in it).
3. chrome://extensions → Developer mode → Load unpacked → that folder.

## What the numbers are

| Field | Source |
|---|---|
| Fast-Cash **TAPE** | P25 × 0.98 of verified **sold** comps on/cached for this query |
| Fast-Cash **NO TAPE** | No price. Open solds and scrape. |
| Book ref | Stale catalog ask from `catalog.json`. Display only. |
| Listed | Your book BIN, or the live ask on a listing |
| kept / dropped | Title identity vs the search (set, #, print run, player) |

Need 2 tight (85%+) or 3 verified solds. One cheap near-miss cannot pull the tape.

## Tape server (optional)

```bash
npm install
DATABASE_URL=postgres://… TAPE_SECRET=$(openssl rand -hex 32) SQLITE_PATH=./data/scratch.sqlite npm run tape
```

Options → Tape API `http://127.0.0.1:8787` + the printed secret. Skip this unless you want Postgres retention.
