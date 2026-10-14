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
      scraped_at INTEGER NOT NULL,
      mode TEXT,
      page_mode TEXT
    );
    CREATE INDEX IF NOT EXISTS raw_listings_query_idx ON raw_listings(query_norm);
    CREATE INDEX IF NOT EXISTS raw_listings_scraped_idx ON raw_listings(scraped_at);
  `);
  ensurePageScanMetaColumns(db);
  ensureRawListingKindColumn(db);
  return db;
}

/** Additive columns for older scratch DBs created before capture-meta. */
function ensurePageScanMetaColumns(db) {
  const cols = db.prepare("PRAGMA table_info(page_scans)").all().map((c) => c.name);
  if (!cols.includes("mode")) {
    db.exec("ALTER TABLE page_scans ADD COLUMN mode TEXT");
  }
  if (!cols.includes("page_mode")) {
    db.exec("ALTER TABLE page_scans ADD COLUMN page_mode TEXT");
  }
}

/** Additive kind column so GET /scratch can label active asks vs drops. */
function ensureRawListingKindColumn(db) {
  const cols = db.prepare("PRAGMA table_info(raw_listings)").all().map((c) => c.name);
  if (!cols.includes("kind")) {
    db.exec("ALTER TABLE raw_listings ADD COLUMN kind TEXT");
  }
}

function pruneScratch(db, now = Date.now()) {
  const cutoff = now - SCRATCH_TTL_MS;
  db.prepare("DELETE FROM raw_listings WHERE scraped_at < ?").run(cutoff);
  db.prepare("DELETE FROM page_scans WHERE scraped_at < ?").run(cutoff);
}

function captureMetaFromPayload(payload) {
  const scratch = payload.scratch || {};
  const snap = payload.snapshot || {};
  const mode = scratch.mode || snap.mode || null;
  const pageMode = scratch.pageMode || snap.pageMode || null;
  const stoppedAt =
    scratch.stoppedAt != null
      ? scratch.stoppedAt
      : snap.stoppedAt != null
        ? snap.stoppedAt
        : null;
  const nCliff =
    scratch.nCliff != null ? scratch.nCliff : snap.nCliff != null ? snap.nCliff : 0;
  return { mode, pageMode, stoppedAt, nCliff };
}

function writeScratch(db, payload) {
  const now = Date.now();
  pruneScratch(db, now);
  ensurePageScanMetaColumns(db);
  ensureRawListingKindColumn(db);
  const scratch = payload.scratch || {};
  const snap = payload.snapshot || {};
  const meta = captureMetaFromPayload(payload);
  const queryRaw = snap.query || scratch.query || "";
  const queryNorm = snap.queryNorm || scratch.queryNorm || queryRaw.toLowerCase();
  const listings = scratch.listings || [];
  const insert = db.prepare(`
    INSERT INTO raw_listings
      (query_norm, query_raw, title, price, match_score, flags, reason, keep, beyond_cliff, scraped_at, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);
  const scan = db.prepare(
    `INSERT INTO page_scans
      (query_norm, query_raw, url, n_raw, n_kept, n_cliff, stopped_at, scraped_at, mode, page_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of listings) {
    const flags = Array.isArray(row.flags) ? row.flags : [];
    const kind = row.kind || (row.keep ? "active" : "dropped");
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
      kind,
    );
  }
  scan.run(
    queryNorm,
    queryRaw,
    snap.url || scratch.url || "",
    snap.nRaw ?? listings.length,
    snap.nKept ?? 0,
    meta.nCliff ?? snap.nCliff ?? 0,
    meta.stoppedAt,
    now,
    meta.mode,
    meta.pageMode,
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

/**
 * Ordered additive Postgres migrations. Version 1 = base create-if-not-exists.
 * Later versions must be additive only (ADD COLUMN IF NOT EXISTS, new indexes).
 * Do not drop or rename columns here without a dedicated matching PR.
 */
const PG_MIGRATIONS = [
  {
    version: 1,
    name: "base_verified_prices_and_tape_snapshots",
    sql: postgresSchema(),
  },
];

function schemaMigrationsDdl() {
  return `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;
}

/**
 * Apply pending additive migrations via schema_migrations version table.
 * Idempotent: already-applied versions are skipped.
 */
async function ensurePostgresMigrations(pool) {
  if (!pool) return { ok: false, skipped: "no-postgres", applied: [] };
  await pool.query(schemaMigrationsDdl());
  const { rows } = await pool.query("SELECT version FROM schema_migrations");
  const have = new Set((rows || []).map((r) => Number(r.version)));
  const applied = [];
  for (const mig of PG_MIGRATIONS) {
    if (have.has(mig.version)) continue;
    await pool.query(mig.sql);
    await pool.query(
      "INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
      [mig.version, mig.name],
    );
    applied.push(mig.version);
  }
  return { ok: true, applied, latest: PG_MIGRATIONS[PG_MIGRATIONS.length - 1]?.version || 0 };
}

async function writePostgres(pool, snapshot) {
  if (!pool || !snapshot) return { ok: false, skipped: "no-postgres" };
  const comps = snapshot.comps || [];
  await ensurePostgresMigrations(pool);
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
    score: 0.25,
    query: row.query_raw,
    title: row.query_raw,
    fastCash: row.fast_cash == null ? null : Number(row.fast_cash),
    nKept: row.n_kept,
    at: row.updated_at ? new Date(row.updated_at).getTime() : undefined,
  }));
}

/** Normalize q for exact tape_snapshots.query_norm lookup (client usually sends GV.fold). */
function tapeQueryNorm(q) {
  return String(q || "")
    .toLowerCase()
    .replace(/[^a-z0-9#/.\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCompsJson(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null) return [];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Classify one scratch listing into an operator bucket.
 * cliff / weak_title / active — never durable Fast-Cash.
 */
function scratchBucket(row) {
  const flagsRaw = row && row.flags;
  const flags = Array.isArray(flagsRaw)
    ? flagsRaw
    : String(flagsRaw || "")
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
  const kind = row && row.kind;
  if (kind === "active" || (row && row.keep && !flags.includes("beyond_cliff"))) {
    return "active";
  }
  if (flags.includes("beyond_cliff") || row?.beyond_cliff === 1 || row?.beyondCliff) {
    return "cliff";
  }
  if (flags.includes("weak_title")) return "weak_title";
  return flags[0] || (row && row.reason) || "dropped";
}

/**
 * Read last N scratch rows for one query_norm from SQLite (debug / inspect).
 * Prunes expired rows first; TTL stays SCRATCH_TTL_MS (7d). Never touches Postgres.
 */
function getScratchSqlite(db, q, limit = 40) {
  pruneScratch(db);
  const norm = tapeQueryNorm(q);
  const lim = Number.isFinite(Number(limit))
    ? Math.min(100, Math.max(1, Math.floor(Number(limit))))
    : 40;
  if (!norm) {
    return { queryNorm: "", listings: [], scans: [], source: "sqlite" };
  }
  ensureRawListingKindColumn(db);
  const listings = db
    .prepare(
      `SELECT id, query_norm, query_raw, title, price, match_score, flags, reason, keep,
              beyond_cliff, scraped_at, kind
         FROM raw_listings
        WHERE query_norm = ?
        ORDER BY scraped_at DESC, id DESC
        LIMIT ?`,
    )
    .all(norm, lim)
    .map((row) => {
      const flags = String(row.flags || "")
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
      const kind = row.kind || (row.keep ? "active" : "dropped");
      const listing = {
        id: row.id,
        queryNorm: row.query_norm,
        queryRaw: row.query_raw,
        title: row.title,
        price: row.price == null ? null : Number(row.price),
        matchScore: row.match_score == null ? null : Number(row.match_score),
        flags,
        reason: row.reason || "",
        keep: Boolean(row.keep),
        beyondCliff: Boolean(row.beyond_cliff),
        kind,
        at: row.scraped_at,
      };
      listing.bucket = scratchBucket(listing);
      return listing;
    });
  const scans = db
    .prepare(
      `SELECT id, query_norm, query_raw, url, n_raw, n_kept, n_cliff, stopped_at,
              scraped_at, mode, page_mode
         FROM page_scans
        WHERE query_norm = ?
        ORDER BY scraped_at DESC, id DESC
        LIMIT ?`,
    )
    .all(norm, Math.min(20, lim))
    .map((row) => ({
      id: row.id,
      queryNorm: row.query_norm,
      queryRaw: row.query_raw,
      url: row.url || "",
      nRaw: row.n_raw,
      nKept: row.n_kept,
      nCliff: row.n_cliff,
      stoppedAt: row.stopped_at,
      at: row.scraped_at,
      mode: row.mode || null,
      pageMode: row.page_mode || null,
    }));
  return { queryNorm: norm, listings, scans, source: "sqlite" };
}

/**
 * Pull one query_norm from Postgres: tape_snapshots + verified_prices.
 * Never reads SQLite scratch — Fast-Cash hydrate stays verified-sold only.
 */
async function getTapePostgres(pool, q) {
  if (!pool) return { snapshot: null, verifiedPrices: [], source: "none" };
  const norm = tapeQueryNorm(q);
  if (!norm) return { snapshot: null, verifiedPrices: [], source: "postgres" };
  await ensurePostgresMigrations(pool);
  const snapRes = await pool.query(
    `SELECT query_norm, query_raw, n_kept, n_raw, n_cliff, median, p25, p75, fast_cash, comps_json, updated_at
       FROM tape_snapshots
      WHERE query_norm = $1
      LIMIT 1`,
    [norm],
  );
  const row = snapRes.rows[0] || null;
  const pricesRes = await pool.query(
    `SELECT query_norm, item_id, query_raw, title, price, match_score, sold_date, url, seen_at
       FROM verified_prices
      WHERE query_norm = $1
      ORDER BY seen_at DESC`,
    [norm],
  );
  const verifiedPrices = (pricesRes.rows || []).map((p) => ({
    queryNorm: p.query_norm,
    itemId: String(p.item_id || ""),
    queryRaw: p.query_raw,
    title: p.title,
    price: p.price == null ? null : Number(p.price),
    matchScore: p.match_score == null ? null : Number(p.match_score),
    soldDate: p.sold_date || null,
    url: p.url || null,
    seenAt: p.seen_at ? new Date(p.seen_at).getTime() : null,
  }));
  if (!row && !verifiedPrices.length) {
    return { snapshot: null, verifiedPrices: [], source: "postgres" };
  }
  const comps = parseCompsJson(row && row.comps_json);
  const snapshot = row
    ? {
        query: row.query_raw,
        queryNorm: row.query_norm,
        title: row.query_raw,
        nKept: row.n_kept,
        nRaw: row.n_raw,
        nCliff: row.n_cliff,
        median: row.median == null ? null : Number(row.median),
        p25: row.p25 == null ? null : Number(row.p25),
        p75: row.p75 == null ? null : Number(row.p75),
        fastCash: row.fast_cash == null ? null : Number(row.fast_cash),
        comps,
        at: row.updated_at ? new Date(row.updated_at).getTime() : undefined,
      }
    : {
        query: verifiedPrices[0].queryRaw || q,
        queryNorm: norm,
        title: verifiedPrices[0].queryRaw || q,
        nKept: verifiedPrices.length,
        nRaw: verifiedPrices.length,
        nCliff: 0,
        median: null,
        p25: null,
        p75: null,
        fastCash: null,
        comps: [],
        at: verifiedPrices[0].seenAt || undefined,
      };
  return { snapshot, verifiedPrices, source: "postgres" };
}

module.exports = {
  openScratch,
  writeScratch,
  pruneScratch,
  ensurePageScanMetaColumns,
  captureMetaFromPayload,
  postgresSchema,
  schemaMigrationsDdl,
  PG_MIGRATIONS,
  ensurePostgresMigrations,
  writePostgres,
  suggestPostgres,
  getTapePostgres,
  getScratchSqlite,
  scratchBucket,
  ensureRawListingKindColumn,
  tapeQueryNorm,
  parseCompsJson,
  SCRATCH_TTL_MS,
};
