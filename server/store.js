"use strict";

const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");

const SCRATCH_TTL_MS = 7 * 24 * 3600 * 1000;

function openScratch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  // WAL + NORMAL sync: one fsync per checkpoint instead of per row; safe for scratch (7d TTL noise).
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;");
  } catch {
    /* in-memory or read-only DBs may refuse WAL; defaults still work */
  }
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
    CREATE INDEX IF NOT EXISTS page_scans_query_idx ON page_scans(query_norm);
    CREATE INDEX IF NOT EXISTS page_scans_scraped_idx ON page_scans(scraped_at);
  `);
  ensureScratchColumns(db);
  return db;
}

/** Column checks are PRAGMA round trips; run them once per open handle. */
const scratchColumnsChecked = new WeakSet();
function ensureScratchColumns(db) {
  if (scratchColumnsChecked.has(db)) return;
  ensurePageScanMetaColumns(db);
  ensureRawListingKindColumn(db);
  scratchColumnsChecked.add(db);
}

/** Cache prepared statements per DB handle (prepare() is not free on hot paths). */
const stmtCache = new WeakMap();
function stmt(db, sql) {
  let byDb = stmtCache.get(db);
  if (!byDb) {
    byDb = new Map();
    stmtCache.set(db, byDb);
  }
  let st = byDb.get(sql);
  if (!st) {
    st = db.prepare(sql);
    byDb.set(sql, st);
  }
  return st;
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
  stmt(db, "DELETE FROM raw_listings WHERE scraped_at < ?").run(cutoff);
  stmt(db, "DELETE FROM page_scans WHERE scraped_at < ?").run(cutoff);
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
  ensureScratchColumns(db);
  db.exec("BEGIN");
  try {
    writeScratchRows(db, payload);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

/** Body of writeScratch; runs inside one transaction (one commit for prune + N rows + scan). */
function writeScratchRows(db, payload) {
  const now = Date.now();
  pruneScratch(db, now);
  const scratch = payload.scratch || {};
  const snap = payload.snapshot || {};
  const meta = captureMetaFromPayload(payload);
  const queryRaw = snap.query || scratch.query || "";
  const queryNorm = snap.queryNorm || scratch.queryNorm || queryRaw.toLowerCase();
  const listings = scratch.listings || [];
  const insert = stmt(db, `
    INSERT INTO raw_listings
      (query_norm, query_raw, title, price, match_score, flags, reason, keep, beyond_cliff, scraped_at, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);
  const scan = stmt(
    db,
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
  {
    version: 2,
    name: "typeahead_and_pull_indexes",
    sql: migration2Indexes(),
  },
];

/**
 * v2 — additive read-path indexes only (no column/data changes).
 * - query_norm text_pattern_ops: index-backed `LIKE 'prefix%'` for /suggest.
 * - updated_at DESC: newest-first ORDER BY ... LIMIT for /suggest.
 * - verified_prices (query_norm, seen_at DESC): /tape pull without a sort.
 * - pg_trgm GIN on lower(query_raw) when the extension is allowed: `ILIKE '%x%'`.
 *   Wrapped so managed Postgres without CREATE EXTENSION rights still migrates.
 */
function migration2Indexes() {
  return `
    CREATE INDEX IF NOT EXISTS tape_snapshots_norm_prefix_idx
      ON tape_snapshots (query_norm text_pattern_ops);
    CREATE INDEX IF NOT EXISTS tape_snapshots_updated_idx
      ON tape_snapshots (updated_at DESC);
    CREATE INDEX IF NOT EXISTS verified_prices_query_seen_idx
      ON verified_prices (query_norm, seen_at DESC);
    DO $gv$
    BEGIN
      BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'pg_trgm unavailable; /suggest falls back to prefix index';
      END;
      IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS tape_snapshots_raw_trgm_idx
                   ON tape_snapshots USING gin (query_raw gin_trgm_ops)';
      END IF;
    END
    $gv$;
  `;
}

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
const migrationsDone = new WeakMap();

/**
 * Run migrations once per pool (memoized). Hot paths (POST /tape, GET /tape) used to
 * re-run CREATE TABLE IF NOT EXISTS + SELECT schema_migrations on every request.
 * A failed attempt is forgotten so the next request retries.
 */
async function ensurePostgresMigrations(pool) {
  if (!pool) return { ok: false, skipped: "no-postgres", applied: [] };
  const prior = migrationsDone.get(pool);
  if (prior) {
    const done = await prior;
    return { ok: true, applied: [], latest: done.latest, cached: true };
  }
  const run = applyPostgresMigrations(pool);
  migrationsDone.set(pool, run);
  try {
    return await run;
  } catch (err) {
    migrationsDone.delete(pool);
    throw err;
  }
}

async function applyPostgresMigrations(pool) {
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

const SNAPSHOT_UPSERT_SQL = `INSERT INTO tape_snapshots
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
      updated_at = now()`;

/** One statement for all comps (unnest arrays) instead of one round trip per comp. */
const VERIFIED_BATCH_UPSERT_SQL = `INSERT INTO verified_prices
      (query_norm, item_id, query_raw, title, price, match_score, sold_date, url, seen_at)
     SELECT $1, t.item_id, $2, t.title, t.price, t.match_score, t.sold_date, t.url, now()
       FROM unnest($3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::text[], $8::text[])
         AS t(item_id, title, price, match_score, sold_date, url)
     ON CONFLICT (query_norm, item_id) DO UPDATE SET
      title = EXCLUDED.title,
      price = EXCLUDED.price,
      match_score = EXCLUDED.match_score,
      sold_date = EXCLUDED.sold_date,
      url = EXCLUDED.url,
      seen_at = now()`;

/** Last write wins per item id — ON CONFLICT cannot touch the same row twice in one statement. */
function verifiedBatchParams(snapshot, comps) {
  const byId = new Map();
  for (const comp of comps) byId.set(String(comp.id || ""), comp);
  const rows = [...byId.entries()];
  return [
    snapshot.queryNorm,
    snapshot.query,
    rows.map(([id]) => id),
    rows.map(([, c]) => c.title),
    rows.map(([, c]) => c.price),
    rows.map(([, c]) => c.matchScore),
    rows.map(([, c]) => c.soldDate || null),
    rows.map(([, c]) => c.url || null),
  ];
}

async function writePostgres(pool, snapshot) {
  if (!pool || !snapshot) return { ok: false, skipped: "no-postgres" };
  const comps = snapshot.comps || [];
  await ensurePostgresMigrations(pool);
  const snapshotParams = [
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
  ];
  // One client + one transaction: snapshot and its verified solds commit together.
  const client = typeof pool.connect === "function" ? await pool.connect() : null;
  const q = client ? (sql, params) => client.query(sql, params) : (sql, params) => pool.query(sql, params);
  try {
    if (client) await q("BEGIN");
    await q(SNAPSHOT_UPSERT_SQL, snapshotParams);
    if (comps.length) await q(VERIFIED_BATCH_UPSERT_SQL, verifiedBatchParams(snapshot, comps));
    if (client) await q("COMMIT");
  } catch (err) {
    if (client) await q("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (client) client.release();
  }
  return { ok: true, nKept: comps.length };
}

const SUGGEST_SUBSTRING_MIN = 3;

/** Escape LIKE wildcards so a typed "%" or "_" matches literally. */
function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (c) => "\\" + c);
}

async function suggestPostgres(pool, q, limit) {
  if (!pool) return [];
  const needle = String(q || "").trim();
  if (!needle) return [];
  const prefix = `${likeEscape(needle.toLowerCase())}%`;
  // 1–2 chars: trigram indexes cannot help a substring scan, so stay on the
  // query_norm prefix index (local Chrome tape still does substring matching).
  // 3+ chars: substring ILIKE (pg_trgm GIN when available) OR prefix.
  const { rows } =
    needle.length < SUGGEST_SUBSTRING_MIN
      ? await pool.query(
          `SELECT query_raw, n_kept, fast_cash, updated_at
             FROM tape_snapshots
            WHERE query_norm LIKE $1
            ORDER BY updated_at DESC
            LIMIT $2`,
          [prefix, limit],
        )
      : await pool.query(
          `SELECT query_raw, n_kept, fast_cash, updated_at
             FROM tape_snapshots
            WHERE query_raw ILIKE $1 OR query_norm LIKE $2
            ORDER BY updated_at DESC
            LIMIT $3`,
          // Literal patterns (wildcards escaped) let the planner use the trigram / prefix indexes.
          [`%${likeEscape(needle)}%`, prefix, limit],
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
  ensureScratchColumns(db);
  const listings = stmt(
    db,
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
  const scans = stmt(
    db,
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
  // Independent reads: run on two pool clients in parallel instead of back to back.
  const [snapRes, pricesRes] = await Promise.all([
    pool.query(
      `SELECT query_norm, query_raw, n_kept, n_raw, n_cliff, median, p25, p75, fast_cash, comps_json, updated_at
         FROM tape_snapshots
        WHERE query_norm = $1
        LIMIT 1`,
      [norm],
    ),
    pool.query(
      `SELECT query_norm, item_id, query_raw, title, price, match_score, sold_date, url, seen_at
         FROM verified_prices
        WHERE query_norm = $1
        ORDER BY seen_at DESC`,
      [norm],
    ),
  ]);
  const row = snapRes.rows[0] || null;
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
  ensureScratchColumns,
  verifiedBatchParams,
  tapeQueryNorm,
  parseCompsJson,
  SCRATCH_TTL_MS,
};
