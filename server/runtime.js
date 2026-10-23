"use strict";

const crypto = require("node:crypto");

/** Default schema when Tape shares meltonia-automation Postgres (additive, isolated). */
const DEFAULT_SHARED_PG_SCHEMA = "grail_tape";

/**
 * Bind loopback for `npm run tape` on a desk. Railway injects
 * RAILWAY_ENVIRONMENT; the proxy can only reach 0.0.0.0.
 * TAPE_HOST wins when set.
 */
function listenHost(env = process.env) {
  const explicit = String(env.TAPE_HOST || "").trim();
  if (explicit) return explicit;
  if (String(env.RAILWAY_ENVIRONMENT || "").trim() || String(env.RAILWAY_PROJECT_ID || "").trim()) {
    return "0.0.0.0";
  }
  return "127.0.0.1";
}

/**
 * Optional dedicated Postgres schema for Tape tables.
 * Empty = default search_path (public). Set PG_SCHEMA=grail_tape when
 * DATABASE_URL points at meltonia-automation's Postgres so verified_prices /
 * tape_snapshots never collide with event-spine or other app tables.
 * PG_SCHEMA=public (or "-") forces the default schema even if a shared URL is used.
 */
function postgresSchemaName(env = process.env) {
  const raw = String(env.PG_SCHEMA != null ? env.PG_SCHEMA : "").trim();
  if (!raw || raw === "-" || raw.toLowerCase() === "public") return "";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) {
    throw new Error("PG_SCHEMA must be a plain SQL identifier (letters, digits, _)");
  }
  return raw.toLowerCase();
}

/** Double-quote a validated identifier for DDL / SET search_path. */
function quotePgIdent(name) {
  const schema = String(name || "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error("invalid Postgres identifier");
  }
  return `"${schema.replace(/"/g, '""')}"`;
}

/**
 * Railway's postgres-ssl image presents a self-signed cert.
 * node-pg treats sslmode=require as verify-full unless rejectUnauthorized is false.
 * Local URLs and sslmode=disable stay plaintext.
 * When PG_SCHEMA is set, every pooled connection starts with that search_path.
 */
function postgresPoolOptions(connectionString, extra = {}, env = process.env) {
  const options = { connectionString, max: 4, ...extra };
  const schema = postgresSchemaName(env);
  if (schema) {
    const prior = options.options ? `${String(options.options).trim()} ` : "";
    options.options = `${prior}-c search_path=${schema},public`.trim();
  }
  let host = "";
  let sslmode = "";
  try {
    const parsed = new URL(connectionString);
    host = parsed.hostname;
    sslmode = (parsed.searchParams.get("sslmode") || "").toLowerCase();
  } catch {
    return options;
  }
  if (sslmode === "disable") return options;
  const railway =
    host === "postgres.railway.internal" ||
    host.endsWith(".railway.internal") ||
    host.endsWith(".rlwy.net");
  if (!railway) return options;
  options.ssl = { rejectUnauthorized: false };
  return options;
}

/** Constant-time compare. Empty expected means "no secret configured" (allow). */
function secretMatches(expected, headerValue) {
  const want = Buffer.from(String(expected || ""));
  if (want.length === 0) return true;
  const given = Buffer.from(String(headerValue || ""));
  if (given.length !== want.length) {
    crypto.timingSafeEqual(want, Buffer.alloc(want.length));
    return false;
  }
  return crypto.timingSafeEqual(given, want);
}

module.exports = {
  listenHost,
  postgresPoolOptions,
  postgresSchemaName,
  quotePgIdent,
  secretMatches,
  DEFAULT_SHARED_PG_SCHEMA,
};
