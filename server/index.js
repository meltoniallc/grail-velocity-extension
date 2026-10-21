"use strict";

const http = require("node:http");
const path = require("node:path");
const zlib = require("node:zlib");
const {
  openScratch,
  writeScratch,
  writePostgres,
  suggestPostgres,
  getTapePostgres,
  getScratchSqlite,
  ensurePostgresMigrations,
} = require("./store");
const { ingestObservations, searchObservations } = require("./observe");
const { resolveSecret } = require("./secret");
const { listenHost, postgresPoolOptions, secretMatches } = require("./runtime");

const PORT = Number(process.env.PORT || 8787);
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, "..", "data", "scratch.sqlite");
const DATABASE_URL = process.env.DATABASE_URL || "";
const MAX_BODY_BYTES = 1_000_000;
const secretInfo = resolveSecret({
  env: process.env,
    filePath: process.env.TAPE_SECRET_FILE || path.join(__dirname, "..", "data", "tape.secret"),
});
const TAPE_SECRET = secretInfo.secret;

let pool = null;
if (DATABASE_URL) {
  const { Pool } = require("pg");
  pool = new Pool(
    postgresPoolOptions(DATABASE_URL, {
      max: Number(process.env.PG_POOL_MAX || 8),
      idleTimeoutMillis: 60_000,
      keepAlive: true,
    }),
  );
  pool.on("error", (err) => process.stderr.write(`postgres pool error: ${err.message}\n`));
  // Migrate + open a connection at boot so the first capture does not pay for DDL / TLS.
  ensurePostgresMigrations(pool).catch((err) =>
    process.stderr.write(`postgres migrations deferred: ${err.message}\n`),
  );
}

const scratch = openScratch(SQLITE_PATH);

const GZIP_MIN_BYTES = 1024;

function send(res, status, body) {
  const json = JSON.stringify(body);
  const req = res.req;
  const accepts = String((req && req.headers["accept-encoding"]) || "");
  const headers = { "Content-Type": "application/json; charset=utf-8", Vary: "Accept-Encoding" };
  if (json.length >= GZIP_MIN_BYTES && /\bgzip\b/.test(accepts)) {
    // Level 1: ~70% smaller /tape pulls for well under 1 ms of CPU.
    const gz = zlib.gzipSync(json, { level: 1 });
    headers["Content-Encoding"] = "gzip";
    headers["Content-Length"] = gz.length;
    res.writeHead(status, headers);
    res.end(gz);
    return;
  }
  headers["Content-Length"] = Buffer.byteLength(json);
  res.writeHead(status, headers);
  res.end(json);
}

function unauthorized(req) {
  return !secretMatches(TAPE_SECRET, req.headers["x-tape-secret"]);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering but keep draining so the socket stays usable.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("request body exceeds size limit"), { statusCode: 413 }));
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      send(res, 204, {});
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true });
      return;
    }
    if (unauthorized(req)) {
      send(res, 401, { ok: false, error: "bad tape secret" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/ping") {
      send(res, 200, { ok: true, postgres: Boolean(pool) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/suggest") {
      const rawLimit = Number(url.searchParams.get("limit") || 8);
      const limit = Number.isFinite(rawLimit) ? Math.min(24, Math.max(1, Math.floor(rawLimit))) : 8;
      const hits = await suggestPostgres(pool, url.searchParams.get("q") || "", limit);
      // Tape snapshots only — never serve catalog/book as Fast-Cash.
      const tapeHits = (hits || []).filter((h) => h && h.kind === "tape");
      send(res, 200, { hits: tapeHits, source: pool ? "postgres" : "none" });
      return;
    }
    if (req.method === "GET" && (url.pathname === "/tape" || url.pathname === "/snapshot")) {
      // One query_norm: tape_snapshots + verified_prices. Never SQLite scratch.
      const pulled = await getTapePostgres(pool, url.searchParams.get("q") || "");
      send(res, 200, {
        ok: true,
        source: pulled.source,
        snapshot: pulled.snapshot,
        verifiedPrices: pulled.verifiedPrices || [],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/scratch") {
      // Local debug: SQLite rejected / cliff / active asks only. Auth required. 7d TTL.
      const rawLimit = Number(url.searchParams.get("limit") || 40);
      const pulled = getScratchSqlite(scratch, url.searchParams.get("q") || "", rawLimit);
      send(res, 200, {
        ok: true,
        source: pulled.source,
        queryNorm: pulled.queryNorm,
        listings: pulled.listings,
        scans: pulled.scans,
        ttlDays: 7,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/observe") {
      const payload = await readBody(req);
      const list = Array.isArray(payload.observations) ? payload.observations : null;
      if (!list) {
        send(res, 400, { ok: false, error: "observations array required" });
        return;
      }
      if (list.length > 80) {
        send(res, 400, { ok: false, error: "too many observations" });
        return;
      }
      const result = await ingestObservations(scratch, pool, list);
      send(res, 200, { ok: true, scratch: "sqlite", ...result });
      return;
    }
    if (req.method === "GET" && url.pathname === "/comps") {
      const hits = searchObservations(scratch, url.searchParams.get("q") || "", 8);
      send(res, 200, { hits });
      return;
    }
    if (req.method === "POST" && url.pathname === "/tape") {
      const payload = await readBody(req);
      writeScratch(scratch, payload);
      const pg = await writePostgres(pool, payload.snapshot);
      send(res, 200, {
        ok: true,
        scratch: "sqlite",
        postgres: pg,
      });
      return;
    }
    send(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    send(res, err.statusCode || 500, { ok: false, error: String(err.message || err) });
  }
});

// Keep sockets warm between captures (extension fetch reuses the connection).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

if (require.main === module) {
  const railway = Boolean(String(process.env.RAILWAY_ENVIRONMENT || "").trim());
  if (railway && secretInfo.source !== "env") {
    process.stderr.write("Refusing to start on Railway without TAPE_SECRET set on the service.\n");
    process.exit(1);
  }
  const host = listenHost();
  server.listen(PORT, host, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : PORT;
    const secretLine = railway
      ? "Tape secret is the TAPE_SECRET variable on this service (not printed).\n"
      : `Paste this secret in Grail Velocity Options:\n${TAPE_SECRET}\n(source: ${secretInfo.source}, file: ${secretInfo.filePath})\n`;
    process.stderr.write(
      `Grail Velocity tape on http://${host}:${port} (postgres ${pool ? "on" : "off"}, sqlite ${SQLITE_PATH})\n${secretLine}Then: Tape API http://${host}:${port} → Save → Check connection.\n`,
    );
  });
}

module.exports = { server, scratch, listenHost, postgresPoolOptions };
