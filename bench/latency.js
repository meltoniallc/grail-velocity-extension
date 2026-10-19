"use strict";
/**
 * Grail Velocity latency bench (local only; never touches eBay).
 *
 *   node bench/latency.js                 # SQLite-only server
 *   DATABASE_URL=postgres://... node bench/latency.js   # + Postgres (TRUNCATES tape tables!)
 *   BENCH_RTT_MS=80 ...                   # add a WAN-like delay proxy in front of the server
 *
 * Measures: POST /tape (capture -> DB write), GET /suggest, GET /tape, and the
 * extension service-worker paths (GV_TAPE_PUT, GV_SUGGEST, GV_TAPE_GET cold) by
 * loading background.js in a vm with a stubbed chrome.* API.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const vm = require("node:vm");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const DATABASE_URL = process.env.DATABASE_URL || "";
const RTT = Number(process.env.BENCH_RTT_MS || 0);
const SEED = Number(process.env.BENCH_SEED || 20000);
const ITER = Number(process.env.BENCH_ITER || 150);
const SECRET = "bench-secret";

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function summarize(name, samples) {
  return { name, n: samples.length, p50: +pct(samples, 50).toFixed(2), p95: +pct(samples, 95).toFixed(2) };
}
async function timeit(fn) {
  const t = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}

function startServer(env) {
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    child.stderr.on("data", (c) => {
      buf += c;
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.once("exit", (code) => reject(new Error("server exited " + code + "\n" + buf)));
  });
}

/** Tiny delay proxy so we can model Railway/WAN round trips. */
function startProxy(targetPort, rtt) {
  const agent = new http.Agent({ keepAlive: true });
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      setTimeout(() => {
        const up = http.request(
          { host: "127.0.0.1", port: targetPort, path: req.url, method: req.method, headers: req.headers, agent },
          (r) => {
            const out = [];
            r.on("data", (c) => out.push(c));
            r.on("end", () => setTimeout(() => {
              res.writeHead(r.statusCode, r.headers);
              res.end(Buffer.concat(out));
            }, rtt / 2));
          },
        );
        up.end(Buffer.concat(chunks));
      }, rtt / 2);
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, port: srv.address().port })));
}

function compsFor(i, n) {
  return Array.from({ length: n }, (_, k) => ({
    id: `item-${i}-${k}`,
    title: `2023-24 Topps Chrome Player${i} #${i % 300} Refractor ${k + 1}/99`,
    price: 50 + ((i * 7 + k) % 200),
    matchScore: 0.9,
    soldDate: "Oct 10, 2026",
    url: `https://www.ebay.com/itm/${i}${k}`,
    kind: "sold",
    keep: true,
  }));
}
function payloadFor(i) {
  const query = `2023-24 Topps Chrome Player${i} #${i % 300} Refractor /99 bench`;
  const comps = compsFor(i, 40);
  return {
    snapshot: {
      query,
      queryNorm: query.toLowerCase(),
      comps,
      nKept: comps.length,
      nRaw: 100,
      nCliff: 3,
      median: 120,
      p25: 100,
      p75: 140,
      fastCash: 98.5,
    },
    scratch: {
      query,
      queryNorm: query.toLowerCase(),
      listings: Array.from({ length: 60 }, (_, k) => ({
        id: `x-${i}-${k}`,
        title: `noise listing ${k} for ${query}`,
        price: 4.99 + k,
        matchScore: 0.3,
        flags: k > 50 ? ["beyond_cliff"] : ["weak_title"],
        reason: "weak_title",
      })),
    },
  };
}

async function seedPostgres() {
  const { Client } = require("pg");
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  await c.query("TRUNCATE tape_snapshots, verified_prices");
  await c.query(
    `INSERT INTO tape_snapshots (query_norm, query_raw, n_kept, n_raw, n_cliff, median, p25, p75, fast_cash, comps_json, updated_at)
     SELECT 'seed ' || g || ' panini prizm player' || (g % 5000) || ' silver #' || (g % 400),
            'Seed ' || g || ' Panini Prizm Player' || (g % 5000) || ' Silver #' || (g % 400),
            12, 40, 2, 80, 60, 100, 70, '[]'::jsonb, now() - (g || ' seconds')::interval
       FROM generate_series(1, $1) g`,
    [SEED],
  );
  await c.query(
    `INSERT INTO verified_prices (query_norm, item_id, query_raw, title, price, match_score, sold_date, url)
     SELECT 'seed ' || (g % $1) || ' panini prizm player' || ((g % $1) % 5000) || ' silver #' || ((g % $1) % 400),
            'v' || g, 'q', 'title ' || g, 50 + (g % 90), 0.9, 'Oct 1, 2026', 'https://www.ebay.com/itm/' || g
       FROM generate_series(1, $1 * 10) g`,
    [SEED],
  );
  await c.query("ANALYZE tape_snapshots; ANALYZE verified_prices;");
  await c.end();
}

/** Load background.js with stubbed chrome.* so we time the real service-worker code. */
function loadBackground(tapeApi, nLocalSnaps) {
  const store = {
    tapeApi,
    tapeSecret: SECRET,
    catalog: JSON.parse(fs.readFileSync(path.join(ROOT, "catalog.json"), "utf8")),
    tapeSnapshots: Array.from({ length: nLocalSnaps }, (_, i) => ({
      query: `Local Topps Chrome Player${i} #${i}`,
      queryNorm: `local topps chrome player${i} #${i}`,
      title: `Local Topps Chrome Player${i} #${i}`,
      comps: compsFor(100000 + i, 12),
      nKept: 12,
      fastCash: 50,
      at: Date.now() - i * 1000,
    })),
    tapeScratch: [],
  };
  const listeners = [];
  const changeListeners = [];
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getURL: (p) => p,
    },
    sidePanel: {},
    alarms: { create() {}, onAlarm: { addListener() {} } },
    storage: {
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
      local: {
        async get(keys) {
          const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(store);
          const out = {};
          for (const k of ks) if (store[k] !== undefined) out[k] = clone(store[k]);
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: clone(v) };
            store[k] = clone(v);
          }
          for (const fn of changeListeners) fn(changes, "local");
        },
      },
    },
    tabs: { create() {} },
  };
  const ctx = {
    console, URL, URLSearchParams, fetch, AbortController, AbortSignal, setTimeout, clearTimeout,
    setInterval, clearInterval, structuredClone, TextEncoder, TextDecoder, chrome, Promise,
  };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx);
  const send = (msg) =>
    new Promise((resolve) => {
      for (const fn of listeners) {
        const r = fn(msg, { tab: { id: 1 } }, resolve);
        if (r === true) return;
      }
    });
  return { send, store, ctx };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-bench-"));
  const { child, port } = await startServer({
    PORT: "0",
    SQLITE_PATH: path.join(dir, "scratch.sqlite"),
    DATABASE_URL,
    TAPE_SECRET: SECRET,
    TAPE_SECRET_FILE: path.join(dir, "tape.secret"),
  });
  let proxy = null;
  let base = `http://127.0.0.1:${port}`;
  if (RTT > 0) {
    proxy = await startProxy(port, RTT);
    base = `http://127.0.0.1:${proxy.port}`;
  }
  const H = { "X-Tape-Secret": SECRET };
  const results = [];
  try {
    // Warm (also applies migrations on old builds).
    await fetch(`${base}/tape?q=warm`, { headers: H }).then((r) => r.text());
    if (DATABASE_URL) await seedPostgres();

    const post = [];
    for (let i = 0; i < ITER; i += 1) {
      const body = JSON.stringify(payloadFor(i));
      post.push(await timeit(async () => {
        const r = await fetch(`${base}/tape`, {
          method: "POST",
          headers: { ...H, "Content-Type": "application/json" },
          body,
        });
        const j = await r.json();
        if (!j.ok) throw new Error(JSON.stringify(j));
      }));
    }
    results.push(summarize("POST /tape (40 comps + 60 scratch)", post));

    const prefixes = ["s", "se", "seed 1", "panini", "prizm player42", "silver #12", "player4999", "topps chrome"];
    const sug = [];
    let suggestBytes = 0;
    for (let i = 0; i < ITER; i += 1) {
      const q = prefixes[i % prefixes.length];
      sug.push(await timeit(async () => {
        const r = await fetch(`${base}/suggest?q=${encodeURIComponent(q)}&limit=8`, { headers: H });
        suggestBytes = (await r.arrayBuffer()).byteLength;
      }));
    }
    results.push(summarize(`GET /suggest (${DATABASE_URL ? SEED + " snapshots" : "no pg"})`, sug));

    const tape = [];
    let tapeBytes = 0;
    for (let i = 0; i < ITER; i += 1) {
      const q = DATABASE_URL ? `seed ${(i * 37) % SEED} panini prizm player${((i * 37) % SEED) % 5000} silver #${((i * 37) % SEED) % 400}` : "x";
      tape.push(await timeit(async () => {
        const r = await fetch(`${base}/tape?q=${encodeURIComponent(q)}`, {
          headers: { ...H, "Accept-Encoding": "gzip" },
        });
        tapeBytes = Number(r.headers.get("content-length")) || (await r.arrayBuffer()).byteLength;
        await r.arrayBuffer().catch(() => {});
      }));
    }
    results.push(summarize("GET /tape pull (1 query_norm)", tape));

    // Service worker paths (real background.js, stubbed chrome.*).
    const { GV } = (() => {
      const c = { console, URL, URLSearchParams };
      c.self = c; c.globalThis = c;
      vm.createContext(c);
      vm.runInContext(fs.readFileSync(path.join(ROOT, "lib/core.js"), "utf8"), c);
      return c;
    })();
    const bg = loadBackground(base, 300);
    const put = [];
    for (let i = 0; i < Math.min(ITER, 60); i += 1) {
      const query = `2024 Bowman Chrome Prospect${i} #BCP-${i} Gold Refractor /50`;
      const listings = compsFor(500000 + i, 50).map((c, k) => ({ ...c, title: k < 30 ? `${query} ${k}/50` : `random lot ${k}` }));
      const verified = GV.verifyComps(query, listings);
      put.push(await timeit(() => bg.send({ type: "GV_TAPE_PUT", query, verified, url: "https://www.ebay.com/sch/i.html", mode: "auto", pageMode: "sold" })));
    }
    results.push(summarize("SW GV_TAPE_PUT (capture -> response)", put));
    // Let any deferred pushes drain before next phase.
    await new Promise((r) => setTimeout(r, 1500 + RTT * 5));

    const sw = [];
    const keys = ["w", "wem", "seed 9", "local topps", "player12", "bowman", "prizm", "zzz"];
    for (let i = 0; i < ITER; i += 1) {
      sw.push(await timeit(() => bg.send({ type: "GV_SUGGEST", q: keys[i % keys.length] })));
    }
    results.push(summarize("SW GV_SUGGEST typeahead (local tape ≤80 + remote fill)", sw));

    const cold = [];
    for (let i = 0; i < Math.min(ITER, 60); i += 1) {
      const q = DATABASE_URL ? `seed ${(i * 101) % SEED} panini prizm player${((i * 101) % SEED) % 5000} silver #${((i * 101) % SEED) % 400}` : `cold ${i}`;
      cold.push(await timeit(() => bg.send({ type: "GV_TAPE_GET", query: q })));
    }
    results.push(summarize("SW GV_TAPE_GET cold (hydrate from server)", cold));

    const meta = { postgres: Boolean(DATABASE_URL), rttMs: RTT, seed: DATABASE_URL ? SEED : 0, suggestBytes, tapeBytes, node: process.version };
    console.log(JSON.stringify({ meta, results }, null, 2));
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ meta, results }, null, 2));
  } finally {
    child.kill();
    if (proxy) proxy.srv.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
