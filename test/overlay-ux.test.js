"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadScripts } = require("./load-core");

const { GV } = loadScripts(["lib/core.js", "lib/overlay.js"]);

function hostNode() {
  return {
    id: GV.OVERLAY_HOST_ID,
    nodeType: 1,
    closest(sel) {
      return sel === "#" + GV.OVERLAY_HOST_ID ? this : null;
    },
  };
}

function pageNode() {
  return {
    id: "srp-river",
    nodeType: 1,
    closest() {
      return null;
    },
  };
}

test("findingsText copies action, Fast-Cash, and kept sold comps only", () => {
  const text = GV.findingsText({
    query: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99",
    velocity: {
      action: "FAST_CASH",
      p25: 100,
      p75: 120,
      netMedian: 90,
      reasons: ["3 verified / 4 raw"],
      fastCashPrice: 98,
    },
    pageRows: [
      { keep: true, title: "live ask", price: 200 },
      { keep: false, title: "junk", price: 1 },
    ],
    soldTape: [
      { keep: true, title: "Mercury #5 Refractor 11/99", price: 118 },
      { keep: false, title: "Prizm near-miss", price: 4.99 },
    ],
  });
  assert.match(text, /Grail Velocity — 2023-24 Topps Mercury/);
  assert.match(text, /Action: FAST_CASH/);
  assert.match(text, /Fast-Cash: \$98\.00/);
  assert.match(text, /Page kept: 1\/2/);
  assert.match(text, /Sold kept: 1\/2/);
  assert.match(text, /Mercury #5 Refractor 11\/99/);
  assert.equal(/Prizm near-miss/.test(text), false);
  assert.match(text, /Why:/);
});

test("pageChanged ignores overlay host mutations and keeps SPA listing mutations", () => {
  const host = hostNode();
  const page = pageNode();
  assert.equal(
    GV.pageChanged([{ target: host, addedNodes: [{ id: "gv-inner", closest: host.closest.bind(host) }], removedNodes: [] }]),
    false,
  );
  assert.equal(
    GV.pageChanged([{ target: page, addedNodes: [page], removedNodes: [] }]),
    true,
  );
  assert.equal(GV.pageChanged([{ target: page, addedNodes: [], removedNodes: [], type: "attributes" }]), true);
  assert.equal(GV.pageChanged([]), false);
});

test("isOverlayToggleHotkey is Alt+Shift+G except in fields", () => {
  assert.equal(GV.isOverlayToggleHotkey({ altKey: true, shiftKey: true, key: "g", target: { tagName: "DIV" } }), true);
  assert.equal(GV.isOverlayToggleHotkey({ altKey: true, shiftKey: true, key: "G", target: { tagName: "BODY" } }), true);
  assert.equal(GV.isOverlayToggleHotkey({ altKey: true, shiftKey: true, key: "g", target: { tagName: "INPUT" } }), false);
  assert.equal(GV.isOverlayToggleHotkey({ altKey: true, shiftKey: true, key: "g", target: { tagName: "TEXTAREA" } }), false);
  assert.equal(
    GV.isOverlayToggleHotkey({ altKey: true, shiftKey: true, key: "g", target: { tagName: "DIV", isContentEditable: true } }),
    false,
  );
  assert.equal(GV.isOverlayToggleHotkey({ altKey: true, shiftKey: false, key: "g", target: { tagName: "DIV" } }), false);
});

test("preserveKeepToggles keeps operator flips across SPA rescan of the same query", () => {
  const prev = new Map([["a", false]]);
  const next = GV.preserveKeepToggles(
    [
      { id: "a", keep: true, title: "same" },
      { id: "b", keep: true, title: "new" },
    ],
    prev,
    true,
  );
  assert.equal(next.find((r) => r.id === "a").keep, false);
  assert.equal(next.find((r) => r.id === "b").keep, true);
  const fresh = GV.preserveKeepToggles([{ id: "a", keep: true }], prev, false);
  assert.equal(fresh[0].keep, true);
});

test("lastReadPayload and formatLastRead drive the side panel status line", () => {
  const payload = GV.lastReadPayload({
    query: "Mercury #5",
    pageRows: [{ keep: true }, { keep: false }],
    soldTape: [{ keep: true, price: 110 }],
    velocity: { action: "FAST_CASH", fastCashPrice: 98 },
    at: 1_000,
  });
  assert.equal(payload.n, 1);
  assert.equal(payload.kept, 1);
  assert.equal(payload.action, "FAST_CASH");
  assert.equal(payload.fastCash, 98);
  assert.equal(
    GV.formatLastRead(payload, 1_000),
    "Last read just now: Mercury #5 · 1/1 kept · FAST CASH · $98.00",
  );
  assert.match(GV.formatLastRead(null, 1_000), /No tab read yet/);
});

test("queueCopyText ranks by list-to-tape gap and caps at 40", () => {
  const empty = GV.queueCopyText([{ id: "x", title: "no prices" }]);
  assert.equal(empty, "");
  const text = GV.queueCopyText([
    { id: "low", title: "small gap", listPrice: 110, fastCash: 100 },
    { id: "high", title: "big gap", listPrice: 200, fastCash: 80 },
  ]);
  const lines = text.trim().split("\n");
  assert.equal(lines[0], "id\ttitle\tlist\tfastCash\tgap");
  assert.match(lines[1], /^high\t/);
  assert.match(lines[2], /^low\t/);
});

test("content script and side panel call extracted overlay helpers", () => {
  const ebay = fs.readFileSync(path.join(__dirname, "../content/ebay.js"), "utf8");
  const panel = fs.readFileSync(path.join(__dirname, "../sidepanel/sidepanel.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
  assert.match(ebay, /GV\.findingsText\(/);
  assert.match(ebay, /GV\.pageChanged\(/);
  assert.match(ebay, /GV\.isOverlayToggleHotkey\(/);
  assert.match(ebay, /GV\.preserveKeepToggles\(/);
  assert.match(ebay, /GV\.lastReadPayload\(/);
  assert.match(panel, /GV\.formatLastRead\(/);
  assert.match(panel, /GV\.queueCopyText\(/);
  assert.deepEqual(manifest.content_scripts[0].js, ["lib/core.js", "lib/overlay.js", "content/ebay.js"]);
});
