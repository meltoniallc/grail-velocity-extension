"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts } = require("./load-core");

const ctx = loadScripts(["lib/core.js", "lib/tape.js"]);
const GV = ctx.GV;
const Tape = ctx.GVTape;

function memoryAdapter(seed = {}) {
  const bag = {
    snapshots: seed.snapshots ? [...seed.snapshots] : [],
    scratch: seed.scratch ? [...seed.scratch] : [],
  };
  return {
    bag,
    async load() {
      return { snapshots: bag.snapshots, scratch: bag.scratch };
    },
    async saveSnapshots(snapshots) {
      bag.snapshots = snapshots;
    },
    async saveScratch(scratch) {
      bag.scratch = scratch;
    },
    async pushRemote() {
      return { ok: true, skipped: "memory" };
    },
  };
}

test("stores only kept high-match comps in the durable tape", async () => {
  const store = Tape.create(memoryAdapter());
  const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
  const verified = GV.verifyComps(query, [
    { id: "a", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99", price: 120 },
    { id: "b", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 22/99", price: 110 },
    { id: "c", title: "2023 Panini Prizm Victor Wembanyama #5 Silver", price: 4.99 },
    { id: "d", title: "Wembanyama lot of 10", price: 8 },
  ]);
  const velocity = GV.scoreVelocity({ verified: verified.rows, cogs: 80 });
  await store.putScan({
    query,
    verified,
    velocity,
    url: "https://www.ebay.com/sch/i.html?_nkw=mercury",
  });
  const snap = await store.getSnapshot(query);
  assert.ok(snap);
  assert.ok(snap.comps.every((c) => c.keep && c.price >= 100));
  assert.equal(snap.nKept, 2);
  assert.ok(snap.fastCash > 90);

  const scratch = await store.getScratch(query);
  assert.ok(scratch.listings.some((l) => /Prizm|lot/i.test(l.title)));
  assert.ok(scratch.listings.every((l) => !l.keep));
});

test("prefix lookup hits the stored snapshot on character 1", async () => {
  const store = Tape.create(memoryAdapter());
  await store.putScan({
    query: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99",
    verified: GV.verifyComps("2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99", [
      { id: "a", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99", price: 120 },
      { id: "b", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 22/99", price: 110 },
    ]),
    velocity: { fastCashPrice: 107.8, median: 115, nKept: 2 },
  });
  const hits = await store.suggest("2", { catalog: [] });
  assert.equal(hits[0].kind, "tape");
  assert.ok(hits[0].fastCash > 100);
});

test("merges later sold pages without reintroducing cliff junk", async () => {
  const store = Tape.create(memoryAdapter());
  const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
  await store.putScan({
    query,
    verified: GV.verifyComps(query, [
      { id: "a", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99", price: 120 },
    ]),
    velocity: { fastCashPrice: 117.6, nKept: 1 },
  });
  await store.putScan({
    query,
    verified: GV.verifyComps(query, [
      { id: "b", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 22/99", price: 110 },
      { id: "junk", title: "Wembanyama mystery grab bag", price: 1 },
    ]),
    velocity: { fastCashPrice: 107.8, nKept: 1 },
  });
  const snap = await store.getSnapshot(query);
  assert.equal(snap.comps.length, 2);
  assert.ok(snap.comps.every((c) => c.price >= 110));
});
