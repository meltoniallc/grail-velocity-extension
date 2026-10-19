# Latency bench — 2.0.0 (main fe30479) vs 2.0.1

Box: Linux x86_64, Node 22.20, local Postgres 17 (20k seeded tape_snapshots / 200k verified_prices), SQLite scratch. p50 / p95 in ms. No eBay traffic — synthetic payloads only. `SW` rows run the real `background.js` in a vm with stubbed `chrome.*`.

## SQLite only (no DATABASE_URL)

| Path | before | after |
|---|---|---|
| POST /tape (40 comps + 60 scratch) | 19.45 / 28.36 | 1.12 / 2.35 |
| GET /suggest (no pg) | 0.33 / 0.68 | 0.29 / 0.67 |
| GET /tape pull (1 query_norm) | 0.3 / 0.82 | 0.26 / 0.66 |
| SW GV_TAPE_PUT (capture -> response) | 18.51 / 26.59 | 9.03 / 14.9 |
| SW GV_SUGGEST typeahead (local tape ≤80 + remote fill) | 5.38 / 6.67 | 0.63 / 1.29 |
| SW GV_TAPE_GET cold (hydrate from server) | 4.84 / 5.69 | 0.4 / 0.99 |
| GET /tape bytes on the wire (gzip) | 63 | 63 |

## Postgres, localhost

| Path | before | after |
|---|---|---|
| POST /tape (40 comps + 60 scratch) | 32.75 / 42.52 | 3.34 / 5.38 |
| GET /suggest (20000 snapshots) | 13.51 / 16.2 | 2.2 / 14.2 |
| GET /tape pull (1 query_norm) | 1.1 / 2.34 | 1.32 / 1.91 |
| SW GV_TAPE_PUT (capture -> response) | 24.26 / 29.83 | 8.38 / 15.14 |
| SW GV_SUGGEST typeahead (local tape ≤80 + remote fill) | 16.2 / 20.14 | 0.71 / 1.37 |
| SW GV_TAPE_GET cold (hydrate from server) | 13.94 / 16.75 | 6.34 / 8.39 |
| GET /tape bytes on the wire (gzip) | 2665 | 479 |

## Postgres + 80 ms RTT proxy (models a remote/Railway server)

| Path | before | after |
|---|---|---|
| POST /tape (40 comps + 60 scratch) | 114.06 / 137.09 | 86.47 / 90.13 |
| GET /suggest (20000 snapshots) | 96.23 / 99.63 | 84.37 / 87.59 |
| GET /tape pull (1 query_norm) | 84.45 / 85.94 | 84.15 / 85.59 |
| SW GV_TAPE_PUT (capture -> response) | 112.98 / 125.02 | 9.61 / 18.05 |
| SW GV_SUGGEST typeahead (local tape ≤80 + remote fill) | 100.41 / 112.66 | 0.76 / 86.04 |
| SW GV_TAPE_GET cold (hydrate from server) | 97.94 / 104.33 | 89.25 / 92.76 |
| GET /tape bytes on the wire (gzip) | 2678 | 477 |

Notes: SW GV_SUGGEST after-numbers include the 20 s remote-suggest memo (the bench cycles 8 prefixes); a first-time remote prefix still pays one round trip (see p95 in the RTT run). Server-side network RTT itself cannot be removed — the capture path just no longer waits on it.
