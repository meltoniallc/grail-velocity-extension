"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./load-core");

const { GV } = loadScript("lib/core.js");

const QUERY =
  "2023-24 Topps Mercury Victor Wembanyama #5 Refractor Rookie RC SP 74/99 Spurs";

function row(title, price) {
  return { id: title.slice(0, 24) + "-" + price, title, price };
}

test("keeps the same Mercury #5 /99 with a different copy number", () => {
  const listings = [
    row("2023-24 Topps Mercury Victor Wembanyama #5 Refractor 12/99 PSA 9", 118),
    row("2023-24 Topps Mercury Victor Wembanyama #5 Refractor Rookie 88/99", 104),
  ];
  const result = GV.verifyComps(QUERY, listings);
  const kept = result.rows.filter((r) => r.keep);
  assert.equal(kept.length, 2);
  assert.ok(kept.every((r) => r.matchScore >= 0.72));
});

test("drops a cheap Prizm near-miss so it cannot pull Fast-Cash down", () => {
  const listings = [
    row("2023-24 Topps Mercury Victor Wembanyama #5 Refractor 12/99", 118),
    row("2023-24 Topps Mercury Victor Wembanyama #5 Refractor 88/99", 104),
    row("2023-24 Topps Mercury Victor Wembanyama #5 Refractor 03/99", 99),
    row("2023 Panini Prizm Victor Wembanyama #5 Silver RC", 4.99),
  ];
  const result = GV.verifyComps(QUERY, listings);
  const junk = result.rows.find((r) => /Prizm/i.test(r.title));
  assert.equal(junk.keep, false);
  const velocity = GV.scoreVelocity({ verified: result.rows, cogs: 80 });
  assert.ok(velocity.fastCashPrice > 80);
  assert.ok(velocity.median > 90);
});

test("drops the wrong card number and the wrong print run", () => {
  const listings = [
    row("2023-24 Topps Mercury Victor Wembanyama #16 Refractor 47/99 Spurs", 85),
    row("2023-24 Topps Mercury Victor Wembanyama #5 Blue Refractor 03/75", 145),
  ];
  const result = GV.verifyComps(QUERY, listings);
  assert.equal(result.rows.filter((r) => r.keep).length, 0);
});

test("stops at the eBay relevance cliff and ignores later junk prices", () => {
  const listings = [
    row("2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99", 120),
    row("2023-24 Topps Mercury Victor Wembanyama #5 Refractor 22/99", 110),
    row("2023-24 Topps Mercury Victor Wembanyama #5 Refractor 33/99", 108),
    row("2023-24 Topps Mercury Victor Wembanyama #5 Refractor 44/99", 101),
    row("Victor Wembanyama lot of 10 cards wholesale", 9.99),
    row("Wembanyama random team break spot", 1),
    row("2024 Hoops Victor Wembanyama base #165", 2),
    row("Wembanyama mystery grab bag", 3),
    row("Pokemon Wembanyama custom reprint", 0.99),
  ];
  const result = GV.verifyComps(QUERY, listings);
  assert.ok(result.stoppedAt >= 4);
  assert.ok(result.nCliff >= 3);
  assert.ok(result.rows.filter((r) => r.keep).every((r) => r.price >= 100));
  assert.ok(result.rows.some((r) => r.flags.includes("beyond_cliff")));
  const velocity = GV.scoreVelocity({ verified: result.rows, cogs: 80 });
  assert.ok(velocity.fastCashPrice > 90);
});

test("two tight comps still price; one weak title does not", () => {
  const tight = GV.verifyComps(QUERY, [
    row("2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99", 120),
    row("2023-24 Topps Mercury Victor Wembanyama #5 Refractor 22/99", 110),
  ]);
  const priced = GV.scoreVelocity({ verified: tight.rows, cogs: 80 });
  assert.notEqual(priced.fastCashPrice, null);
  assert.equal(priced.action, "FAST_CASH");

  const weak = GV.verifyComps(QUERY, [
    row("Victor Wembanyama basketball card", 6),
  ]);
  const quarantined = GV.scoreVelocity({ verified: weak.rows, cogs: 80 });
  assert.equal(quarantined.action, "QUARANTINE");
  assert.equal(quarantined.fastCashPrice, null);
});

test("soldUrl and nextSoldPageUrl page via _pgn and stop at SOLD_PAGE_CAP", () => {
  const page1 = GV.soldUrl(QUERY);
  assert.match(page1, /LH_Sold=1/);
  assert.equal(page1.includes("_pgn="), false);
  assert.equal(GV.soldSearchPage(page1)?.page, 1);
  assert.equal(GV.soldSearchPage("https://www.ebay.com/sch/i.html?_nkw=x") , null);

  const page2 = GV.nextSoldPageUrl(page1, QUERY);
  assert.match(page2, /_pgn=2/);
  assert.equal(GV.soldSearchPage(page2)?.page, 2);

  const atCap = GV.soldUrl(QUERY, GV.SOLD_PAGE_CAP);
  assert.equal(GV.nextSoldPageUrl(atCap, QUERY), null);
  assert.ok(GV.SOLD_PAGE_CAP >= 2);
});

test("shouldContinueSoldPages: page-1 cliff or empty keeps; later stop on cliff; never on live", () => {
  const cliff = GV.verifyComps(QUERY, [
    row("2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99", 120),
    row("2023-24 Topps Mercury Victor Wembanyama #5 Refractor 22/99", 110),
    row("2023-24 Topps Mercury Victor Wembanyama #5 Refractor 33/99", 108),
    row("Victor Wembanyama lot of 10 cards wholesale", 9.99),
    row("Wembanyama random team break spot", 1),
    row("2024 Hoops Victor Wembanyama base #165", 2),
    row("Wembanyama mystery grab bag", 3),
  ]);
  assert.ok(cliff.nCliff > 0);
  assert.ok(
    GV.shouldContinueSoldPages({
      pageMode: "sold",
      page: 1,
      nKept: cliff.nKept,
      nCliff: cliff.nCliff,
      nRaw: cliff.nRaw,
      nextUrl: GV.nextSoldPageUrl(GV.soldUrl(QUERY), QUERY),
    }),
  );
  assert.equal(
    GV.shouldContinueSoldPages({
      pageMode: "live",
      page: 1,
      nKept: 0,
      nCliff: 2,
      nRaw: 10,
      nextUrl: "https://www.ebay.com/sch/i.html?LH_Sold=1&_nkw=x&_pgn=2",
    }),
    false,
  );
  assert.ok(
    GV.shouldContinueSoldPages({
      pageMode: "sold",
      page: 1,
      nKept: 0,
      nCliff: 0,
      nRaw: 8,
      nextUrl: GV.nextSoldPageUrl(GV.soldUrl(QUERY), QUERY),
    }),
  );
  assert.equal(
    GV.shouldContinueSoldPages({
      pageMode: "sold",
      page: 1,
      nKept: 0,
      nCliff: 0,
      nRaw: 0,
      nextUrl: GV.nextSoldPageUrl(GV.soldUrl(QUERY), QUERY),
    }),
    false,
  );
  // Page 2+: cliff wins — do not follow further
  assert.equal(
    GV.shouldContinueSoldPages({
      pageMode: "sold",
      page: 2,
      nKept: cliff.nKept,
      nCliff: cliff.nCliff,
      nRaw: cliff.nRaw,
      nextUrl: GV.nextSoldPageUrl(GV.soldUrl(QUERY, 2), QUERY),
    }),
    false,
  );
  // Page 2 with keeps and no cliff may continue until cap
  assert.ok(
    GV.shouldContinueSoldPages({
      pageMode: "sold",
      page: 2,
      nKept: 2,
      nCliff: 0,
      nRaw: 10,
      nextUrl: GV.nextSoldPageUrl(GV.soldUrl(QUERY, 2), QUERY),
    }),
  );
  assert.equal(
    GV.shouldContinueSoldPages({
      pageMode: "sold",
      page: GV.SOLD_PAGE_CAP,
      nKept: 2,
      nCliff: 0,
      nRaw: 10,
      nextUrl: null,
    }),
    false,
  );
  // Cliff still keeps junk off Fast-Cash even when continue is offered
  const velocity = GV.scoreVelocity({ verified: cliff.rows, cogs: 80 });
  assert.ok(velocity.fastCashPrice > 90);
  assert.ok(cliff.rows.filter((r) => r.keep).every((r) => r.price >= 100));
});
