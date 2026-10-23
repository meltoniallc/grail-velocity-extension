"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { loadScripts } = require("./load-core");

const { GV } = loadScripts(["lib/core.js"]);
const {
  listenHost,
  postgresPoolOptions,
  postgresSchemaName,
  quotePgIdent,
  secretMatches,
  DEFAULT_SHARED_PG_SCHEMA,
} = require("../server/runtime");

function tapeEnv(extra) {
  return {
    ...process.env,
    PORT: "0",
    DATABASE_URL: "",
    TAPE_SECRET: "test-secret",
    TAPE_HOST: "",
    RAILWAY_ENVIRONMENT: "",
    RAILWAY_PROJECT_ID: "",
    ...extra,
  };
}

function waitPort(child) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += String(chunk);
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        child.stderr.off("data", onData);
        resolve(Number(m[1]));
      }
    };
    child.stderr.on("data", onData);
    child.once("exit", (code) => reject(new Error("tape server exited " + code + "\n" + buf)));
    setTimeout(() => reject(new Error("tape server did not start\n" + buf)), 5000);
  });
}

test("tape server parks noise in sqlite and does not require postgres", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-tape-http-"));
  const sqlite = path.join(dir, "scratch.sqlite");
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], {
    env: tapeEnv({
      SQLITE_PATH: sqlite,
      TAPE_SECRET_FILE: path.join(dir, "tape.secret"),
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const port = await waitPort(child);
    const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
    const verified = GV.verifyComps(query, [
      { id: "a", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99", price: 120 },
      { id: "b", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 22/99", price: 110 },
      { id: "c", title: "2023 Panini Prizm Victor Wembanyama #5 Silver", price: 4.99 },
    ]);
    const kept = verified.rows.filter((r) => r.keep);
    const dropped = verified.rows.filter((r) => !r.keep);
    const res = await fetch(`http://127.0.0.1:${port}/tape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tape-Secret": "test-secret" },
      body: JSON.stringify({
        snapshot: {
          query,
          queryNorm: GV.fold(query),
          comps: kept,
          nKept: kept.length,
          nRaw: verified.nRaw,
          nCliff: verified.nCliff,
          fastCash: 107.8,
        },
        scratch: { query, queryNorm: GV.fold(query), listings: dropped },
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.scratch, "sqlite");
    assert.equal(body.postgres.skipped, "no-postgres");
    const denied = await fetch(`http://127.0.0.1:${port}/ping`);
    assert.equal(denied.status, 401);
    const ping = await fetch(`http://127.0.0.1:${port}/ping`, {
      headers: { "X-Tape-Secret": "test-secret" },
    });
    assert.equal(ping.status, 200);
    assert.equal((await ping.json()).ok, true);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(sqlite);
    const rows = db.prepare("SELECT title FROM raw_listings").all();
    assert.ok(rows.some((r) => /Prizm/i.test(r.title)));
    assert.equal(
      rows.some((r) => /Mercury Victor Wembanyama #5 Refractor 11\/99/i.test(r.title)),
      false,
    );
  } finally {
    child.kill();
  }
});

test("GET /suggest is auth-gated and returns tape-only hits without postgres", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-tape-suggest-"));
  const sqlite = path.join(dir, "scratch.sqlite");
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], {
    env: tapeEnv({
      SQLITE_PATH: sqlite,
      TAPE_SECRET_FILE: path.join(dir, "tape.secret"),
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const port = await waitPort(child);
    const base = `http://127.0.0.1:${port}`;
    const denied = await fetch(`${base}/suggest?q=mercury`);
    assert.equal(denied.status, 401);
    const res = await fetch(`${base}/suggest?q=mercury&limit=4`, {
      headers: { "X-Tape-Secret": "test-secret" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, "none");
    assert.deepEqual(body.hits, []);
    assert.ok(Array.isArray(body.hits));
    assert.equal(
      body.hits.every((h) => h.kind === "tape"),
      true,
    );
  } finally {
    child.kill();
  }
});

test("GET /tape is auth-gated and returns empty without postgres (no scratch leak)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-tape-pull-"));
  const sqlite = path.join(dir, "scratch.sqlite");
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], {
    env: tapeEnv({
      SQLITE_PATH: sqlite,
      TAPE_SECRET_FILE: path.join(dir, "tape.secret"),
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const port = await waitPort(child);
    const base = `http://127.0.0.1:${port}`;
    const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
    // Seed SQLite scratch only — pull must not surface it as durable comps.
    await fetch(`${base}/tape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tape-Secret": "test-secret" },
      body: JSON.stringify({
        snapshot: {
          query,
          queryNorm: GV.fold(query),
          comps: [],
          nKept: 0,
          nRaw: 1,
          nCliff: 1,
          fastCash: null,
        },
        scratch: {
          query,
          queryNorm: GV.fold(query),
          listings: [
            {
              id: "junk",
              title: "2023 Panini Prizm Victor Wembanyama #5 Silver",
              price: 4.99,
              flags: ["wrong_set"],
              kind: "dropped",
            },
          ],
        },
      }),
    });
    const denied = await fetch(`${base}/tape?q=${encodeURIComponent(query)}`);
    assert.equal(denied.status, 401);
    const res = await fetch(`${base}/tape?q=${encodeURIComponent(query)}`, {
      headers: { "X-Tape-Secret": "test-secret" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.source, "none");
    assert.equal(body.snapshot, null);
    assert.deepEqual(body.verifiedPrices, []);
    const alias = await fetch(`${base}/snapshot?q=${encodeURIComponent(query)}`, {
      headers: { "X-Tape-Secret": "test-secret" },
    });
    assert.equal(alias.status, 200);
    assert.equal((await alias.json()).source, "none");
  } finally {
    child.kill();
  }
});

test("GET /scratch is auth-gated and returns SQLite reasons only (7d TTL)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-tape-scratch-get-"));
  const sqlite = path.join(dir, "scratch.sqlite");
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], {
    env: tapeEnv({
      SQLITE_PATH: sqlite,
      TAPE_SECRET_FILE: path.join(dir, "tape.secret"),
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const port = await waitPort(child);
    const base = `http://127.0.0.1:${port}`;
    const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
    await fetch(`${base}/tape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tape-Secret": "test-secret" },
      body: JSON.stringify({
        snapshot: {
          query,
          queryNorm: GV.fold(query),
          comps: [],
          nKept: 0,
          nRaw: 2,
          nCliff: 1,
          fastCash: null,
        },
        scratch: {
          query,
          queryNorm: GV.fold(query),
          listings: [
            {
              id: "junk",
              title: "2023 Panini Prizm Victor Wembanyama #5 Silver",
              price: 4.99,
              flags: ["wrong_set"],
              kind: "dropped",
            },
            {
              id: "cliff",
              title: "Bulk commons lot",
              price: 1,
              flags: ["beyond_cliff"],
              kind: "dropped",
              reason: "Past eBay relevance cliff",
            },
            {
              id: "ask",
              title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99",
              price: 160,
              kind: "active",
              keep: true,
              flags: [],
            },
          ],
        },
      }),
    });
    const denied = await fetch(`${base}/scratch?q=${encodeURIComponent(query)}`);
    assert.equal(denied.status, 401);
    const res = await fetch(`${base}/scratch?q=${encodeURIComponent(query)}&limit=10`, {
      headers: { "X-Tape-Secret": "test-secret" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.source, "sqlite");
    assert.equal(body.ttlDays, 7);
    assert.ok(body.listings.length >= 2);
    assert.ok(body.listings.some((l) => l.bucket === "cliff"));
    assert.ok(body.listings.some((l) => l.bucket === "active"));
    assert.equal(
      body.listings.some((l) => l.kind === "sold" && l.keep === true && l.bucket === "sold"),
      false,
    );
    // Scratch endpoint must not invent durable Fast-Cash / postgres snapshot.
    assert.equal(body.snapshot, undefined);
    assert.equal(body.fastCash, undefined);
  } finally {
    child.kill();
  }
});

test("tape server caps bodies, minimizes pre-auth health, and omits CORS", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-tape-hard-"));
  const sqlite = path.join(dir, "scratch.sqlite");
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], {
    env: tapeEnv({
      SQLITE_PATH: sqlite,
      TAPE_SECRET_FILE: path.join(dir, "tape.secret"),
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const port = await waitPort(child);
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(health.headers.get("access-control-allow-origin"), null);
    const authed = { "X-Tape-Secret": "test-secret" };
    const ping = await fetch(`${base}/ping`, { headers: authed });
    assert.equal(ping.status, 200);
    assert.equal(ping.headers.get("access-control-allow-origin"), null);
    assert.equal((await ping.json()).postgres, false);
    const big = await fetch(`${base}/tape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authed },
      body: JSON.stringify({ snapshot: null, scratch: { listings: [] }, pad: "x".repeat(1_200_000) }),
    });
    assert.equal(big.status, 413);
  } finally {
    child.kill();
  }
});

test("tape API allowlist is loopback or the one hosted Tape host", () => {
  assert.equal(GV.tapeApiAllowed("http://127.0.0.1:8787"), true);
  assert.equal(
    GV.tapeApiAllowed(`http://${String.fromCharCode(108, 111, 99, 97, 108, 104, 111, 115, 116)}:8787/`),
    true,
  );
  assert.equal(GV.tapeApiAllowed("https://tape-production-2810.up.railway.app"), true);
  assert.equal(GV.tapeApiAllowed("https://tape-production-2810.up.railway.app/tape"), true);
  assert.equal(GV.tapeApiAllowed("https://other.up.railway.app"), false);
  assert.equal(GV.tapeApiAllowed("http://tape-production-2810.up.railway.app"), false);
  assert.equal(GV.tapeApiAllowed("https://user:pw@tape-production-2810.up.railway.app"), false);
  assert.equal(GV.tapeApiAllowed("https://evil.example"), false);
  assert.equal(GV.tapeApiAllowed(""), false);
});

test("tape secret compare does not treat a prefix as a match", () => {
  assert.equal(secretMatches("abcdef1234567890", "abcdef1234567890"), true);
  assert.equal(secretMatches("abcdef1234567890", "abcdef1234567890extra"), false);
  assert.equal(secretMatches("abcdef1234567890", "abcdef1234567891"), false);
  assert.equal(secretMatches("abcdef1234567890", ""), false);
  assert.equal(secretMatches("", "anything"), true);
});

test("listen host stays loopback unless Railway or TAPE_HOST says otherwise", () => {
  assert.equal(listenHost({}), "127.0.0.1");
  assert.equal(listenHost({ TAPE_HOST: "", RAILWAY_ENVIRONMENT: "" }), "127.0.0.1");
  assert.equal(listenHost({ RAILWAY_ENVIRONMENT: "production" }), "0.0.0.0");
  assert.equal(listenHost({ RAILWAY_PROJECT_ID: "eba1aaf2" }), "0.0.0.0");
  assert.equal(listenHost({ TAPE_HOST: "127.0.0.1", RAILWAY_ENVIRONMENT: "production" }), "127.0.0.1");
});

test("railway postgres pool accepts the self-signed cert", () => {
  const local = postgresPoolOptions("postgres://u:p@127.0.0.1:5432/grail", {}, {});
  assert.equal(local.ssl, undefined);
  assert.equal(local.options, undefined);
  const disabled = postgresPoolOptions(
    "postgresql://u:p@postgres.railway.internal:5432/railway?sslmode=disable",
    {},
    {},
  );
  assert.equal(disabled.ssl, undefined);
  const pub = postgresPoolOptions(
    "postgresql://u:p@example.proxy.rlwy.net:45568/railway?sslmode=require",
    {},
    {},
  );
  assert.deepEqual(pub.ssl, { rejectUnauthorized: false });
  const internal = postgresPoolOptions(
    "postgresql://u:p@postgres.railway.internal:5432/railway",
    { max: 8, keepAlive: true },
    {},
  );
  assert.equal(internal.max, 8);
  assert.equal(internal.keepAlive, true);
  assert.deepEqual(internal.ssl, { rejectUnauthorized: false });
});

test("PG_SCHEMA pins search_path for shared automation Postgres", () => {
  assert.equal(DEFAULT_SHARED_PG_SCHEMA, "grail_tape");
  assert.equal(postgresSchemaName({}), "");
  assert.equal(postgresSchemaName({ PG_SCHEMA: "" }), "");
  assert.equal(postgresSchemaName({ PG_SCHEMA: "public" }), "");
  assert.equal(postgresSchemaName({ PG_SCHEMA: "grail_tape" }), "grail_tape");
  assert.equal(quotePgIdent("grail_tape"), '"grail_tape"');
  assert.throws(() => postgresSchemaName({ PG_SCHEMA: "grail-tape" }), /identifier/);
  const shared = postgresPoolOptions(
    "postgresql://u:p@centerbeam.proxy.rlwy.net:19901/railway?sslmode=require",
    { max: 2 },
    { PG_SCHEMA: "grail_tape" },
  );
  assert.match(shared.options, /search_path=grail_tape,public/);
  assert.deepEqual(shared.ssl, { rejectUnauthorized: false });
});

test("Railway refuses to boot without TAPE_SECRET and does not print a generated secret", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-tape-nosecret-"));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], {
    env: tapeEnv({
      SQLITE_PATH: path.join(dir, "scratch.sqlite"),
      TAPE_SECRET_FILE: path.join(dir, "tape.secret"),
      TAPE_SECRET: "",
      RAILWAY_ENVIRONMENT: "production",
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let buf = "";
  const code = await new Promise((resolve) => {
    child.stderr.on("data", (chunk) => {
      buf += String(chunk);
    });
    child.once("exit", (c) => resolve(c));
    setTimeout(() => {
      child.kill();
      resolve(null);
    }, 5000);
  });
  assert.equal(code, 1);
  assert.match(buf, /TAPE_SECRET/);
  assert.doesNotMatch(buf, /Paste this secret/);
});

test("tape server binds all interfaces when Railway env is set", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-tape-bind-"));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], {
    env: tapeEnv({
      SQLITE_PATH: path.join(dir, "scratch.sqlite"),
      TAPE_SECRET_FILE: path.join(dir, "tape.secret"),
      RAILWAY_ENVIRONMENT: "production",
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let buf = "";
  try {
    const port = await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        buf += String(chunk);
        const m = buf.match(/http:\/\/0\.0\.0\.0:(\d+)/);
        if (m) {
          child.stderr.off("data", onData);
          resolve(Number(m[1]));
        }
      };
      child.stderr.on("data", onData);
      child.once("exit", (code) => reject(new Error("tape server exited " + code + "\n" + buf)));
      setTimeout(() => reject(new Error("tape server did not bind\n" + buf)), 5000);
    });
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.match(buf, /http:\/\/0\.0\.0\.0:/);
  } finally {
    child.kill();
  }
});
