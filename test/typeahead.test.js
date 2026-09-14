"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./load-core");

const { GV } = loadScript("lib/core.js");

const TAPE = [
  {
    query: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99",
    title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99",
    fastCash: 101.92,
    nKept: 6,
    at: 1,
  },
  {
    query: "2024-25 Hoops Victor Wembanyama Premium Prizms Blue 14/49",
    title: "2024-25 Hoops Victor Wembanyama Premium Prizms Blue 14/49",
    fastCash: 34.99,
    nKept: 4,
    at: 2,
  },
];

const CATALOG = [
  {
    id: "001036",
    title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor Rookie RC SP 74/99 Spurs",
    player: "Victor Wembanyama",
    fastCash: 99.99,
    listPrice: 445,
  },
  {
    id: "harper-1",
    title: "2025 Topps Chrome Dylan Harper RC",
    player: "Dylan Harper",
    fastCash: 40,
    listPrice: 80,
  },
];

test("suggests cached tape on the first typed characters", () => {
  const hits = GV.suggestTape("2", { tape: TAPE, catalog: CATALOG, limit: 8 });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].kind, "tape");
  assert.ok(String(hits[0].title).toLowerCase().startsWith("2"));
});

test("each extra character narrows to the Mercury #5 tape instantly", () => {
  let hits = GV.suggestTape("2023", { tape: TAPE, catalog: CATALOG });
  assert.ok(hits.some((h) => /Mercury/i.test(h.title)));

  hits = GV.suggestTape("2023-24 Topps Mercury Victor Wembanyama #5", {
    tape: TAPE,
    catalog: CATALOG,
  });
  assert.equal(hits[0].kind, "tape");
  assert.match(hits[0].title, /Mercury/);
  assert.equal(hits[0].fastCash, 101.92);
  assert.ok(!hits.some((h) => /Hoops/i.test(h.title)));
});

test("wemby alias hits Wembanyama catalog rows without opening a sold tab", () => {
  const hits = GV.suggestTape("wemby mercury #5", { tape: TAPE, catalog: CATALOG });
  assert.ok(hits.some((h) => /Wembanyama/i.test(h.title) && /Mercury/i.test(h.title)));
});

test("empty or whitespace query returns nothing so the desk stays quiet", () => {
  assert.equal(GV.suggestTape("  ", { tape: TAPE, catalog: CATALOG }).length, 0);
  assert.equal(GV.suggestTape("", { tape: TAPE, catalog: CATALOG }).length, 0);
});
