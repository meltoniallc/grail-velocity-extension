/* Shared DOM reads for eBay page parsers. Classic script. */
(function (global) {
  function text(node, selector) {
    if (!node) return "";
    const el = selector ? node.querySelector(selector) : node;
    return (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
  }

  function parsePrice(value) {
    if (global.GV && global.GV.parsePrice) return global.GV.parsePrice(value);
    if (value == null || value === "") return null;
    const cleaned = String(value).replace(/[^\d.,]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned.replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function itemIdFromHref(href) {
    const raw = String(href || "");
    if (global.GV && global.GV.itemIdFromPath) {
      try {
        return global.GV.itemIdFromPath(new URL(raw, "https://www.ebay.com").pathname);
      } catch {
        return null;
      }
    }
    const match = raw.match(/\/itm\/(?:[^/]+\/)?(\d{9,20})/);
    return match ? match[1] : null;
  }

  function imagesFrom(node) {
    const urls = [];
    if (!node || !node.querySelectorAll) return urls;
    for (const img of node.querySelectorAll("img")) {
      const src = img.getAttribute("src") || img.getAttribute("data-src") || "";
      if (!/^https?:/i.test(src)) continue;
      if (/pixel|1x1|spacer|s\.gif/i.test(src)) continue;
      urls.push(src.split("?")[0]);
    }
    return [...new Set(urls)].slice(0, 12);
  }

  function shippingFrom(value) {
    const raw = String(value || "");
    if (!raw) return null;
    if (/free/i.test(raw)) return 0;
    return parsePrice(raw);
  }

  function currencyFrom(value, fallback) {
    const raw = String(value || "");
    if (fallback && /^[A-Z]{3}$/.test(fallback)) return fallback;
    if (raw.includes("€")) return "EUR";
    if (raw.includes("£")) return "GBP";
    if (/C\$/.test(raw)) return "CAD";
    return "USD";
  }

  function buyingFormat(value) {
    const raw = String(value || "");
    if (/best offer accepted/i.test(raw)) return { buyingFormat: "best-offer-accepted", acceptedOffer: true };
    if (/\bauction\b|\bbids?\b|place bid/i.test(raw)) return { buyingFormat: "auction", acceptedOffer: false };
    if (/buy it now|\bor best offer\b/i.test(raw)) return { buyingFormat: "bin", acceptedOffer: false };
    return { buyingFormat: null, acceptedOffer: false };
  }

  function statusFrom(value, pageType) {
    const raw = String(value || "");
    const sold = raw.match(/Sold\s+([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i);
    const soldDate = sold ? sold[1] : null;
    if (pageType === "sold_search" || soldDate) return { status: "sold", soldDate };
    if (/\bended\b/i.test(raw)) return { status: "ended", soldDate: null };
    return { status: "active", soldDate: null };
  }

  function readSpecifics(root) {
    const map = {};
    if (!root || !root.querySelectorAll) return map;
    const rows = root.querySelectorAll(
      ".ux-layout-section-evo__item, .ux-labels-values, table.itemAttr tr, [data-testid='ux-labels-values']",
    );
    for (const row of rows) {
      const label = text(row, ".ux-labels-values__labels, dt, th") || text(row, "td:first-child");
      const value = text(row, ".ux-labels-values__values, dd") || text(row, "td:last-child");
      if (!label || !value || label === value) continue;
      map[label] = value;
    }
    return map;
  }

  function productLd(doc) {
    if (!doc || !doc.querySelectorAll) return null;
    for (const node of doc.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(node.textContent || "");
      } catch {
        continue;
      }
      const list = [];
      if (Array.isArray(data)) list.push(...data);
      else if (data && Array.isArray(data["@graph"])) list.push(...data["@graph"]);
      else if (data) list.push(data);
      for (const item of list) {
        const kind = item["@type"];
        if (kind === "Product" || (Array.isArray(kind) && kind.includes("Product"))) return item;
      }
    }
    return null;
  }

  function ldOffer(product) {
    if (!product || !product.offers) return null;
    return Array.isArray(product.offers) ? product.offers[0] : product.offers;
  }

  function feedbackCount(value) {
    const raw = String(value || "").replace(/,/g, "");
    const labeled = raw.match(/(\d+)\s*feedback/i);
    if (labeled) return Number(labeled[1]);
    const paren = String(value || "").match(/\((\d[\d,]*)\)/);
    if (paren) return Number(paren[1].replace(/,/g, ""));
    const bare = raw.match(/^\d+$/);
    if (bare) return Number(bare[0]);
    return null;
  }

  function sellerName(node) {
    if (!node || !node.querySelector) return "";
    const el = node.querySelector("[data-seller], .x-sellercard-atf__info__about-seller a, .ux-seller-section__item--seller a");
    if (!el) return "";
    return (el.getAttribute("data-seller") || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  global.GVParse = global.GVParse || {};
  global.GVParse.common = {
    text,
    parsePrice,
    itemIdFromHref,
    imagesFrom,
    shippingFrom,
    currencyFrom,
    buyingFormat,
    statusFrom,
    readSpecifics,
    productLd,
    ldOffer,
    feedbackCount,
    sellerName,
  };
})(globalThis);
