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

test("putScan contract: sold keeps durable; live asks and rejects go to scratch", async () => {
  const adapter = memoryAdapter();
  const store = Tape.create(adapter);
  const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
  const verified = {
    rows: [
      {
        id: "sold-keep",
        title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99",
        price: 120,
        keep: true,
        kind: "sold",
        soldDate: "Sold Mar 1, 2026",
        matchScore: 0.95,
        flags: [],
      },
      {
        id: "live-ask",
        title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 12/99",
        price: 200,
        keep: true,
        kind: "active",
        matchScore: 0.94,
        flags: [],
      },
      {
        id: "drop",
        title: "Wembanyama lot of 10",
        price: 8,
        keep: false,
        kind: "active",
        matchScore: 0.2,
        flags: ["beyond_cliff"],
        reason: "cliff",
      },
    ],
    nCliff: 1,
    stoppedAt: 2,
    nRaw: 3,
    nKept: 2,
  };
  const split = Tape.splitScanRows(verified.rows);
  assert.equal(split.keptSold.length, 1);
  assert.equal(split.keptSold[0].id, "sold-keep");
  assert.equal(split.parked.length, 2);
  assert.ok(split.parked.every((r) => r.id !== "sold-keep"));

  await store.putScan({
    query,
    verified,
    mode: "manual",
    pageMode: "sold",
    stoppedAt: 2,
    nCliff: 1,
    url: "https://www.ebay.com/sch/i.html?LH_Sold=1",
  });
  const snap = await store.getSnapshot(query);
  assert.equal(snap.comps.length, 1);
  assert.equal(snap.comps[0].id, "sold-keep");
  assert.equal(snap.mode, "manual");
  assert.equal(snap.pageMode, "sold");
  assert.equal(snap.stoppedAt, 2);
  assert.equal(snap.nCliff, 1);

  const scratch = adapter.bag.scratch[0];
  assert.equal(scratch.mode, "manual");
  assert.equal(scratch.pageMode, "sold");
  assert.equal(scratch.stoppedAt, 2);
  assert.equal(scratch.nCliff, 1);
  assert.ok(scratch.listings.some((l) => l.id === "live-ask"));
  assert.ok(scratch.listings.some((l) => l.id === "drop"));
  assert.equal(
    scratch.listings.some((l) => l.id === "sold-keep"),
    false,
  );
});

test("putScan defaults capture mode to auto and carries pageMode", async () => {
  const adapter = memoryAdapter();
  const store = Tape.create(adapter);
  const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
  await store.putScan({
    query,
    pageMode: "live",
    verified: GV.verifyComps(query, [
      {
        id: "a",
        title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99",
        price: 120,
        kind: "active",
      },
    ]),
  });
  const scratch = adapter.bag.scratch[0];
  assert.equal(scratch.mode, "auto");
  assert.equal(scratch.pageMode, "live");
  const snap = await store.getSnapshot(query);
  assert.equal(snap.comps.length, 0);
  assert.equal(snap.fastCash, null);
});

test("putScan coalesces remote push when snapshot and scratch set are unchanged", async () => {
  let pushes = 0;
  const bag = { snapshots: [], scratch: [] };
  const adapter = {
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
      pushes += 1;
      return { ok: true };
    },
  };
  const store = Tape.create(adapter);
  const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
  const verified = GV.verifyComps(query, [
    {
      id: "a",
      title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99",
      price: 120,
      soldDate: "Sold Mar 1, 2026",
    },
    {
      id: "b",
      title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 22/99",
      price: 110,
      soldDate: "Sold Mar 2, 2026",
    },
  ]);
  await store.putScan({ query, verified, mode: "auto", pageMode: "sold" });
  assert.equal(pushes, 1);
  const snapsAfterFirst = bag.snapshots.length;
  const scratchAfterFirst = bag.scratch.length;
  await store.putScan({ query, verified, mode: "auto", pageMode: "sold" });
  assert.equal(pushes, 1, "identical rescan must not re-POST /tape");
  assert.equal(bag.snapshots.length, snapsAfterFirst);
  assert.ok(bag.scratch.length >= scratchAfterFirst, "local scratch still appends");
  await store.putScan({
    query,
    verified: GV.verifyComps(query, [
      {
        id: "c",
        title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 33/99",
        price: 115,
        soldDate: "Sold Mar 3, 2026",
      },
    ]),
    mode: "auto",
    pageMode: "sold",
  });
  assert.equal(pushes, 2, "new durable comp must push");
  assert.equal(Tape.remotePushNeeded(null, null, { queryNorm: "x", comps: [{ id: "1", price: 1 }] }, { listings: [] }), true);
  assert.equal(
    Tape.remotePushNeeded(
      { queryNorm: "x", comps: [{ id: "1", price: 1, kind: "sold", matchScore: 0.9 }], nCliff: 0 },
      { queryNorm: "x", listings: [{ id: "d", price: 2, kind: "dropped", keep: false, flags: [] }], nCliff: 0, stoppedAt: null },
      { queryNorm: "x", comps: [{ id: "1", price: 1, kind: "sold", matchScore: 0.9 }], nCliff: 0 },
      { queryNorm: "x", listings: [{ id: "d", price: 2, kind: "dropped", keep: false, flags: [] }], nCliff: 0, stoppedAt: null },
    ),
    false,
  );
});
