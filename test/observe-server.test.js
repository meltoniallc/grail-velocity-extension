"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { loadScripts } = require("./load-core");
const { PG_MIGRATIONS, schemaMigrationsDdl, ensurePostgresMigrations } = require("../server/store");

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

const ROOT = path.join(__dirname, "..");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", "data"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|sql|py)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("observe tables live in the single store.js migration list as v3 and v4", async () => {
  const versions = PG_MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, [1, 2, 3, 4]);
  for (const mig of PG_MIGRATIONS) assert.ok(mig.name && typeof mig.name === "string");
  const v3 = PG_MIGRATIONS.find((m) => m.version === 3).sql;
  for (const table of ["cards", "observations", "comps", "sku_mappings"]) {
    assert.match(v3, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
  }
  assert.match(v3, /CREATE INDEX IF NOT EXISTS observations_item_idx/);
  const v4 = PG_MIGRATIONS.find((m) => m.version === 4).sql;
  assert.match(v4, /vector\(1536\)/);
  assert.match(v4, /EXCEPTION WHEN OTHERS/, "pgvector is optional");
  assert.match(v4, /CREATE TABLE IF NOT EXISTS embeddings/);
  // Every CREATE in the folded SQL is idempotent.
  for (const mig of PG_MIGRATIONS.slice(2)) {
    assert.doesNotMatch(mig.sql, /CREATE (TABLE|INDEX|EXTENSION) (?!IF NOT EXISTS)/);
  }
  // The tracker is INT-versioned with a name, and only store.js creates it.
  assert.match(schemaMigrationsDdl(), /version INT PRIMARY KEY/);
  assert.doesNotMatch(schemaMigrationsDdl(), /version TEXT/);
  const creators = walk(ROOT)
    .filter((file) => !file.includes(`${path.sep}test${path.sep}`))
    .filter((file) => /CREATE TABLE (IF NOT EXISTS )?schema_migrations/i.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(ROOT, file));
  assert.deepEqual(creators, [path.join("server", "store.js")]);
  assert.equal(fs.existsSync(path.join(ROOT, "server", "migrate.js")), false);
  assert.match(fs.readFileSync(path.join(ROOT, "server", "observe.js"), "utf8"), /ensurePostgresMigrations\(pool\)/);
});

test("ensurePostgresMigrations applies v3 observe tables through the shared tracker", async () => {
  const applied = new Set();
  const queries = [];
  const pool = {
    async query(text, params) {
      queries.push(String(text));
      if (/SELECT version FROM schema_migrations/i.test(text)) {
        return { rows: [...applied].map((version) => ({ version })) };
      }
      if (/INSERT INTO schema_migrations/i.test(text)) {
        assert.equal(typeof params[0], "number");
        assert.ok(params[1], "name recorded");
        applied.add(params[0]);
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const result = await ensurePostgresMigrations(pool);
  assert.deepEqual(result.applied, [1, 2, 3, 4]);
  assert.equal(result.latest, 4);
  const sql = queries.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS observations/);
  assert.match(sql, /schema_migrations_legacy_text/);
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
