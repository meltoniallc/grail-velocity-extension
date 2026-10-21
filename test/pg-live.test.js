"use strict";

// Real Postgres check. Skipped unless TEST_DATABASE_URL is set (CI has no Postgres).
// Uses throwaway tables in a dedicated schema; never touches production data.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ensurePostgresMigrations, writePostgres, suggestPostgres, getTapePostgres } = require("../server/store");

const URL_ = process.env.TEST_DATABASE_URL || "";

test("postgres: migrations v1-v4, batched upsert, suggest + pull", { skip: !URL_ && "TEST_DATABASE_URL not set" }, async () => {
  const { Pool } = require("pg");
  const schema = `gv_test_${process.pid}`;
  const admin = new Pool({ connectionString: URL_, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_, max: 4, options: `-c search_path=${schema},public` });
  try {
    const mig = await ensurePostgresMigrations(pool);
    assert.equal(mig.latest, 4);
    const { rows: tables } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
      [schema],
    );
    const tableNames = tables.map((r) => r.table_name);
    for (const t of ["observations", "cards", "comps", "sku_mappings", "schema_migrations"]) {
      assert.ok(tableNames.includes(t), `${t} created`);
    }
    const { rows: verCol } = await pool.query(
      "SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'schema_migrations' AND column_name = 'version'",
      [schema],
    );
    assert.equal(verCol[0].data_type, "integer");
    const { rows: idx } = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY 1",
      [schema],
    );
    const names = idx.map((r) => r.indexname);
    assert.ok(names.includes("tape_snapshots_norm_prefix_idx"));
    assert.ok(names.includes("verified_prices_query_seen_idx"));
    const comps = [
      { id: "1", title: "a", price: 10, matchScore: 0.9, soldDate: "Sold Oct 1, 2026" },
      { id: "2", title: "b", price: 20, matchScore: 0.95 },
      { id: "1", title: "a-dup", price: 12, matchScore: 0.9 },
    ];
    const q = "2023 Topps Chrome 100% Wemby #1";
    const norm = "2023 topps chrome 100 wemby #1";
    await writePostgres(pool, { query: q, queryNorm: norm, comps, nKept: 3, fastCash: 9 });
    await writePostgres(pool, { query: q, queryNorm: norm, comps: comps.slice(1), nKept: 2, fastCash: 9 });
    const pulled = await getTapePostgres(pool, norm);
    assert.equal(pulled.verifiedPrices.length, 2);
    assert.equal(pulled.verifiedPrices.find((p) => p.itemId === "1").price, 12);
    assert.equal((await suggestPostgres(pool, "100%", 8)).length, 1, "literal % still matches");
    assert.equal((await suggestPostgres(pool, "1_0", 8)).length, 0, "_ is not a wildcard");
    assert.equal((await suggestPostgres(pool, "topps", 8)).length, 1);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test("postgres: DB with the PR #7 TEXT tracker and observe tables migrates cleanly", { skip: !URL_ && "TEST_DATABASE_URL not set" }, async () => {
  const { Pool } = require("pg");
  const schema = `gv_legacy_${process.pid}`;
  const admin = new Pool({ connectionString: URL_, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_, max: 2, options: `-c search_path=${schema},public` });
  try {
    await pool.query(`
      CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
      INSERT INTO schema_migrations (version) VALUES ('001');
      CREATE TABLE cards (card_id TEXT PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE);
      CREATE TABLE observations (id BIGSERIAL PRIMARY KEY, site TEXT NOT NULL, page_type TEXT NOT NULL, raw_hash TEXT NOT NULL UNIQUE);
      INSERT INTO observations (site, page_type, raw_hash) VALUES ('ebay', 'item', 'keep-me');
    `);
    const mig = await ensurePostgresMigrations(pool);
    assert.deepEqual(mig.applied, [1, 2, 3, 4]);
    const { rows } = await pool.query("SELECT version, name FROM schema_migrations ORDER BY version");
    assert.deepEqual(rows.map((r) => r.version), [1, 2, 3, 4]);
    const { rows: legacy } = await pool.query("SELECT version FROM schema_migrations_legacy_text");
    assert.deepEqual(legacy.map((r) => r.version), ["001"]);
    const { rows: kept } = await pool.query("SELECT raw_hash FROM observations");
    assert.deepEqual(kept.map((r) => r.raw_hash), ["keep-me"]);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
