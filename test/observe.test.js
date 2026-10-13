"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHmac, createHash } = require("node:crypto");
const { loadScripts } = require("./load-core");

const { GVObserve, GVCard } = loadScripts(["lib/cardfields.js", "lib/observe.js"]);

const ITEM = "https://www.ebay.com/itm/123456789012?_trkparms=abc&gclid=zzz";
const SOLD = "https://www.ebay.com/sch/i.html?_nkw=wembanyama&LH_Sold=1&_trkparms=drop";
const ACTIVE = "https://www.ebay.com/sch/i.html?_nkw=wembanyama&LH_BIN=1";
const NOW = Date.parse("2026-10-13T15:00:00Z");

test("classifies item, sold search, and active search, and cleans tracking params", () => {
  assert.equal(GVObserve.classify(ITEM).pageType, "item");
  assert.equal(GVObserve.classify(SOLD).pageType, "sold_search");
  assert.equal(GVObserve.classify(ACTIVE).pageType, "active_search");
  assert.equal(GVObserve.classify("https://www.ebay.com/checkout/pay"), null);
  assert.equal(GVObserve.cleanEbayUrl(ITEM), "https://www.ebay.com/itm/123456789012");
  const cleaned = new URL(GVObserve.cleanEbayUrl(SOLD));
  assert.equal(cleaned.searchParams.get("_nkw"), "wembanyama");
  assert.equal(cleaned.searchParams.get("LH_Sold"), "1");
  assert.equal(cleaned.searchParams.get("_trkparms"), null);
});

test("pause list blocks checkout, messages, and My eBay by default", () => {
  const prefs = GVObserve.defaultSettings();
  assert.equal(GVObserve.gate("https://pay.ebay.com/rxo", prefs, null, NOW).reason, "pause-list");
  assert.equal(GVObserve.gate("https://www.ebay.com/checkout/1", prefs, null, NOW).reason, "pause-list");
  assert.equal(GVObserve.gate("https://www.ebay.com/mye/myebay/summary", prefs, null, NOW).reason, "pause-list");
  assert.equal(GVObserve.gate("https://mesg.ebay.com/mesgweb/ViewMessage", prefs, null, NOW).reason, "pause-list");
  assert.equal(GVObserve.gate(ITEM, prefs, null, NOW).ok, true);
  assert.equal(GVObserve.validPausePattern("ebay.com"), false);
});

test("global off, site toggle, and one-hour pause stop capture", () => {
  assert.equal(GVObserve.gate(ITEM, { captureEnabled: false }, null, NOW).reason, "off");
  assert.equal(GVObserve.gate(ITEM, { sites: { ebay: false } }, null, NOW).reason, "site");
  assert.equal(
    GVObserve.gate(ITEM, { capturePausedUntil: NOW + 1000 }, null, NOW).reason,
    "paused",
  );
});

test("one capture per URL per 10 minutes and 300 per hour", () => {
  let rate = null;
  const first = GVObserve.gate(ITEM, {}, rate, NOW);
  assert.equal(first.ok, true);
  const again = GVObserve.gate(ITEM, {}, first.rate, NOW + 1000);
  assert.equal(again.reason, "url-cooldown");
  const other = GVObserve.gate(ACTIVE, {}, first.rate, NOW + 1000);
  assert.equal(other.ok, true);
  const later = GVObserve.gate(ITEM, {}, first.rate, NOW + GVObserve.URL_COOLDOWN_MS);
  assert.equal(later.ok, true);

  rate = null;
  for (let i = 0; i < GVObserve.HOUR_CAP; i += 1) {
    const admitted = GVObserve.admit(rate, `https://www.ebay.com/itm/${100000000000 + i}`, NOW);
    assert.equal(admitted.ok, true);
    rate = admitted.rate;
  }
  const capped = GVObserve.admit(rate, "https://www.ebay.com/itm/199999999999", NOW);
  assert.equal(capped.reason, "hour-cap");
  const nextHour = GVObserve.admit(capped.rate, "https://www.ebay.com/itm/199999999999", NOW + GVObserve.HOUR_MS);
  assert.equal(nextHour.ok, true);
});

test("seller HMAC matches node crypto and the raw username is not stored", async () => {
  const secret = "operator-secret";
  const expected = createHmac("sha256", secret).update("zz-shop-9f3").digest("hex");
  assert.equal(await GVObserve.sellerHash("ZZ-shop-9f3", secret), expected);
  assert.equal(await GVObserve.sellerHash("ZZ-shop-9f3", ""), null);
  const sealed = await GVObserve.sealObservation(
    {
      site: "ebay",
      page_type: "item",
      url: "https://www.ebay.com/itm/123456789012",
      item_id: "123456789012",
      title: "2023-24 Topps Chrome Victor Wembanyama #1",
      price: 10,
      status: "sold",
      sold_date: "Feb 2, 2026",
      seller_username: "zz-shop-9f3",
      feedback_count: 1420,
      specifics: { Seller: "zz-shop-9f3", Set: "Topps Chrome" },
    },
    { sellerHmacSecret: secret, ownSellerId: "meltonia" },
  );
  const blob = JSON.stringify(sealed);
  assert.equal(blob.includes("zz-shop-9f3"), false);
  assert.equal(sealed.seller_hash, expected);
  assert.equal(sealed.feedback_bucket, "1k+");
  assert.equal(sealed.own_sale, false);
  assert.equal(sealed.specifics.Set, "Topps Chrome");
  assert.equal(sealed.raw_hash, createHash("sha256").update(GVObserve.hashMaterial(sealed)).digest("hex"));
});

test("own store id is kept in plain text only for the operator", async () => {
  const sealed = await GVObserve.sealObservation(
    {
      page_type: "item",
      item_id: "123456789012",
      title: "Own sale",
      price: 20,
      status: "sold",
      sold_date: "Feb 2, 2026",
      seller_username: "Meltonia",
      feedback_count: 12,
    },
    { sellerHmacSecret: "s", ownSellerId: "meltonia" },
  );
  assert.equal(sealed.own_sale, true);
  assert.equal(sealed.own_seller_id, "meltonia");
  assert.equal(sealed.feedback_bucket, "<100");
});

test("card fields read grade, serial, auto, rookie, and print-to-order", () => {
  const fields = GVCard.extractCardFields("2024 Topps Now Victor Wembanyama #12 RC /99", {
    "Professional Grader": "PSA",
    Grade: "10",
    "Certification Number": "42",
    Autographed: "Yes",
  });
  assert.equal(fields.serial, "/99");
  assert.equal(fields.gradeCo, "PSA");
  assert.equal(fields.cert, "42");
  assert.equal(fields.isAuto, true);
  assert.equal(fields.isRookie, true);
  assert.equal(fields.isPrintToOrder, true);
  assert.equal(GVCard.extractCardFields("2023 Chrome #1 23/99", {}).serial, "23/99");
});
