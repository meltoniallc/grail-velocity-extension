"use strict";

const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");

const SCRATCH_TTL_MS = 7 * 24 * 3600 * 1000;

function openScratch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_listings (
      id INTEGER PRIMARY KEY,
      query_norm TEXT NOT NULL,
      query_raw TEXT,
      title TEXT,
      price REAL,
      match_score REAL,
      flags TEXT,
      reason TEXT,
      keep INTEGER DEFAULT 0,
      beyond_cliff INTEGER DEFAULT 0,
      scraped_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS page_scans (
      id INTEGER PRIMARY KEY,
      query_norm TEXT NOT NULL,
      query_raw TEXT,
      url TEXT,
      n_raw INTEGER,
      n_kept INTEGER,
      n_cliff INTEGER,
      stopped_at INTEGER,
      scraped_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS raw_listings_query_idx ON raw_listings(query_norm);
    CREATE INDEX IF NOT EXISTS raw_listings_scraped_idx ON raw_listings(scraped_at);
  `);
  return db;
}

function pruneScratch(db, now = Date.now()) {
  const cutoff = now - SCRATCH_TTL_MS;
  db.prepare("DELETE FROM raw_listings WHERE scraped_at < ?").run(cutoff);
  db.prepare("DELETE FROM page_scans WHERE scraped_at < ?").run(cutoff);
}

function writeScratch(db, payload) {
  const now = Date.now();
  pruneScratch(db, now);
  const scratch = payload.scratch || {};
  const snap = payload.snapshot || {};
  const queryRaw = snap.query || scratch.query || "";
  const queryNorm = snap.queryNorm || scratch.queryNorm || queryRaw.toLowerCase();
  const listings = scratch.listings || [];
  const insert = db.prepare(`
    INSERT INTO raw_listings
      (query_norm, query_raw, title, price, match_score, flags, reason, keep, beyond_cliff, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);
  const scan = db.prepare(
    `INSERT INTO page_scans (query_norm, query_raw, url, n_raw, n_kept, n_cliff, stopped_at, scraped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of listings) {
    const flags = Array.isArray(row.flags) ? row.flags : [];
    insert.run(
      queryNorm,
      queryRaw,
      row.title || "",
      row.price ?? null,
      row.matchScore ?? null,
      flags.join(","),
      row.reason || "",
      flags.includes("beyond_cliff") ? 1 : 0,
      now,
    );
  }
  scan.run(
    queryNorm,
    queryRaw,
    snap.url || scratch.url || "",
    snap.nRaw ?? listings.length,
    snap.nKept ?? 0,
    snap.nCliff ?? 0,
    null,
    now,
  );
}

function postgresSchema() {
  return `
    CREATE TABLE IF NOT EXISTS verified_prices (
      query_norm TEXT NOT NULL,
      item_id TEXT NOT NULL,
      query_raw TEXT NOT NULL,
      title TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL,
      match_score NUMERIC(5,4) NOT NULL,
      sold_date TEXT,
      url TEXT,
      seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (query_norm, item_id)
    );
    CREATE TABLE IF NOT EXISTS tape_snapshots (
      query_norm TEXT PRIMARY KEY,
      query_raw TEXT NOT NULL,
      n_kept INT,
      n_raw INT,
      n_cliff INT,
      median NUMERIC,
      p25 NUMERIC,
      p75 NUMERIC,
      fast_cash NUMERIC,
      comps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS verified_prices_query_idx ON verified_prices (query_norm);
    CREATE INDEX IF NOT EXISTS tape_snapshots_prefix_idx ON tape_snapshots (query_raw);
  `;
}

async function writePostgres(pool, snapshot) {
  if (!pool || !snapshot) return { ok: false, skipped: "no-postgres" };
  const comps = snapshot.comps || [];
  await pool.query(postgresSchema());
  await pool.query(
    `INSERT INTO tape_snapshots
      (query_norm, query_raw, n_kept, n_raw, n_cliff, median, p25, p75, fast_cash, comps_json, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, now())
     ON CONFLICT (query_norm) DO UPDATE SET
      query_raw = EXCLUDED.query_raw,
      n_kept = EXCLUDED.n_kept,
      n_raw = EXCLUDED.n_raw,
      n_cliff = EXCLUDED.n_cliff,
      median = EXCLUDED.median,
      p25 = EXCLUDED.p25,
      p75 = EXCLUDED.p75,
      fast_cash = EXCLUDED.fast_cash,
      comps_json = EXCLUDED.comps_json,
      updated_at = now()`,
    [
      snapshot.queryNorm,
      snapshot.query,
      snapshot.nKept,
      snapshot.nRaw,
      snapshot.nCliff,
      snapshot.median,
      snapshot.p25,
      snapshot.p75,
      snapshot.fastCash,
      JSON.stringify(comps),
    ],
  );
  for (const comp of comps) {
    await pool.query(
      `INSERT INTO verified_prices
        (query_norm, item_id, query_raw, title, price, match_score, sold_date, url, seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (query_norm, item_id) DO UPDATE SET
        title = EXCLUDED.title,
        price = EXCLUDED.price,
        match_score = EXCLUDED.match_score,
        sold_date = EXCLUDED.sold_date,
        url = EXCLUDED.url,
        seen_at = now()`,
      [
        snapshot.queryNorm,
        String(comp.id || ""),
        snapshot.query,
        comp.title,
        comp.price,
        comp.matchScore,
        comp.soldDate || null,
        comp.url || null,
      ],
    );
  }
  return { ok: true, nKept: comps.length };
}

async function suggestPostgres(pool, q, limit) {
  if (!pool) return [];
  const needle = String(q || "").trim();
  if (!needle) return [];
  const { rows } = await pool.query(
    `SELECT query_raw, n_kept, fast_cash, updated_at
       FROM tape_snapshots
      WHERE query_raw ILIKE $1 OR query_norm LIKE lower($2) || '%'
      ORDER BY updated_at DESC
      LIMIT $3`,
    [`%${needle}%`, needle.toLowerCase(), limit],
  );
  return rows.map((row) => ({
    kind: "tape",
    query: row.query_raw,
    title: row.query_raw,
    fastCash: row.fast_cash == null ? null : Number(row.fast_cash),
    nKept: row.n_kept,
  }));
}

module.exports = {
  openScratch,
  writeScratch,
  pruneScratch,
  postgresSchema,
  writePostgres,
  suggestPostgres,
  SCRATCH_TTL_MS,
};
