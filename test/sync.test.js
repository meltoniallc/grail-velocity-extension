"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { loadScripts } = require("./load-core");
const {
  openScratch,
  writeScratch,
  writePostgres,
  verifiedBatchParams,
  getScratchSqlite,
} = require("../server/store");

const ctx = loadScripts(["lib/sync.js"]);
const { createStorageCache, createTtlCache, createOutbox, fetchWithTimeout } = ctx.GVSync;

function memArea(initial) {
  const data = { ...(initial || {}) };
  const listeners = [];
  let reads = 0;
  return {
    data,
    get reads() {
      return reads;
    },
    onChanged: { addListener: (fn) => listeners.push(fn) },
    async get(keys) {
      reads += 1;
      const out = {};
      for (const k of keys) if (data[k] !== undefined) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
        data[k] = structuredClone(v);
      }
      for (const fn of listeners) fn(changes, "local");
    },
    emit(changes) {
      for (const fn of listeners) fn(changes, "local");
    },
  };
}

test("storage cache serves repeat reads from memory and follows onChanged", async () => {
  const area = memArea({ tapeSnapshots: [{ queryNorm: "a" }] });
  const cache = createStorageCache(area, area.onChanged);
  const first = await cache.get(["tapeSnapshots", "tapeScratch"]);
  assert.equal(first.tapeSnapshots.length, 1);
  assert.equal(first.tapeScratch, undefined);
  await cache.get(["tapeSnapshots", "tapeScratch"]);
  await cache.get("tapeSnapshots");
  assert.equal(area.reads, 1, "only the first read touches storage");
  // A write from another extension page (options/popup) lands via onChanged.
  area.emit({ tapeSnapshots: { newValue: [{ queryNorm: "a" }, { queryNorm: "b" }] } });
  assert.equal((await cache.get(["tapeSnapshots"])).tapeSnapshots.length, 2);
  area.emit({ tapeSnapshots: { oldValue: [] } });
  assert.equal((await cache.get(["tapeSnapshots"])).tapeSnapshots, undefined);
  await cache.set({ tapeApi: "http://127.0.0.1:8787" });
  assert.equal(area.data.tapeApi, "http://127.0.0.1:8787");
  assert.equal((await cache.get(["tapeApi"])).tapeApi, "http://127.0.0.1:8787");
});

test("ttl cache expires and evicts least-recently-used", () => {
  let t = 0;
  const c = createTtlCache({ ttlMs: 100, max: 2, now: () => t });
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1); // a is now most recent
  c.set("c", 3); // evicts b
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  t = 500;
  assert.equal(c.get("a"), undefined);
});

test("outbox enqueue returns before the network send finishes", async () => {
  const area = memArea();
  let release;
  const sent = [];
  const outbox = createOutbox({
    storage: area,
    send: (p) =>
      new Promise((resolve) => {
        release = () => {
          sent.push(p);
          resolve({ ok: true, status: 200 });
        };
      }),
    setTimer: () => 0,
  });
  const res = await outbox.enqueue({ n: 1 });
  assert.equal(res.queued, true);
  assert.equal(sent.length, 0, "enqueue did not wait for send");
  release();
  await outbox.flush();
  assert.deepEqual(sent, [{ n: 1 }]);
  assert.equal(await outbox.pending(), 0);
  assert.deepEqual(area.data.tapeOutbox, []);
});

test("outbox keeps failed items for retry, drops permanent 4xx, and restores after restart", async () => {
  const area = memArea();
  const timers = [];
  let mode = "down";
  const sent = [];
  const deps = {
    storage: area,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    send: async (p) => {
      if (mode === "down") throw new Error("ECONNREFUSED");
      if (p.bad) return { ok: false, status: 400 };
      sent.push(p);
      return { ok: true, status: 200 };
    },
  };
  const a = createOutbox(deps);
  await a.enqueue({ n: 1 });
  await a.flush();
  await a.enqueue({ bad: true });
  await a.flush();
  await a.enqueue({ n: 2 });
  await a.flush();
  assert.equal(await a.pending(), 3);
  assert.ok(timers.length >= 1 && timers[0].ms === 2000, "backoff scheduled");
  // Service worker restarts: a fresh outbox reads the persisted queue.
  await new Promise((r) => setImmediate(r));
  const b = createOutbox(deps);
  assert.equal(await b.pending(), 3);
  mode = "up";
  const out = await b.flush();
  assert.equal(out.pending, 0);
  assert.deepEqual(sent, [{ n: 1 }, { n: 2 }], "FIFO order; 400 dropped");
});

test("fetchWithTimeout aborts slow requests", async () => {
  const slow = (url, init) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ ok: true }), 2000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(init.signal.reason);
      });
    });
  const t0 = Date.now();
  await assert.rejects(fetchWithTimeout(slow, "http://x", {}, 50));
  assert.ok(Date.now() - t0 < 1000);
});

test("verifiedBatchParams builds parallel arrays and dedupes item ids (last wins)", () => {
  const params = verifiedBatchParams({ queryNorm: "q", query: "Q" }, [
    { id: "1", title: "a", price: 10, matchScore: 0.9 },
    { id: "2", title: "b", price: 20, matchScore: 0.8, soldDate: "Sold Oct 1", url: "u" },
    { id: "1", title: "a2", price: 11, matchScore: 0.95 },
  ]);
  assert.equal(params[0], "q");
  assert.equal(params[1], "Q");
  assert.deepEqual(params[2], ["1", "2"]);
  assert.deepEqual(params[3], ["a2", "b"]);
  assert.deepEqual(params[4], [11, 20]);
  assert.deepEqual(params[6], [null, "Sold Oct 1"]);
});

test("writePostgres uses one transaction and one batched verified_prices upsert", async () => {
  const log = [];
  const applied = new Set();
  let released = 0;
  const client = {
    async query(sql, params) {
      log.push({ sql: String(sql), params });
      return { rows: [] };
    },
    release() {
      released += 1;
    },
  };
  const pool = {
    async query(sql, params) {
      if (/SELECT version FROM schema_migrations/i.test(sql)) {
        return { rows: [...applied].map((version) => ({ version })) };
      }
      if (/INSERT INTO schema_migrations/i.test(sql)) applied.add(Number(params[0]));
      return { rows: [] };
    },
    async connect() {
      return client;
    },
  };
  const comps = Array.from({ length: 25 }, (_, i) => ({ id: String(i), title: "t", price: 10 + i, matchScore: 0.9 }));
  const res = await writePostgres(pool, { query: "q", queryNorm: "q", comps, nKept: 25 });
  assert.equal(res.ok, true);
  assert.deepEqual(
    log.map((l) => (/^BEGIN|^COMMIT/.test(l.sql) ? l.sql : /tape_snapshots/.test(l.sql) ? "SNAP" : "VERIFIED")),
    ["BEGIN", "SNAP", "VERIFIED", "COMMIT"],
  );
  assert.match(log[2].sql, /unnest/);
  assert.equal(log[2].params[2].length, 25);
  assert.equal(released, 1);

  // Failure rolls back and still releases the client.
  log.length = 0;
  client.query = async (sql) => {
    log.push({ sql: String(sql) });
    if (/verified_prices/.test(sql)) throw new Error("boom");
    return { rows: [] };
  };
  await assert.rejects(writePostgres(pool, { query: "q", queryNorm: "q", comps }));
  assert.ok(log.some((l) => l.sql === "ROLLBACK"));
  assert.equal(released, 2);
});

test("writeScratch commits prune + rows + scan in one transaction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-sync-"));
  const db = openScratch(path.join(dir, "s.sqlite"));
  const mode = db.prepare("PRAGMA journal_mode").get();
  assert.equal(String(Object.values(mode)[0]).toLowerCase(), "wal");
  const listings = Array.from({ length: 200 }, (_, i) => ({ id: i, title: `t${i}`, price: i, flags: ["weak_title"] }));
  writeScratch(db, { snapshot: { query: "Q", queryNorm: "q" }, scratch: { listings } });
  const pulled = getScratchSqlite(db, "q", 100);
  assert.equal(pulled.listings.length, 100);
  assert.equal(pulled.scans.length, 1);
  assert.equal(pulled.scans[0].nRaw, 200);
  // A bad row aborts the whole write (no half-written scan).
  assert.throws(() =>
    writeScratch(db, { snapshot: { query: "Q", queryNorm: "q" }, scratch: { listings: [{ title: Symbol("x") }] } }),
  );
  assert.equal(getScratchSqlite(db, "q", 100).scans.length, 1);
  db.close();
});

test("background GV_TAPE_PUT responds without waiting for POST /tape", async () => {
  const root = path.join(__dirname, "..");
  const area = memArea({ tapeApi: "http://127.0.0.1:9", tapeSecret: "s", catalog: [] });
  const listeners = [];
  const posts = [];
  let finishPost;
  const fakeFetch = (url, init) => {
    if (String(url).endsWith("/tape") && init && init.method === "POST") {
      posts.push(JSON.parse(init.body));
      return new Promise((resolve) => {
        finishPost = () => resolve({ ok: true, status: 200, text: async () => "{}" });
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" });
  };
  const chrome = {
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener: (fn) => listeners.push(fn) } },
    storage: { local: area, onChanged: area.onChanged },
    tabs: { create() {} },
  };
  const sw = { console, URL, URLSearchParams, setTimeout, clearTimeout, AbortSignal, structuredClone, chrome, fetch: fakeFetch };
  sw.self = sw;
  sw.globalThis = sw;
  sw.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), sw);
  };
  vm.createContext(sw);
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), sw);
  const send = (msg) =>
    new Promise((resolve) => {
      for (const fn of listeners) if (fn(msg, {}, resolve) === true) return;
    });
  const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
  const verified = sw.GV.verifyComps(query, [
    { id: "a", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99", price: 120, soldDate: "Sold Oct 1, 2026" },
    { id: "b", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 22/99", price: 110, soldDate: "Sold Oct 2, 2026" },
  ]);
  const res = await send({ type: "GV_TAPE_PUT", query, verified, url: "https://www.ebay.com/sch/i.html", pageMode: "sold" });
  assert.ok(res.snapshot, "capture answered");
  assert.equal(res.snapshot.queryNorm, sw.GV.fold(query));
  // Local tape is written before the response; the POST is still in flight.
  assert.equal(area.data.tapeSnapshots.length, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(posts.length, 1);
  assert.equal(area.data.tapeOutbox.length, 1);
  finishPost();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(area.data.tapeOutbox, []);
  assert.equal(area.data.tapeSync.ok, true);
});

test("suggestPostgres: short needles use the prefix index, 3+ chars add substring", async () => {
  const { suggestPostgres } = require("../server/store");
  const seen = [];
  const pool = { async query(sql, params) { seen.push({ sql: String(sql), params }); return { rows: [] }; } };
  await suggestPostgres(pool, "Wo", 8);
  assert.doesNotMatch(seen[0].sql, /ILIKE/);
  assert.deepEqual(seen[0].params, ["wo%", 8]);
  await suggestPostgres(pool, "50%_off", 8);
  assert.match(seen[1].sql, /ILIKE/);
  assert.deepEqual(seen[1].params, ["%50\\%\\_off%", "50\\%\\_off%", 8]);
});
