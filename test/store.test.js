"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openScratch, writeScratch } = require("../server/store");
const { loadScripts } = require("./load-core");

const { GV, GVTape } = loadScripts(["lib/core.js", "lib/tape.js"]);

test("sqlite scratch keeps rejected noise off the verified tape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-scratch-"));
  const db = openScratch(path.join(dir, "scratch.sqlite"));
  const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
  const verified = GV.verifyComps(query, [
    { id: "a", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99", price: 120 },
    { id: "b", title: "2023 Panini Prizm Victor Wembanyama #5 Silver", price: 4.99 },
    { id: "c", title: "Wembanyama mystery grab bag", price: 1 },
  ]);
  const adapter = {
    async load() {
      return { snapshots: [], scratch: [] };
    },
    async saveSnapshots() {},
    async saveScratch() {},
  };
  const mem = { snapshots: [], scratch: [] };
  adapter.load = async () => mem;
  adapter.saveSnapshots = async (s) => {
    mem.snapshots = s;
  };
  adapter.saveScratch = async (s) => {
    mem.scratch = s;
  };
  return GVTape.create(adapter)
    .putScan({ query, verified, velocity: { fastCashPrice: 117.6 } })
    .then((snap) => {
      writeScratch(db, {
        snapshot: snap,
        scratch: mem.scratch[0],
      });
      const noise = db.prepare("SELECT title, beyond_cliff FROM raw_listings ORDER BY id").all();
      assert.ok(noise.some((r) => /Prizm/i.test(r.title)));
      assert.equal(
        noise.every((r) => !/Mercury Victor Wembanyama #5 Refractor 11\/99/i.test(r.title)),
        true,
      );
      assert.ok(snap.comps.every((c) => c.price >= 100));
    });
});
