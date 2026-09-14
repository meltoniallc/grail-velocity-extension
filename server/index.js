"use strict";

const http = require("node:http");
const path = require("node:path");
const { openScratch, writeScratch, writePostgres, suggestPostgres } = require("./store");

const PORT = Number(process.env.PORT || 8787);
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, "..", "data", "scratch.sqlite");
const DATABASE_URL = process.env.DATABASE_URL || "";
const TAPE_SECRET = process.env.TAPE_SECRET || "";

let pool = null;
if (DATABASE_URL) {
  const { Pool } = require("pg");
  pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
}

const scratch = openScratch(SQLITE_PATH);

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Tape-Secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(json);
}

function unauthorized(req) {
  if (!TAPE_SECRET) return false;
  return String(req.headers["x-tape-secret"] || "") !== TAPE_SECRET;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
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
      send(res, 200, {
        ok: true,
        postgres: Boolean(pool),
        sqlite: SQLITE_PATH,
      });
      return;
    }
    if (unauthorized(req)) {
      send(res, 401, { ok: false, error: "bad tape secret" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/suggest") {
      const hits = await suggestPostgres(pool, url.searchParams.get("q") || "", 8);
      send(res, 200, { hits, source: pool ? "postgres" : "none" });
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
    send(res, 500, { ok: false, error: String(err.message || err) });
  }
});

if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : PORT;
    process.stderr.write(
      `Grail Velocity tape on http://127.0.0.1:${port} (postgres ${pool ? "on" : "off"}, sqlite ${SQLITE_PATH})\n`,
    );
  });
}

module.exports = { server, scratch };
