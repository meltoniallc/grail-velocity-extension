"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts } = require("./load-core");

const { GV } = loadScripts(["lib/core.js", "lib/suggest.js"]);

const CATALOG = [
  {
    id: "001036",
    title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor Rookie RC SP 74/99 Spurs",
    player: "Victor Wembanyama",
    fastCash: 99.99,
    listPrice: 445,
  },
];

const TAPE = [
  {
    query: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99",
    title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99",
    fastCash: 101.92,
    nKept: 6,
    at: 1,
  },
];

test("loadCatalog returns fresh storage cache without fetching", async () => {
  let fetched = false;
  const storage = {
    async get() {
      return { catalog: CATALOG, catalogAt: Date.now() };
    },
    async set() {
      throw new Error("should not write");
    },
  };
  const out = await GV.loadCatalog({
    storage,
    getURL: () => "catalog.json",
    fetch: async () => {
      fetched = true;
      throw new Error("no fetch");
    },
  });
  assert.equal(fetched, false);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "001036");
});

test("loadCatalog refetches when catalogAt is older than maxAge", async () => {
  let wrote = null;
  const fresh = [{ id: "new", title: "Fresh row" }];
  const storage = {
    async get() {
      return { catalog: CATALOG, catalogAt: Date.now() - GV.CATALOG_MAX_AGE_MS - 1000 };
    },
    async set(payload) {
      wrote = payload;
    },
  };
  const out = await GV.loadCatalog({
    storage,
    getURL: (p) => `chrome-ext://${p}`,
    fetch: async (url) => {
      assert.equal(url, "chrome-ext://catalog.json");
      return {
        async json() {
          return fresh;
        },
      };
    },
  });
  assert.deepEqual(out, fresh);
  assert.ok(wrote?.catalogAt);
  assert.deepEqual(wrote.catalog, fresh);
});

test("loadCatalog storage-only returns [] when cache miss and fetch disabled", async () => {
  const out = await GV.loadCatalog({
    storage: {
      async get() {
        return {};
      },
    },
    fetch: false,
  });
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 0);
});

test("suggestLocalFirst prefers GV_SUGGEST hits and never opens sold tabs", async () => {
  const messages = [];
  const hits = await GV.suggestLocalFirst("mercury", {
    catalog: CATALOG,
    tape: TAPE,
    limit: 8,
    sendMessage: async (msg) => {
      messages.push(msg);
      return { hits: [{ kind: "tape", title: "from background", fastCash: 50, nKept: 2 }] };
    },
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "GV_SUGGEST");
  assert.equal(messages[0].q, "mercury");
  assert.equal(hits[0].title, "from background");
  assert.ok(!messages.some((m) => m.type === "GV_SOLD"));
});

test("suggestLocalFirst falls back to suggestTape when messaging fails", async () => {
  const hits = await GV.suggestLocalFirst("2", {
    catalog: CATALOG,
    tape: TAPE,
    limit: 8,
    sendMessage: async () => {
      throw new Error("worker down");
    },
  });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].kind, "tape");
  assert.ok(String(hits[0].title).toLowerCase().startsWith("2"));
});

test("suggestLocalFirst returns [] for blank query without messaging", async () => {
  let called = false;
  const hits = await GV.suggestLocalFirst("   ", {
    catalog: CATALOG,
    tape: TAPE,
    sendMessage: async () => {
      called = true;
      return { hits: [{ kind: "tape", title: "nope" }] };
    },
  });
  assert.equal(called, false);
  assert.ok(Array.isArray(hits));
  assert.equal(hits.length, 0);
});

test("suggestLocalFirst uses in-page suggestTape when sendMessage is absent", async () => {
  const hits = await GV.suggestLocalFirst("wemby mercury #5", {
    catalog: CATALOG,
    tape: TAPE,
    limit: 8,
    sendMessage: null,
  });
  assert.ok(hits.length >= 1);
});
