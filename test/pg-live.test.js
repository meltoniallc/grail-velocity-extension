"use strict";

// Real Postgres check. Skipped unless TEST_DATABASE_URL is set (CI has no Postgres).
// Uses throwaway tables in a dedicated schema; never touches production data.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ensurePostgresMigrations, writePostgres, suggestPostgres, getTapePostgres } = require("../server/store");

const URL_ = process.env.TEST_DATABASE_URL || "";

test("postgres: migrations v1+v2, batched upsert, suggest + pull", { skip: !URL_ && "TEST_DATABASE_URL not set" }, async () => {
  const { Pool } = require("pg");
  const schema = `gv_test_${process.pid}`;
  const admin = new Pool({ connectionString: URL_, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_, max: 4, options: `-c search_path=${schema},public` });
  try {
    const mig = await ensurePostgresMigrations(pool);
    assert.equal(mig.latest, 2);
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
