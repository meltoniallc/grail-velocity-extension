"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts } = require("./load-core");

const { GVObserve, GVOutbox, GVCaptureRuntime } = loadScripts([
  "lib/observe.js",
  "lib/outbox.js",
  "lib/capture-runtime.js",
]);

function memoryStorage(seed = {}) {
  const data = { ...seed };
  return {
    data,
    async get(keys) {
      const out = {};
      for (const key of keys) out[key] = data[key];
      return out;
    },
    async set(values) {
      Object.assign(data, values);
    },
  };
}

function runtime(extra = {}) {
  const storage = extra.storage || memoryStorage();
  const badges = [];
  const posts = [];
  let failPost = extra.failPost || false;
  const rt = GVCaptureRuntime.createCaptureRuntime({
    storage,
    outbox: GVOutbox.createMemoryOutbox(),
    now: () => extra.now(),
    setBadge: async (text) => {
      badges.push(text);
    },
    postObserve: async (rows) => {
      posts.push(rows);
      if (failPost) return { ok: false, error: "down" };
      return { ok: true };
    },
  });
  return {
    rt,
    storage,
    badges,
    posts,
    setFail(next) {
      failPost = next;
    },
  };
}

const obs = {
  site: "ebay",
  page_type: "item",
  url: "https://www.ebay.com/itm/123456789012",
  item_id: "123456789012",
  title: "2023-24 Topps Chrome Victor Wembanyama #1",
  price: 425,
  status: "sold",
  sold_date: "Feb 2, 2026",
  seller_username: "zz-shop-9f3",
  feedback_count: 50,
};

test("runtime queues a viewed page, hides the seller, and respects the URL cap", async () => {
  let now = Date.parse("2026-10-13T15:00:00Z");
  const box = runtime({
    now: () => now,
    storage: memoryStorage({
      captureSettings: { sellerHmacSecret: "hmac-secret", ownSellerId: "meltonia" },
    }),
  });
  const first = await box.rt.onObserve("https://www.ebay.com/itm/123456789012?gclid=1", [obs]);
  assert.equal(first.accepted, 1);
  assert.equal(box.badges.at(-1), "1");
  const status = await box.rt.status();
  const blob = JSON.stringify(status);
  assert.equal(blob.includes("zz-shop-9f3"), false);
  assert.equal(blob.includes("hmac-secret"), false);
  assert.equal(status.hasSellerSecret, true);
  assert.equal(status.today, 1);
  assert.equal(status.queue, 1);
  assert.equal(status.last.title.includes("Wembanyama"), true);
  const second = await box.rt.onObserve("https://www.ebay.com/itm/123456789012", [obs]);
  assert.equal(second.reason, "url-cooldown");
  await box.rt.update({ captureEnabled: false });
  assert.equal(box.storage.data.captureSettings.sellerHmacSecret, "hmac-secret");
  const paused = await box.rt.pauseFor(60 * 60 * 1000);
  assert.ok(paused.capturePausedUntil > now);
});

test("failed flush keeps the queue and a later flush clears it", async () => {
  let now = Date.parse("2026-10-13T16:00:00Z");
  const box = runtime({ now: () => now, failPost: true });
  await box.rt.onObserve("https://www.ebay.com/itm/223456789012", [{ ...obs, item_id: "223456789012" }]);
  const failed = await box.rt.flush();
  assert.equal(failed.ok, false);
  assert.equal((await box.rt.status()).queue, 1);
  box.setFail(false);
  const sent = await box.rt.flush();
  assert.equal(sent.sent, 1);
  assert.equal((await box.rt.status()).queue, 0);
  const hits = await box.rt.lookup("wembanyama");
  assert.equal(hits.length, 1);
});

test("IndexedDB outbox dedupes by raw hash", async () => {
  const fake = require("fake-indexeddb");
  globalThis.indexedDB = fake.indexedDB;
  delete require.cache[require.resolve("../lib/outbox.js")];
  require("../lib/outbox.js");
  const outbox = globalThis.GVOutbox.createIdbOutbox();
  const row = { raw_hash: "abc", title: "One" };
  assert.equal(await outbox.putMany([row, row]), 1);
  assert.equal(await outbox.putMany([row]), 0);
  assert.equal(await outbox.size(), 1);
  const peeked = await outbox.peek(10);
  assert.equal(peeked.length, 1);
  await outbox.remove(["abc"]);
  assert.equal(await outbox.size(), 0);
});
