"use strict";

const crypto = require("node:crypto");

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
 * Railway's postgres-ssl image presents a self-signed cert.
 * node-pg treats sslmode=require as verify-full unless rejectUnauthorized is false.
 * Local URLs and sslmode=disable stay plaintext.
 */
function postgresPoolOptions(connectionString, extra = {}) {
  const options = { connectionString, max: 4, ...extra };
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

module.exports = { listenHost, postgresPoolOptions, secretMatches };
