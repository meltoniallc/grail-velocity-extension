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

test("live asks scrape high-match titles but never enter sold tape", async () => {
  const store = Tape.create(memoryAdapter());
  const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
  const verified = GV.verifyComps(query, [
    {
      id: "live-a",
      title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99",
      price: 445,
      kind: "active",
    },
    {
      id: "live-b",
      title: "2023 Panini Prizm Victor Wembanyama #5 Silver",
      price: 12,
      kind: "active",
    },
  ]);
  assert.ok(verified.rows.some((r) => r.keep && r.kind === "active"));
  await store.putScan({ query, verified, velocity: { fastCashPrice: null } });
  const snap = await store.getSnapshot(query);
  assert.equal(snap.comps.length, 0);
  assert.equal(snap.fastCash, null);
  const scratch = await store.getScratch(query);
  assert.ok(scratch.listings.some((l) => /Mercury/.test(l.title) && l.kind === "active"));
});

test("live-only scan ignores overlay Fast-Cash and does not wipe later sold tape", async () => {
  const store = Tape.create(memoryAdapter());
  const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
  await store.putScan({
    query,
    verified: GV.verifyComps(query, [
      {
        id: "live-a",
        title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99",
        price: 445,
        kind: "active",
      },
      {
        id: "live-b",
        title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 22/99",
        price: 410,
        kind: "active",
      },
    ]),
    velocity: { fastCashPrice: 999 },
  });
  assert.equal((await store.getSnapshot(query)).fastCash, null);

  await store.putScan({
    query,
    verified: GV.verifyComps(query, [
      { id: "sold-a", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99", price: 120, kind: "sold" },
      { id: "sold-b", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 22/99", price: 110, kind: "sold" },
    ]),
  });
  const sold = await store.getSnapshot(query);
  assert.equal(sold.comps.length, 2);
  assert.ok(sold.fastCash > 90);

  await store.putScan({
    query,
    verified: GV.verifyComps(query, [
      {
        id: "live-c",
        title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 33/99",
        price: 9,
        kind: "active",
      },
    ]),
    velocity: { fastCashPrice: 8.82 },
  });
  const afterLive = await store.getSnapshot(query);
  assert.equal(afterLive.comps.length, 2);
  assert.ok(afterLive.comps.every((c) => c.price >= 110));
  assert.equal(afterLive.fastCash, sold.fastCash);
});

test("scoreVelocity never prices live asks, even when they match tighter than solds", () => {
  const sold = [
    { keep: true, kind: "sold", price: 120, matchScore: 0.9 },
    { keep: true, kind: "sold", price: 110, matchScore: 0.9 },
  ];
  const live = [
    { keep: true, kind: "active", price: 9, matchScore: 0.99 },
    { keep: true, kind: "active", price: 11, matchScore: 0.99 },
  ];
  const fromSold = GV.scoreVelocity({ verified: sold });
  const mixed = GV.scoreVelocity({ verified: [...sold, ...live] });
  const liveOnly = GV.scoreVelocity({ verified: live });
  assert.equal(fromSold.fastCashPrice, mixed.fastCashPrice);
  assert.ok(mixed.fastCashPrice > 90);
  assert.equal(liveOnly.fastCashPrice, null);
  assert.equal(liveOnly.action, "QUARANTINE");
  assert.deepEqual(GV.soldVerified([...sold, ...live]).map((r) => r.price), [120, 110]);
});
