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

test("local tape miss or thin triggers remote fallback gate; rich local tape does not", () => {
  assert.equal(GV.LOCAL_TAPE_THIN, 2);
  assert.equal(GV.localTapeThin([]), true);
  assert.equal(GV.localTapeThin([{ kind: "book", title: "catalog only" }]), true);
  assert.equal(GV.localTapeThin([{ kind: "tape", title: "one" }]), true);
  assert.equal(
    GV.localTapeThin([
      { kind: "tape", title: "a" },
      { kind: "tape", title: "b" },
    ]),
    false,
  );
  assert.equal(GV.countTapeHits([{ kind: "tape" }, { kind: "book" }, { kind: "tape" }]), 2);
});

test("mergeSuggestHits keeps local first and only accepts remote tape rows", () => {
  const local = GV.suggestTape("2023", { tape: TAPE, catalog: CATALOG, limit: 8 });
  assert.ok(local.some((h) => h.kind === "tape"));
  const remote = [
    {
      kind: "tape",
      query: "2024-25 Select Victor Wembanyama #1",
      title: "2024-25 Select Victor Wembanyama #1",
      fastCash: 55.5,
      nKept: 3,
    },
    {
      kind: "book",
      query: "should never appear from remote",
      title: "should never appear from remote",
      fastCash: 1,
    },
    {
      kind: "tape",
      query: TAPE[0].query,
      title: TAPE[0].title,
      fastCash: 999,
      nKept: 99,
    },
  ];
  const merged = GV.mergeSuggestHits(local, remote, { limit: 8 });
  assert.ok(merged.every((h) => h.kind === "tape" || h.kind === "book"));
  assert.equal(
    merged.some((h) => /should never appear/i.test(h.title || "")),
    false,
    "remote catalog must not enter typeahead",
  );
  const localMercury = merged.find((h) => /Mercury/i.test(h.title || "") && h.kind === "tape");
  assert.ok(localMercury);
  assert.equal(localMercury.fastCash, 101.92, "local tape wins over duplicate remote");
  assert.ok(merged.some((h) => /Select Victor Wembanyama #1/i.test(h.title || "")));
});

test("mergeSuggestHits fills cold local from remote tape without inventing book Fast-Cash", () => {
  const local = GV.suggestTape("select wemby", { tape: [], catalog: CATALOG, limit: 8 });
  assert.equal(GV.localTapeThin(local), true);
  assert.ok(local.every((h) => h.kind === "book") || local.length === 0);
  const remote = [
    {
      kind: "tape",
      query: "2024-25 Select Victor Wembanyama #1",
      title: "2024-25 Select Victor Wembanyama #1",
      fastCash: 55.5,
      nKept: 3,
    },
  ];
  const merged = GV.mergeSuggestHits(local, remote, { limit: 8 });
  const tape = merged.filter((h) => h.kind === "tape");
  assert.equal(tape.length, 1);
  assert.equal(tape[0].fastCash, 55.5);
  assert.equal(tape[0].kind, "tape");
});
