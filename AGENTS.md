## Learned User Preferences

- Keep eBay sold comps only at high verified title match (set, card number, print run, player); stop at the eBay relevance cliff so cheap near-misses never pull Fast-Cash down.
- Instant character-by-character typeahead from retained tape; do not open sold tabs on each keystroke.
- Store verified prices in Postgres for retention and fast reference; put rejected and cliff noise in SQLite with a short TTL.
- Copy number of the same print run (74/99 vs 12/99) is a valid comp; wrong set, card number, or print run is not.

## Learned Workspace Facts

- Grail Velocity is a Chromium MV3 overlay (`meltoniallc/grail-velocity-extension`). Matching lives in `lib/core.js`; tape persistence is `lib/tape.js` plus optional `server/` (Postgres + `node:sqlite`).
- Keep threshold is 72% identity; tight comps are 85%+. Cliff after 3 consecutive misses (4 from a cold start). Fast-Cash needs two tight comps or three verified.
- Overlay, popup, and side panel typeahead query local Chrome tape first; optional Tape API is `http://127.0.0.1:8787`. SQLite scratch TTL is 7 days.
- Overlay always exposes Scrape this page (live search, listing, sold). Live BIN/ask prices go to scratch only; Fast-Cash and Postgres stay on verified solds.
- `npm run tape` prints a stable secret from `data/tape.secret` (env wins). Options Check connection hits `/ping`.
