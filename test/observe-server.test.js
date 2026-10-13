"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { loadScripts } = require("./load-core");
const { applyMigrations } = require("../server/migrate");

const { GVObserve } = loadScripts(["lib/observe.js"]);

function waitPort(child) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += String(chunk);
      const match = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        child.stderr.off("data", onData);
        resolve(Number(match[1]));
      }
    };
    child.stderr.on("data", onData);
    child.once("exit", (code) => reject(new Error(`tape server exited ${code}\n${buf}`)));
    setTimeout(() => reject(new Error(`tape server did not start\n${buf}`)), 5000);
  });
}

function fakePool(vector) {
  const queries = [];
  return {
    queries,
    async query(text, params) {
      queries.push({ text, params });
      if (String(text).includes("pg_available_extensions")) {
        return { rows: vector ? [{ ok: 1 }] : [] };
      }
      if (String(text).includes("SELECT version FROM schema_migrations")) return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
  };
}

test("migrations create the card tables and skip embeddings without pgvector", async () => {
  const plain = fakePool(false);
  const skipped = await applyMigrations(plain);
  const sql = plain.queries.map((query) => query.text).join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS observations/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS cards/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS comps/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sku_mappings/);
  assert.equal(sql.includes("vector(1536)"), false);
  assert.ok(skipped.skipped.some((name) => name.startsWith("002")));

  const withVector = fakePool(true);
  const applied = await applyMigrations(withVector);
  const vectorSql = withVector.queries.map((query) => query.text).join("\n");
  assert.match(vectorSql, /vector\(1536\)/);
  assert.ok(applied.applied.some((name) => name.startsWith("002")));
});

test("POST /observe dedupes in sqlite and leaves tape routes alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-observe-"));
  const sqlite = path.join(dir, "scratch.sqlite");
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], {
    env: {
      ...process.env,
      PORT: "0",
      SQLITE_PATH: sqlite,
      DATABASE_URL: "",
      TAPE_SECRET: "test-secret",
      TAPE_SECRET_FILE: path.join(dir, "tape.secret"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const port = await waitPort(child);
    const base = `http://127.0.0.1:${port}`;
    const headers = { "Content-Type": "application/json", "X-Tape-Secret": "test-secret" };
    const sealed = await GVObserve.sealObservation(
      {
        site: "ebay",
        page_type: "sold_search",
        url: "https://www.ebay.com/itm/123456789012",
        item_id: "123456789012",
        title: "2023-24 Topps Chrome Victor Wembanyama #1",
        price: 425,
        status: "sold",
        sold_date: "Feb 2, 2026",
        seller_username: "zz-shop-9f3",
        feedback_count: 1420,
        image_urls: ["https://i.ebayimg.com/images/g/abc/s-l1600.jpg"],
        specifics: { Set: "Topps Chrome" },
      },
      { sellerHmacSecret: "test-secret" },
    );
    const denied = await fetch(`${base}/observe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ observations: [sealed] }),
    });
    assert.equal(denied.status, 401);
    const first = await fetch(`${base}/observe`, {
      method: "POST",
      headers,
      body: JSON.stringify({ observations: [sealed, { ...sealed, seller_username: "zz-shop-9f3" }] }),
    });
    const body = await first.json();
    assert.equal(first.status, 200, JSON.stringify(body));
    assert.equal(body.scratch, "sqlite");
    assert.equal(body.postgres.skipped, "no-postgres");
    assert.equal(body.inserted, 1);
    assert.equal(body.duplicates, 1);
    const again = await fetch(`${base}/observe`, {
      method: "POST",
      headers,
      body: JSON.stringify({ observations: [sealed] }),
    });
    assert.equal((await again.json()).duplicates, 1);
    const db = new DatabaseSync(sqlite);
    const stored = JSON.stringify(db.prepare("SELECT * FROM observations").all());
    assert.equal(stored.includes("zz-shop-9f3"), false);
    assert.match(stored, /Wembanyama/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM raw_listings").get().n, 0);
    const comps = await fetch(`${base}/comps?q=wembanyama`, { headers });
    const hits = await comps.json();
    assert.equal(hits.hits.length, 1);
    assert.equal(JSON.stringify(hits).includes("seller_hash"), false);
    const tape = await fetch(`${base}/ping`, { headers });
    assert.equal(tape.status, 200);
    const health = await fetch(`${base}/health`);
    assert.deepEqual(await health.json(), { ok: true });
  } finally {
    child.kill();
  }
});
