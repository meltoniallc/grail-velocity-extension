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
  assert.match(GV.formatLastRead(null, 1_000), /No tab scraped yet/);
  assert.match(GV.formatLastRead(null, 1_000), /Scrape this page/);
});

test("listedAsk uses the page ask, never the catalog BIN", () => {
  const sku = { listPrice: 999, fastCash: 50 };
  const rows = [
    { keep: true, price: 120 },
    { keep: false, price: 9 },
  ];
  assert.equal(GV.listedAsk("live", sku, rows), 120);
  assert.equal(GV.listedAsk("listing", sku, rows), 120);
  assert.equal(GV.listedAsk("sold", sku, rows), null);
  assert.equal(GV.listedAsk("live", sku, []), null);
});

test("mergeKeepIntoSoldTape flips the current row and keeps other pages' comps", () => {
  const tape = [
    { id: "a", keep: true, kind: "sold", price: 120 },
    { id: "cached", keep: true, kind: "sold", price: 110 },
  ];
  const pageRows = [
    { id: "a", keep: false, kind: "sold", price: 120 },
    { id: "live", keep: true, kind: "active", price: 9 },
  ];
  const next = GV.mergeKeepIntoSoldTape(tape, pageRows);
  assert.equal(next.find((r) => r.id === "a").keep, false);
  assert.equal(next.find((r) => r.id === "cached").keep, true);
  assert.equal(next.some((r) => r.id === "live"), false);
});

test("npmTapeCommand quotes secrets so a pasted value cannot break the shell", () => {
  assert.equal(GV.npmTapeCommand(""), "npm run tape");
  assert.equal(GV.npmTapeCommand("abc123"), "TAPE_SECRET='abc123' npm run tape");
  assert.equal(GV.npmTapeCommand("x'$(reboot)"), "TAPE_SECRET='x'\\''$(reboot)' npm run tape");
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

test("captureStatus is watching, scraped, or cliffed", () => {
  assert.equal(GV.captureStatus({ scraping: true }), "watching");
  assert.equal(GV.captureStatus({}), "watching");
  assert.equal(GV.captureStatus({ nRaw: 0, pageRows: [], soldTape: [] }), "watching");
  assert.equal(GV.captureStatus({ nRaw: 3, nCliff: 0, pageRows: [{ id: "a" }] }), "scraped");
  assert.equal(GV.captureStatus({ nRaw: 5, nCliff: 2 }), "cliffed");
  assert.equal(GV.captureStatus({ scraping: true, nCliff: 2 }), "watching");
});

test("desk empty states align watching / NO TAPE / cliff copy", () => {
  assert.equal(GV.deskStatusLine("watching"), "watching solds…");
  assert.equal(GV.deskStatusLine("cliffed"), "cliff — junk parked in scratch");
  assert.equal(GV.deskStatusLine("scraped"), "scraped");
  assert.equal(GV.deskStatusLine({ scraping: true }), "watching solds…");
  assert.equal(GV.deskStatusLine({ nCliff: 2 }), "cliff — junk parked in scratch");
  assert.equal(GV.deskNoTapeLine(), "NO TAPE — Get solds (or wait for auto-capture)");
  assert.equal(GV.DESK_EMPTY.watching, "watching solds…");
  assert.equal(GV.DESK_EMPTY.noTape, "NO TAPE — Get solds (or wait for auto-capture)");
  assert.equal(GV.DESK_EMPTY.cliff, "cliff — junk parked in scratch");
  assert.equal(GV.deskRoleLabel("tape"), "Fast-Cash");
  assert.equal(GV.deskRoleLabel("ask"), "Listed ask");
  assert.equal(GV.deskRoleLabel("book"), "Book ref");
  assert.equal(GV.suggestMetaLabel({ kind: "tape", nKept: 3 }), "tape · 3 kept");
  assert.equal(GV.suggestMetaLabel({ kind: "book" }), "catalog");
  assert.equal(GV.suggestMetaLabel({}), "catalog");
  assert.equal(GV.deskSurfaceLine({}), GV.DESK_EMPTY.watching);
  assert.equal(GV.deskSurfaceLine({ lastRead: { at: 1, kept: 0 } }), GV.DESK_EMPTY.noTape);
  assert.equal(GV.deskSurfaceLine({ lastRead: { at: 1, fastCash: 98, kept: 2 } }), GV.DESK_EMPTY.scraped);
  assert.equal(GV.deskSurfaceLine({ nCliff: 2 }), GV.DESK_EMPTY.cliff);
});

test("planGetSolds scrapes on matching sold page and navigates otherwise", () => {
  const q = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
  const soldHref = GV.soldUrl(q);
  const scrape = GV.planGetSolds({ query: q, pageMode: "sold", href: soldHref });
  assert.equal(scrape.action, "scrape");
  const live = GV.planGetSolds({
    query: q,
    pageMode: "live",
    href: "https://www.ebay.com/sch/i.html?_nkw=" + encodeURIComponent(q),
  });
  assert.equal(live.action, "navigate");
  assert.match(live.url, /LH_Sold=1/);
  assert.match(live.url, /Mercury/);
  assert.equal(GV.planGetSolds({ query: "" }).action, "noop");
  const otherSold = GV.planGetSolds({
    query: q,
    pageMode: "sold",
    href: GV.soldUrl("completely different card"),
  });
  assert.equal(otherSold.action, "navigate");
});

test("consumeGetSoldsPending clears matching fresh flag only", () => {
  const bag = new Map();
  const store = {
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem: (k, v) => bag.set(k, v),
    removeItem: (k) => bag.delete(k),
  };
  const q = "Mercury #5 Refractor";
  const now = 1_000_000;
  store.setItem(GV.GET_SOLDS_PENDING_KEY, GV.encodeGetSoldsPending(q, now - 1_000));
  assert.equal(GV.consumeGetSoldsPending(store, q, now), q);
  assert.equal(store.getItem(GV.GET_SOLDS_PENDING_KEY), null);
  store.setItem(GV.GET_SOLDS_PENDING_KEY, GV.encodeGetSoldsPending(q, now - 120_000));
  assert.equal(GV.consumeGetSoldsPending(store, q, now), null);
  store.setItem(GV.GET_SOLDS_PENDING_KEY, GV.encodeGetSoldsPending(q, now));
  assert.equal(GV.consumeGetSoldsPending(store, "other query", now), null);
  assert.ok(store.getItem(GV.GET_SOLDS_PENDING_KEY));
});

test("formatTapeSync surfaces OK / fail / idle for Options and overlay", () => {
  const now = 1_000_000;
  const idle = GV.formatTapeSync(null, now);
  assert.equal(idle.kind, "idle");
  assert.equal(idle.label, "sync —");
  assert.match(idle.detail, /No Tape API push/);
  const ok = GV.formatTapeSync({ ok: true, at: now - 30_000 }, now);
  assert.equal(ok.kind, "ok");
  assert.match(ok.label, /sync OK/);
  const bad = GV.formatTapeSync({ ok: false, error: "ECONNREFUSED", at: now - 120_000 }, now);
  assert.equal(bad.kind, "bad");
  assert.match(bad.label, /SYNC FAIL/);
  assert.match(bad.detail, /ECONNREFUSED/);
  assert.match(bad.banner, /SYNC FAIL/);
  assert.match(bad.banner, /Options/);
});

test("tapeApiPresets prefer Railway and keep local loopback", () => {
  const presets = GV.tapeApiPresets();
  assert.equal(presets.railway, "https://tape-production-2810.up.railway.app");
  assert.equal(presets.local, "http://127.0.0.1:8787");
  assert.equal(GV.TAPE_API_RAILWAY, presets.railway);
  assert.equal(GV.tapeApiAllowed(presets.railway), true);
  assert.equal(GV.tapeApiAllowed(presets.local), true);
});

test("optionsScratchFocus parks query for Options cliff → scratch", () => {
  const focus = GV.optionsScratchFocus("  Mercury #5  ");
  assert.equal(focus.pullQuery, "Mercury #5");
  assert.equal(focus.inspectScratch, "local");
  assert.ok(focus.at > 0);
  assert.equal(GV.optionsScratchFocus("").pullQuery, "");
});

test("autoCapture defaults ON; pref off ⇒ no scheduled auto-read", () => {
  assert.equal(GV.autoCaptureEnabled(undefined), true);
  assert.equal(GV.autoCaptureEnabled(null), true);
  assert.equal(GV.autoCaptureEnabled(true), true);
  assert.equal(GV.autoCaptureEnabled(false), false);
  assert.equal(GV.shouldScheduleAutoRead(true), true);
  assert.equal(GV.shouldScheduleAutoRead(undefined), true);
  assert.equal(GV.shouldScheduleAutoRead(false), false);
});

test("scratchReasons buckets cliff / weak_title / active ask", () => {
  assert.equal(GV.scratchBucket({ flags: ["beyond_cliff"], reason: "Past eBay relevance cliff" }), "cliff");
  assert.equal(GV.scratchBucket({ flags: ["weak_title"], reason: "weak_title" }), "weak_title");
  assert.equal(GV.scratchBucket({ kind: "active", keep: true, flags: [] }), "active");
  assert.equal(GV.scratchBucket({ flags: ["wrong_set"], reason: "wrong_set" }), "wrong_set");

  const reasons = GV.scratchReasons(
    {
      entries: [
        {
          at: 200,
          listings: [
            { id: "a", title: "live ask", price: 150, kind: "active", keep: true, flags: [] },
            { id: "b", title: "near miss", price: 40, flags: ["weak_title"], reason: "weak_title" },
          ],
        },
        {
          at: 100,
          listings: [
            { id: "c", title: "junk after cliff", price: 3, flags: ["beyond_cliff"], reason: "Past eBay relevance cliff" },
          ],
        },
      ],
    },
    { limit: 10 },
  );
  assert.equal(reasons.length, 3);
  assert.equal(reasons[0].bucket, "active");
  assert.equal(reasons[1].bucket, "weak_title");
  assert.equal(reasons[2].bucket, "cliff");
  assert.match(reasons[0].label, /active:/);
  assert.equal(GV.scratchReasons({ listings: [] }, { limit: 5 }).length, 0);
});

test("content script and side panel call extracted overlay helpers", () => {
  const ebay = fs.readFileSync(path.join(__dirname, "../content/ebay.js"), "utf8");
  const demo = fs.readFileSync(path.join(__dirname, "../test/overlay-demo.html"), "utf8");
  const panel = fs.readFileSync(path.join(__dirname, "../sidepanel/sidepanel.js"), "utf8");
  const optsHtml = fs.readFileSync(path.join(__dirname, "../options/index.html"), "utf8");
  const optsJs = fs.readFileSync(path.join(__dirname, "../options/options.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
  assert.match(ebay, /GV\.findingsText\(/);
  assert.match(ebay, /GV\.pageChanged\(/);
  assert.match(ebay, /GV\.isOverlayToggleHotkey\(/);
  assert.match(ebay, /GV\.preserveKeepToggles\(/);
  assert.match(ebay, /GV\.lastReadPayload\(/);
  assert.match(ebay, /GV\.captureStatus\(/);
  assert.match(ebay, /GV\.deskStatusLine\(/);
  assert.match(ebay, /GV\.deskNoTapeLine\(/);
  assert.match(ebay, /data-act="get-solds"/);
  assert.match(ebay, /Get solds/);
  assert.match(ebay, /GV\.planGetSolds\(/);
  assert.match(ebay, /GV\.consumeGetSoldsPending\(/);
  assert.match(ebay, /runGetSolds/);
  assert.match(ebay, /GV\.formatTapeSync\(/);
  assert.match(ebay, /data-capture-status/);
  assert.match(ebay, /data-tape-sync/);
  assert.match(ebay, /data-role="tape"/);
  assert.match(ebay, /data-role="ask"/);
  assert.match(ebay, /data-role="book"/);
  assert.match(ebay, /mode:\s*"manual"/);
  assert.match(ebay, /mode:\s*"auto"/);
  assert.match(ebay, /GV\.shouldScheduleAutoRead\(autoCapture\)/);
  assert.match(ebay, /GV\.autoCaptureEnabled\(/);
  assert.match(ebay, /chrome\.storage\.onChanged/);
  assert.match(ebay, /changes\.tapeSync/);
  assert.match(ebay, /function scheduleRead\(\) \{\s*\n\s*if \(!GV\.shouldScheduleAutoRead\(autoCapture\)\) return;/);
  assert.match(optsHtml, /id="autoCapture"/);
  assert.match(optsJs, /autoCapture/);
  assert.match(optsHtml, /id="pull"/);
  assert.match(optsHtml, /id="pullQuery"/);
  assert.match(optsJs, /GV_TAPE_PULL/);
  assert.match(optsHtml, /id="scratchLocal"/);
  assert.match(optsHtml, /id="scratchRemote"/);
  assert.match(optsHtml, /id="scratchList"/);
  assert.match(optsHtml, /id="syncStatus"/);
  assert.match(optsHtml, /id="presetRailway"/);
  assert.match(optsHtml, /id="presetLocal"/);
  assert.match(optsHtml, /Use Railway Tape/);
  assert.match(optsJs, /presetRailway/);
  assert.match(optsJs, /tapeApiPresets/);
  assert.match(optsJs, /optionsFocus/);
  assert.match(optsJs, /GV_SCRATCH_GET/);
  assert.match(optsJs, /GV_SCRATCH_REMOTE/);
  assert.match(optsJs, /GV\.scratchReasons\(/);
  assert.match(optsJs, /GV\.formatTapeSync\(/);
  assert.match(optsJs, /paintSync/);
  assert.match(ebay, /data-act="scratch"/);
  assert.match(ebay, /optionsScratchFocus/);
  assert.match(ebay, /gv-sync-banner/);
  assert.match(ebay, /openOptionsPage/);
  assert.match(panel, /GV\.formatLastRead\(/);
  assert.match(panel, /GV\.queueCopyText\(/);
  assert.match(panel, /GV\.DESK_EMPTY/);
  assert.match(panel, /GV\.deskSurfaceLine\(/);
  assert.match(panel, /GV\.suggestMetaLabel\(/);
  assert.match(panel, /queueHits/);
  assert.doesNotMatch(panel, /bookHits/);
  const panelHtml = fs.readFileSync(path.join(__dirname, "../sidepanel/index.html"), "utf8");
  assert.match(panelHtml, /Side panel · cut queue/);
  assert.equal(/Side panel · book/.test(panelHtml), false);
  assert.match(panelHtml, /List → Fast-Cash gaps only/);
  assert.doesNotMatch(panelHtml, /\bbook dressed\b/i);
  assert.doesNotMatch(panelHtml, /data-role="book"/);
  assert.match(panelHtml, /id="desk-status"/);
  const popupJs = fs.readFileSync(path.join(__dirname, "../popup/popup.js"), "utf8");
  assert.match(popupJs, /GV\.DESK_EMPTY/);
  assert.match(popupJs, /GV\.deskSurfaceLine\(/);
  assert.match(popupJs, /GV\.suggestMetaLabel\(/);
  assert.match(popupJs, /GV\.deskRoleLabel\(/);
  assert.doesNotMatch(popupJs, /\|\| "book"/);
  const overlayCss = fs.readFileSync(path.join(__dirname, "../content/overlay.css"), "utf8");
  assert.match(overlayCss, /\.gv-btn\.get-solds/);
  assert.match(overlayCss, /\.gv-role-tape/);
  assert.match(overlayCss, /\.gv-role-ask/);
  assert.match(overlayCss, /\.gv-role-book/);
  assert.match(overlayCss, /\.gv-role-tape \.gv-role-value/);
  assert.match(overlayCss, /font-size:\s*36px/);
  assert.match(overlayCss, /\.gv-sync/);
  assert.match(overlayCss, /\.gv-sync-banner/);
  assert.match(overlayCss, /prefers-reduced-motion:\s*reduce/);
  assert.match(ebay, /GV\.deskRoleLabel\(/);
  assert.match(ebay, /GV\.listedAsk\(/);
  assert.match(ebay, /GV\.mergeKeepIntoSoldTape\(/);
  assert.match(ebay, /soldTape = \[\]/);
  assert.match(ebay, /readGen/);
  assert.match(ebay, /data-act="continue-solds"/);
  assert.match(ebay, /GV\.shouldContinueSoldPages\(/);
  assert.match(ebay, /GV\.nextSoldPageUrl\(/);
  assert.match(ebay, /followNextSoldPage/);
  assert.match(ebay, /Typeahead never opens sold tabs/);
  {
    const hitBlock = ebay.match(/if \(act === "hit"\) \{[\s\S]*?\n    \}/);
    assert.ok(hitBlock, "hit handler present");
    assert.equal(/soldUrl|tabs\.create|location\.href|get-solds|runGetSolds/.test(hitBlock[0]), false);
  }
  assert.deepEqual(manifest.content_scripts[0].js, [
    "lib/core.js",
    "lib/overlay.js",
    "lib/suggest.js",
    "lib/cardfields.js",
    "lib/observe.js",
    "content/parsers/common.js",
    "content/parsers/cards.js",
    "content/parsers/ebay-item.js",
    "content/parsers/ebay-sold-search.js",
    "content/parsers/ebay-active-search.js",
    "content/capture.js",
    "content/ebay.js",
  ]);
  assert.match(demo, /lib\/overlay\.js/);
  assert.match(ebay, /GV\.loadCatalog\(/);
  assert.match(ebay, /GV\.suggestLocalFirst\(/);
});
