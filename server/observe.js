"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { applyMigrations } = require("./migrate");

const SQLITE_SCHEMA = fs.readFileSync(path.join(__dirname, "..", "db", "sqlite", "001_observe.sql"), "utf8");

const COLS = [
  "site",
  "item_id",
  "url",
  "page_type",
  "status",
  "price",
  "shipping",
  "currency",
  "sold_date",
  "captured_at",
  "title",
  "specifics",
  "image_urls",
  "seller_hash",
  "feedback_bucket",
  "own_sale",
  "own_seller_id",
  "parser_ver",
  "extension_version",
  "raw_hash",
  "condition",
  "buying_format",
  "grade_co",
  "grade",
  "cert",
  "serial",
  "is_auto",
  "is_rookie",
  "parallel",
  "set_name",
  "year",
  "player",
  "card_no",
];

const PAGE_TYPES = new Set(["item", "sold_search", "active_search"]);
const STATUSES = new Set(["active", "sold", "ended"]);

function hashMaterial(obs) {
  const price = obs.price == null || obs.price === "" || Number.isNaN(Number(obs.price))
    ? ""
    : Number(obs.price).toFixed(2);
  return `${obs.site || ""}|${obs.item_id || ""}|${obs.status || ""}|${price}|${obs.sold_date || ""}`;
}

function rawHash(obs) {
  return createHash("sha256").update(hashMaterial(obs)).digest("hex");
}

function specificsObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(seller|seller username|seller_username|username)$/i.test(String(key))) continue;
    out[key] = item;
  }
  return out;
}

function imageList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && /^https?:/i.test(item)).slice(0, 12);
}

function sanitize(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!PAGE_TYPES.has(raw.page_type) || !STATUSES.has(raw.status)) return null;
  const itemId = String(raw.item_id || "").trim();
  const title = String(raw.title || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!itemId || !title) return null;
  const price = raw.price == null || raw.price === "" ? null : Number(raw.price);
  if (price != null && !Number.isFinite(price)) return null;
  const shipping = raw.shipping == null || raw.shipping === "" ? null : Number(raw.shipping);
  const sellerHash = /^[a-f0-9]{64}$/.test(String(raw.seller_hash || "")) ? String(raw.seller_hash) : null;
  const ownSale = Boolean(raw.own_sale);
  const row = {
    site: String(raw.site || "ebay").slice(0, 32),
    item_id: itemId.slice(0, 32),
    url: String(raw.url || "").slice(0, 500),
    page_type: raw.page_type,
    status: raw.status,
    price,
    shipping: shipping != null && Number.isFinite(shipping) ? shipping : null,
    currency: /^[A-Z]{3}$/.test(String(raw.currency || "")) ? raw.currency : "USD",
    sold_date: raw.sold_date ? String(raw.sold_date).slice(0, 40) : null,
    captured_at: raw.captured_at ? String(raw.captured_at).slice(0, 40) : new Date().toISOString(),
    title,
    specifics: specificsObject(raw.specifics),
    image_urls: imageList(raw.image_urls),
    seller_hash: sellerHash,
    feedback_bucket: ["<100", "100-1k", "1k+"].includes(raw.feedback_bucket) ? raw.feedback_bucket : null,
    own_sale: ownSale,
    own_seller_id: ownSale && raw.own_seller_id ? String(raw.own_seller_id).slice(0, 80) : null,
    parser_ver: String(raw.parser_ver || "").slice(0, 40),
    extension_version: String(raw.extension_version || "").slice(0, 20),
    condition: raw.condition ? String(raw.condition).slice(0, 80) : null,
    buying_format: raw.buying_format ? String(raw.buying_format).slice(0, 40) : null,
    grade_co: String(raw.grade_co || "").slice(0, 16),
    grade: String(raw.grade || "").slice(0, 16),
    cert: String(raw.cert || "").slice(0, 64),
    serial: String(raw.serial || "").slice(0, 32),
    is_auto: Boolean(raw.is_auto),
    is_rookie: Boolean(raw.is_rookie),
    parallel: String(raw.parallel || "").slice(0, 80),
    set_name: String(raw.set_name || "").slice(0, 80),
    year: String(raw.year || "").slice(0, 16),
    player: String(raw.player || "").slice(0, 80),
    card_no: String(raw.card_no || "").slice(0, 16),
  };
  row.raw_hash = rawHash(row);
  return row;
}

function ensureSqlite(db) {
  db.exec(SQLITE_SCHEMA);
}

function sqliteParams(row) {
  return COLS.map((col) => {
    if (col === "specifics") return JSON.stringify(row.specifics);
    if (col === "image_urls") return JSON.stringify(row.image_urls);
    if (col === "own_sale" || col === "is_auto" || col === "is_rookie") return row[col] ? 1 : 0;
    return row[col];
  });
}

function ingestSqlite(db, rows) {
  ensureSqlite(db);
  const sql = `INSERT INTO observations (${COLS.join(", ")}) VALUES (${COLS.map(() => "?").join(", ")})
    ON CONFLICT(raw_hash) DO NOTHING`;
  const insert = db.prepare(sql);
  const summary = { inserted: 0, duplicates: 0, rejected: 0 };
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const result = insert.run(...sqliteParams(row));
      if (result.changes) summary.inserted += 1;
      else summary.duplicates += 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return summary;
}

let migrated = false;

async function upsertPostgres(pool, rows) {
  if (!migrated) {
    await applyMigrations(pool);
    migrated = true;
  }
  let inserted = 0;
  let duplicates = 0;
  const placeholders = COLS.map((col, i) => (col === "specifics" ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ");
  const sql = `INSERT INTO observations (${COLS.join(", ")}) VALUES (${placeholders}) ON CONFLICT (raw_hash) DO NOTHING`;
  for (const row of rows) {
    const params = COLS.map((col) => {
      if (col === "specifics") return JSON.stringify(row.specifics);
      return row[col];
    });
    const result = await pool.query(sql, params);
    if (result.rowCount) inserted += 1;
    else duplicates += 1;
  }
  return { ok: true, inserted, duplicates };
}

async function ingestObservations(db, pool, list) {
  const clean = [];
  let rejected = 0;
  for (const raw of list || []) {
    const row = sanitize(raw);
    if (!row) rejected += 1;
    else clean.push(row);
  }
  const sqlite = ingestSqlite(db, clean);
  sqlite.rejected = rejected;
  let postgres = { ok: false, skipped: "no-postgres" };
  if (pool && clean.length) {
    try {
      postgres = await upsertPostgres(pool, clean);
    } catch (err) {
      postgres = { ok: false, error: String(err.message || err) };
    }
  }
  return { ...sqlite, postgres };
}

function searchObservations(db, q, limit = 8) {
  ensureSqlite(db);
  const needle = String(q || "").trim().replace(/[%_\\]/g, "").slice(0, 80);
  if (needle.length < 2) return [];
  return db
    .prepare(
      `SELECT title, price, status, sold_date, url, captured_at, page_type
         FROM observations
        WHERE title LIKE ?
        ORDER BY captured_at DESC
        LIMIT ?`,
    )
    .all(`%${needle}%`, limit)
    .map((row) => ({
      title: row.title,
      price: row.price,
      status: row.status,
      soldDate: row.sold_date,
      url: row.url,
      at: row.captured_at,
      pageType: row.page_type,
    }));
}

module.exports = {
  hashMaterial,
  rawHash,
  sanitize,
  ensureSqlite,
  ingestObservations,
  searchObservations,
  COLS,
};
