"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseHTML } = require("linkedom");
const { loadScripts } = require("./load-core");

const ctx = loadScripts([
  "lib/core.js",
  "lib/cardfields.js",
  "lib/observe.js",
  "content/parsers/common.js",
  "content/parsers/cards.js",
  "content/parsers/ebay-item.js",
  "content/parsers/ebay-sold-search.js",
  "content/parsers/ebay-active-search.js",
  "content/capture.js",
]);

function doc(name) {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
  return parseHTML(html).document;
}

const meta = {
  now: Date.parse("2026-10-13T15:00:00Z"),
  version: "2.0.0",
};

test("ebay item parser prefers JSON-LD and reads specifics", () => {
  const [row] = ctx.GVParse.ebayItem(doc("ebay-item.html"), {
    ...meta,
    url: "https://www.ebay.com/itm/123456789012?_trkparms=abc",
  });
  assert.equal(row.page_type, "item");
  assert.equal(row.parser_ver, "ebay-item@1");
  assert.equal(row.title.includes("Victor Wembanyama"), true);
  assert.equal(row.title.includes("ignored"), false);
  assert.equal(row.price, 425);
  assert.equal(row.currency, "USD");
  assert.equal(row.shipping, 0);
  assert.equal(row.status, "sold");
  assert.equal(row.sold_date, "Feb 2, 2026");
  assert.equal(row.buying_format, "bin");
  assert.equal(row.player, "Victor Wembanyama");
  assert.equal(row.set_name, "Topps Chrome");
  assert.equal(row.card_no, "1");
  assert.equal(row.serial, "23/99");
  assert.equal(row.grade_co, "PSA");
  assert.equal(row.grade, "10");
  assert.equal(row.cert, "88442211");
  assert.equal(row.is_auto, true);
  assert.equal(row.seller_username, "zz-shop-9f3");
  assert.equal(row.feedback_count, 1420);
  assert.equal(row.image_urls.length, 1);
  assert.equal(String(row.image_urls[0]), "https://i.ebayimg.com/images/g/abc/s-l1600.jpg");
  assert.equal(row.url, "https://www.ebay.com/itm/123456789012");
});

test("sold search keeps one row per card, including near-misses", () => {
  const rows = ctx.GVParse.ebaySoldSearch(doc("ebay-sold-search.html"), {
    ...meta,
    url: "https://www.ebay.com/sch/i.html?_nkw=wembanyama&LH_Sold=1",
  });
  assert.equal(rows.length, 3);
  assert.equal(rows.every((row) => row.page_type === "sold_search" && row.status === "sold"), true);
  assert.equal(rows[0].item_id, "123456789012");
  assert.equal(rows[0].serial, "23/99");
  assert.equal(rows[0].shipping, 0);
  assert.equal(rows[0].url.includes("_trkparms"), false);
  assert.equal(rows[1].accepted_offer, true);
  assert.equal(rows[1].shipping, 4.95);
  assert.equal(rows[2].title.includes("Prizm"), true);
  assert.equal(rows.some((row) => /shop on ebay/i.test(row.title)), false);
});

test("active search marks BIN and auction rows as active", () => {
  const rows = ctx.GVParse.ebayActiveSearch(doc("ebay-active-search.html"), {
    ...meta,
    url: "https://www.ebay.com/sch/i.html?_nkw=wembanyama",
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "active");
  assert.equal(rows[0].buying_format, "bin");
  assert.equal(rows[0].serial, "/99");
  assert.equal(rows[0].feedback_count, 2000);
  assert.equal(rows[1].buying_format, "auction");
  assert.equal(rows[1].is_rookie, true);
  assert.equal(rows[1].is_print_to_order, true);
});

test("capture sends one batch per view and does not fetch", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "content", "capture.js"), "utf8");
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /tabs\.create|window\.open|XMLHttpRequest/);
  const sent = [];
  const location = { href: "https://www.ebay.com/itm/123456789012?_trkparms=1" };
  const session = ctx.GVCapture.install({
    location,
    document: doc("ebay-item.html"),
    waitMs: 0,
    graceMs: 0,
    now: () => meta.now,
    version: () => "2.0.0",
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    clearTimeout() {},
    send(msg) {
      sent.push(msg);
    },
    observe(_onMutate, _grace, done) {
      done();
    },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "GV_OBSERVE");
  assert.equal(sent[0].observations.length, 1);
  session.schedule();
  assert.equal(sent.length, 1);
  location.href = "https://www.ebay.com/itm/223456789012";
  session.notifyNavigation();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].observations[0].item_id, "223456789012");
});
