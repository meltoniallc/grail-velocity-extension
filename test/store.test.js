"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  openScratch,
  writeScratch,
  getTapePostgres,
  getScratchSqlite,
  scratchBucket,
  tapeQueryNorm,
  SCRATCH_TTL_MS,
  ensurePostgresSchema,
  ensurePostgresMigrations,
  PG_MIGRATIONS,
  schemaMigrationsDdl,
  writePostgres,
} = require("../server/store");
const { loadScripts } = require("./load-core");

const { GV, GVTape } = loadScripts(["lib/core.js", "lib/tape.js"]);

test("sqlite scratch keeps rejected noise off the verified tape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-scratch-"));
  const db = openScratch(path.join(dir, "scratch.sqlite"));
  const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
  const verified = GV.verifyComps(query, [
    { id: "a", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99", price: 120 },
    { id: "b", title: "2023 Panini Prizm Victor Wembanyama #5 Silver", price: 4.99 },
    { id: "c", title: "Wembanyama mystery grab bag", price: 1 },
  ]);
  const adapter = {
    async load() {
      return { snapshots: [], scratch: [] };
    },
    async saveSnapshots() {},
    async saveScratch() {},
  };
  const mem = { snapshots: [], scratch: [] };
  adapter.load = async () => mem;
  adapter.saveSnapshots = async (s) => {
    mem.snapshots = s;
  };
  adapter.saveScratch = async (s) => {
    mem.scratch = s;
  };
  return GVTape.create(adapter)
    .putScan({ query, verified, velocity: { fastCashPrice: 117.6 } })
    .then((snap) => {
      writeScratch(db, {
        snapshot: snap,
        scratch: mem.scratch[0],
      });
      const noise = db.prepare("SELECT title, beyond_cliff FROM raw_listings ORDER BY id").all();
      assert.ok(noise.some((r) => /Prizm/i.test(r.title)));
      assert.equal(
        noise.every((r) => !/Mercury Victor Wembanyama #5 Refractor 11\/99/i.test(r.title)),
        true,
      );
      assert.ok(snap.comps.every((c) => c.price >= 100));
    });
});

test("page_scans persists capture meta including stopped_at", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-scratch-meta-"));
  const db = openScratch(path.join(dir, "scratch.sqlite"));
  const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
  const mem = { snapshots: [], scratch: [] };
  const adapter = {
    async load() {
      return mem;
    },
    async saveSnapshots(s) {
      mem.snapshots = s;
    },
    async saveScratch(s) {
      mem.scratch = s;
    },
  };
  const verified = GV.verifyComps(query, [
    { id: "a", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99", price: 120 },
    { id: "b", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 22/99", price: 110 },
    { id: "c", title: "Wembanyama mystery grab bag", price: 1 },
    { id: "d", title: "Random bulk commons lot", price: 2 },
    { id: "e", title: "Another junk listing", price: 3 },
    { id: "f", title: "Yet more noise", price: 4 },
  ]);
  const snap = await GVTape.create(adapter).putScan({
    query,
    verified,
    mode: "auto",
    pageMode: "sold",
    stoppedAt: verified.stoppedAt,
    nCliff: verified.nCliff,
    url: "https://www.ebay.com/sch/i.html?LH_Sold=1&_nkw=test",
  });
  writeScratch(db, { snapshot: snap, scratch: mem.scratch[0] });
  const scan = db
    .prepare(
      "SELECT mode, page_mode, stopped_at, n_cliff, n_kept FROM page_scans ORDER BY id DESC LIMIT 1",
    )
    .get();
  assert.equal(scan.mode, "auto");
  assert.equal(scan.page_mode, "sold");
  assert.equal(scan.stopped_at, verified.stoppedAt);
  assert.ok(scan.n_cliff >= 1);
  assert.ok(scan.n_kept >= 1);
  assert.equal(mem.scratch[0].mode, "auto");
  assert.equal(mem.scratch[0].pageMode, "sold");
  assert.equal(mem.scratch[0].stoppedAt, verified.stoppedAt);
});

test("getScratchSqlite returns last N reasons without touching postgres", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-scratch-get-"));
  const db = openScratch(path.join(dir, "scratch.sqlite"));
  const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
  const norm = tapeQueryNorm(query);
  writeScratch(db, {
    snapshot: { query, queryNorm: norm, nRaw: 3, nKept: 0, nCliff: 1 },
    scratch: {
      query,
      queryNorm: norm,
      mode: "manual",
      pageMode: "sold",
      nCliff: 1,
      listings: [
        {
          id: "live",
          title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99",
          price: 150,
          kind: "active",
          keep: true,
          flags: [],
          reason: "Tight title match",
        },
        {
          id: "weak",
          title: "Mercury Wemby near miss",
          price: 40,
          kind: "dropped",
          flags: ["weak_title"],
          reason: "weak_title",
        },
        {
          id: "cliff",
          title: "Random bulk commons lot",
          price: 2,
          kind: "dropped",
          flags: ["beyond_cliff"],
          reason: "Past eBay relevance cliff",
        },
      ],
    },
  });
  const pulled = getScratchSqlite(db, query, 10);
  assert.equal(pulled.source, "sqlite");
  assert.equal(pulled.queryNorm, norm);
  assert.equal(pulled.listings.length, 3);
  assert.equal(scratchBucket(pulled.listings.find((l) => /bulk/i.test(l.title))), "cliff");
  assert.equal(scratchBucket(pulled.listings.find((l) => /near miss/i.test(l.title))), "weak_title");
  assert.equal(scratchBucket(pulled.listings.find((l) => /Refractor 11\/99/i.test(l.title))), "active");
  assert.ok(pulled.scans.length >= 1);
  assert.equal(pulled.scans[0].mode, "manual");
  assert.ok(SCRATCH_TTL_MS === 7 * 24 * 3600 * 1000);
});

test("getTapePostgres returns snapshot + verified_prices for one query_norm", async () => {
  const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
  const norm = tapeQueryNorm(query);
  assert.equal(norm, GV.fold(query));
  const empty = await getTapePostgres(null, query);
  assert.equal(empty.source, "none");
  assert.equal(empty.snapshot, null);

  const calls = [];
  const applied = new Set();
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return { rows: [] };
      if (/SELECT version FROM schema_migrations/i.test(sql)) {
        return { rows: [...applied].map((version) => ({ version })) };
      }
      if (/INSERT INTO schema_migrations/i.test(sql)) {
        applied.add(Number(params[0]));
        return { rows: [] };
      }
      if (/CREATE TABLE/i.test(sql)) return { rows: [] };
      if (/FROM tape_snapshots/i.test(sql)) {
        assert.equal(params[0], norm);
        return {
          rows: [
            {
              query_norm: norm,
              query_raw: query,
              n_kept: 2,
              n_raw: 4,
              n_cliff: 1,
              median: 115,
              p25: 110,
              p75: 120,
              fast_cash: 107.8,
              comps_json: [
                {
                  id: "a",
                  title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99",
                  price: 120,
                  matchScore: 0.95,
                  kind: "sold",
                  soldDate: "Sold Mar 1, 2026",
                },
              ],
              updated_at: new Date("2026-03-10T00:00:00Z"),
            },
          ],
        };
      }
      if (/FROM verified_prices/i.test(sql)) {
        assert.equal(params[0], norm);
        return {
          rows: [
            {
              query_norm: norm,
              item_id: "b",
              query_raw: query,
              title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 22/99",
              price: "110.00",
              match_score: "0.9300",
              sold_date: "Sold Mar 2, 2026",
              url: "https://www.ebay.com/itm/b",
              seen_at: new Date("2026-03-10T00:00:00Z"),
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
  const pulled = await getTapePostgres(pool, query);
  assert.equal(pulled.source, "postgres");
  assert.ok(pulled.snapshot);
  assert.equal(pulled.snapshot.queryNorm, norm);
  assert.equal(pulled.snapshot.fastCash, 107.8);
  assert.equal(pulled.snapshot.comps.length, 1);
  assert.equal(pulled.verifiedPrices.length, 1);
  assert.equal(pulled.verifiedPrices[0].itemId, "b");
  assert.equal(pulled.verifiedPrices[0].price, 110);
  assert.ok(calls.some((c) => /FROM tape_snapshots/i.test(c.sql)));
  assert.ok(calls.some((c) => /FROM verified_prices/i.test(c.sql)));
  assert.ok(applied.has(1), "pull path runs additive migrations first");
});

test("ensurePostgresSchema is a no-op without PG_SCHEMA and creates grail_tape when set", async () => {
  const sqlLog = [];
  const pool = {
    async query(sql) {
      sqlLog.push(String(sql));
      return { rows: [] };
    },
  };
  const none = await ensurePostgresSchema(pool, {});
  assert.equal(none.schema, null);
  assert.equal(sqlLog.length, 0);
  const created = await ensurePostgresSchema(pool, { PG_SCHEMA: "grail_tape" });
  assert.equal(created.schema, "grail_tape");
  assert.ok(sqlLog.some((s) => /CREATE SCHEMA IF NOT EXISTS "grail_tape"/i.test(s)));
  assert.ok(sqlLog.some((s) => /SET search_path TO "grail_tape", public/i.test(s)));
});

test("ensurePostgresMigrations applies v1-v4 once and is idempotent", async () => {
  assert.ok(PG_MIGRATIONS.length >= 1);
  assert.equal(PG_MIGRATIONS[0].version, 1);
  assert.match(schemaMigrationsDdl(), /schema_migrations/);

  const applied = new Set();
  const sqlLog = [];
  const pool = {
    async query(sql, params) {
      sqlLog.push(String(sql));
      if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return { rows: [] };
      if (/SELECT version FROM schema_migrations/i.test(sql)) {
        return { rows: [...applied].map((version) => ({ version })) };
      }
      if (/INSERT INTO schema_migrations/i.test(sql)) {
        applied.add(Number(params[0]));
        return { rows: [] };
      }
      if (/CREATE TABLE IF NOT EXISTS verified_prices/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };

  const first = await ensurePostgresMigrations(pool);
  assert.equal(first.ok, true);
  assert.deepEqual(first.applied, [1, 2, 3, 4]);
  assert.equal(first.latest, 4);
  assert.equal(first.schema, null);

  const second = await ensurePostgresMigrations(pool);
  assert.equal(second.ok, true);
  assert.deepEqual(second.applied, []);
  assert.equal(applied.size, 4);

  const inserts = sqlLog.filter((s) => /INSERT INTO schema_migrations/i.test(s));
  assert.equal(inserts.length, 4);
  // Memoized per pool: the second call issues no SQL at all.
  const before = sqlLog.length;
  await ensurePostgresMigrations(pool);
  assert.equal(sqlLog.length, before);
});

test("writePostgres runs migrations before upserting verified solds", async () => {
  const applied = new Set();
  const statements = [];
  const pool = {
    async query(sql, params) {
      statements.push({ sql: String(sql), params });
      if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return { rows: [] };
      if (/SELECT version FROM schema_migrations/i.test(sql)) {
        return { rows: [...applied].map((version) => ({ version })) };
      }
      if (/INSERT INTO schema_migrations/i.test(sql)) {
        applied.add(Number(params[0]));
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const result = await writePostgres(pool, {
    query: "q",
    queryNorm: "q",
    nKept: 1,
    nRaw: 1,
    nCliff: 0,
    median: 100,
    p25: 100,
    p75: 100,
    fastCash: 98,
    comps: [
      {
        id: "1",
        title: "sold",
        price: 100,
        matchScore: 0.9,
        soldDate: "Sold Mar 1, 2026",
        kind: "sold",
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.ok(applied.has(1));
  const migIdx = statements.findIndex((s) => /INSERT INTO schema_migrations/i.test(s.sql));
  const snapIdx = statements.findIndex((s) => /INSERT INTO tape_snapshots/i.test(s.sql));
  assert.ok(migIdx >= 0 && snapIdx > migIdx, "migrations before tape_snapshots write");
});
