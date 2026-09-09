/* Grail Velocity — shared core (content, popup, sidepanel). Classic script. */
(function (global) {
  const STOP = new Set([
    "the", "a", "an", "and", "of", "for", "with", "card", "cards", "rookie", "rc", "sp", "ssp",
    "base", "basketball", "football", "baseball", "hockey", "soccer", "nba", "nfl", "mlb", "nhl",
    "pokemon", "pokémon", "tcg", "hobby", "box", "blaster", "mega", "pack", "case", "edition",
    "university", "san", "antonio", "spurs",
  ]);
  const GRADE_RE = /\b(psa|bgs|sgc|cgc|csg|hga)\s*(\d{1,2}(?:\.\d)?)\b/i;
  const SERIAL_RE = /\b(?:#?\s*)(\d{1,3})\s*\/\s*(\d{1,4})\b/;
  const YEAR_RE = /\b((?:19|20)\d{2}(?:-?\d{2})?)\b/;
  const LOT_RE = /\b(lot of|lot\s*\d|\d+\s*x\s*\d|wholesale lot|bulk lot)\b/i;
  const BREAK_RE = /\b(break|spot|pyt|random team|team break|case break)\b/i;
  const MYSTERY_RE = /\b(mystery|grab bag|repack|random card)\b/i;
  const REPRINT_RE = /\b(reprint|replica|custom|digital|nft)\b/i;

  const DEFAULT_FEES = {
    category: "cards",
    hasStore: false,
    promotedPct: 0,
    shippingCost: 4.5,
    perOrderFee: 0.4,
  };

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function money(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  }

  function parsePrice(text) {
    if (text == null || text === "") return null;
    const cleaned = String(text).replace(/[^\d.,]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned.replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function unique(arr) {
    return [...new Set(arr)];
  }

  function tokenize(query) {
    const raw = (query || "").trim();
    const lower = raw.toLowerCase();
    const yearM = lower.match(YEAR_RE);
    const gradeM = lower.match(GRADE_RE);
    const serialM = lower.match(SERIAL_RE);
    const words = lower
      .replace(/[^a-z0-9/#.\s-]/g, " ")
      .split(/[\s/_-]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 1 && !STOP.has(w));
    return {
      raw,
      words: unique(words),
      year: yearM ? yearM[1] : null,
      grade: gradeM ? { company: gradeM[1].toLowerCase(), value: gradeM[2] } : null,
      serial: serialM ? { num: serialM[1], pop: serialM[2] } : null,
      isLotQuery: /\blot\b|\bx\s*\d+\b|\d+\s*x\b/.test(lower),
    };
  }

  function overlapScore(q, title) {
    const t = (title || "").toLowerCase();
    if (!q.words.length) return 0;
    let hit = 0;
    for (const w of q.words) if (t.includes(w)) hit += 1;
    return hit / q.words.length;
  }

  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    const pos = (sorted.length - 1) * q;
    const b = Math.floor(pos);
    const rest = pos - b;
    return sorted[b + 1] !== undefined ? sorted[b] + rest * (sorted[b + 1] - sorted[b]) : sorted[b];
  }

  function fvfRate(category, hasStore, total) {
    if (category === "sneakers" && total >= 150) return 0.08;
    if (category === "cards") return hasStore ? 0.1235 : 0.1325;
    return 0.136;
  }

  function ebayFees(totalAmount, settings) {
    const total = Math.max(0, totalAmount);
    const rate = fvfRate(settings.category, settings.hasStore, total);
    const cap = 7500;
    const fvf = Math.min(total, cap) * rate + Math.max(0, total - cap) * 0.0235;
    const skipOrderFee = settings.category === "sneakers" && total >= 150;
    const orderFee = skipOrderFee ? 0 : total <= 10 ? 0.3 : settings.perOrderFee;
    const promo = total * (Math.max(0, settings.promotedPct) / 100);
    return round2(fvf + orderFee + promo);
  }

  function netProceeds(soldPrice, settings) {
    return round2(soldPrice - ebayFees(soldPrice, settings) - settings.shippingCost);
  }

  function yearsCompatible(a, b) {
    const na = a.replace("-", "").slice(0, 4);
    const nb = b.replace("-", "").slice(0, 4);
    if (na === nb) return true;
    return a.replace("-", "").startsWith(nb) || b.replace("-", "").startsWith(na);
  }

  function verifyComps(query, listings) {
    const q = tokenize(query);
    const scored = listings.map((l) => scoreOne(q, l));
    const keptPrices = scored.filter((s) => s.keep).map((s) => s.price);
    if (keptPrices.length < 5) return scored;
    const s = [...keptPrices].sort((a, b) => a - b);
    const q1 = quantile(s, 0.25);
    const q3 = quantile(s, 0.75);
    const iqr = q3 - q1;
    const lo = q1 - 1.5 * iqr;
    const hi = q3 + 1.5 * iqr;
    const outliers = new Set(s.filter((p) => p < lo || p > hi));
    return scored.map((row) => {
      if (row.keep && outliers.has(row.price)) {
        return { ...row, keep: false, reason: `${row.reason}; IQR outlier vs the verified set` };
      }
      return row;
    });
  }

  function scoreOne(q, listing) {
    const title = listing.title || "";
    const flags = [];
    let score = overlapScore(q, title);
    const t = title.toLowerCase();
    if (!q.isLotQuery && LOT_RE.test(t)) flags.push("lot");
    if (BREAK_RE.test(t)) flags.push("break");
    if (MYSTERY_RE.test(t)) flags.push("mystery");
    if (REPRINT_RE.test(t)) flags.push("reprint");
    if (q.year) {
      const ym = t.match(YEAR_RE);
      if (ym && !yearsCompatible(q.year, ym[1])) flags.push("wrong_year");
    }
    const playerHits = q.words.filter((w) => w.length > 3 && !/^\d/.test(w));
    if (playerHits.length >= 2 && playerHits.filter((w) => t.includes(w)).length === 0) flags.push("wrong_player");
    if (q.grade) {
      const gm = t.match(GRADE_RE);
      if (gm) {
        if (gm[2] !== q.grade.value) flags.push("grade_mismatch");
      } else if (/\braw\b/.test(t) || !GRADE_RE.test(t)) flags.push("grade_mismatch");
    }
    if (score < 0.35) flags.push("weak_title");
    const hard = flags.some((f) => ["lot", "break", "mystery", "reprint", "wrong_player", "wrong_year"].includes(f));
    const keep = !hard && score >= 0.35;
    if (hard) score = Math.min(score, 0.32);
    const reason = flags.length ? flags.join(" · ") : score >= 0.7 ? "Tight title match" : "Partial match";
    return { ...listing, matchScore: round2(score), flags, keep, reason };
  }

  function scoreVelocity(opts) {
    const settings = opts.settings || DEFAULT_FEES;
    const kept = (opts.verified || []).filter((v) => v.keep && v.price > 0);
    const n = (opts.verified || []).length;
    const nKept = kept.length;
    const reasons = [];
    const warnings = [];
    const empty = {
      action: "QUARANTINE",
      score: Math.max(8, nKept * 6),
      n,
      nKept,
      median: null,
      p25: null,
      p75: null,
      netMedian: null,
      marginPct: null,
      fastCashPrice: null,
      listAt: null,
      reasons: ["Need 3+ verified comps before a price is actionable."],
      warnings,
    };
    if (nKept < 3) return empty;
    const prices = kept.map((k) => k.price).sort((a, b) => a - b);
    const median = round2(quantile(prices, 0.5));
    const p25 = round2(quantile(prices, 0.25));
    const p75 = round2(quantile(prices, 0.75));
    const netMedian = netProceeds(median, settings);
    const cogs = Math.max(0, opts.cogs || 0);
    const marginPct = cogs > 0 ? round2((netMedian - cogs) / cogs) : null;
    const spread = median > 0 ? round2((p75 - p25) / median) : null;
    const fastCashPrice = round2(p25 * 0.98);
    const listPrice = opts.listPrice ?? null;
    reasons.push(`${nKept} verified / ${n} raw`);
    reasons.push(`Tape ${money(p25)}–${money(p75)} (med ${money(median)})`);
    let action = "LIST";
    if (cogs > 0 && netMedian < cogs * 1.05) {
      action = "PASS";
      reasons.push("Net after fees does not clear a 5% floor over COGS.");
    } else if (listPrice != null && listPrice > p75 * 1.12) {
      action = "CUT";
      reasons.push("Current ask is above P75 + 12%. You're the ceiling.");
    } else if (listPrice != null && listPrice < p25 * 0.92 && (marginPct ?? 0) > 0.1) {
      action = "RAISE";
      reasons.push("Ask is under P25.");
    } else if (nKept >= 8 && (marginPct ?? 1) >= 0.15) {
      action = "FAST_CASH";
      reasons.push("Tape is liquid. Fast-cash at P25 beats sitting on median.");
    } else {
      action = "LIST";
      reasons.push("List at median. Want C, need A.");
    }
    return {
      action,
      score: Math.min(100, nKept * 8),
      n,
      nKept,
      median,
      p25,
      p75,
      netMedian,
      marginPct,
      fastCashPrice,
      listAt: median,
      reasons,
      warnings,
    };
  }

  function text(node, selector) {
    const el = node.querySelector(selector);
    return (el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function scrapeEbay(root) {
    const doc = root || document;
    const nodes = doc.querySelectorAll(".s-item, .s-card, li[data-viewport], [data-gv-item]");
    const out = [];
    let i = 0;
    for (const node of nodes) {
      const title =
        node.getAttribute("data-gv-title") ||
        text(node, ".s-item__title, .s-card__title, .s-card__title span, [role='heading']");
      if (!title || /shop on ebay/i.test(title)) continue;
      const price =
        parsePrice(node.getAttribute("data-gv-price")) ||
        parsePrice(text(node, ".s-item__price, .s-card__price, .s-card__price span"));
      if (!price) continue;
      const caption = text(node, ".s-item__caption, .s-item__ended-date, .POSITIVE, .s-card__caption");
      const dateM = caption.match(/Sold\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/i);
      const shipRaw = text(node, ".s-item__shipping, .s-item__logisticsCost");
      const hrefEl = node.querySelector("a.s-item__link, a.s-card__link, a[href*='/itm/']");
      const img = node.querySelector("img");
      out.push({
        id: node.getAttribute("data-gv-id") || `ebay-${i++}-${price}`,
        title,
        price,
        shipping: /free/i.test(shipRaw) ? 0 : parsePrice(shipRaw),
        soldDate: dateM ? dateM[1] : null,
        url: hrefEl ? (hrefEl.getAttribute("href") || "").split("?")[0] : null,
        image: img ? img.getAttribute("src") : null,
        condition: text(node, ".SECONDARY_ITEM_CONDITION") || null,
        source: "ebay",
        kind: dateM || /sold/i.test(caption) ? "sold" : "active",
      });
    }
    return out;
  }

  function pageQuery() {
    const params = new URLSearchParams(location.search);
    const nkw = params.get("_nkw") || params.get("_from") || "";
    if (nkw) return decodeURIComponent(nkw).replace(/\+/g, " ");
    const box = document.querySelector("#gh-ac, input[name='_nkw'], input[type='search']");
    if (box && box.value) return box.value.trim();
    const title = document.querySelector("#itemTitle, .x-item-title__mainTitle, h1");
    if (title) return title.textContent.replace(/^Details about\s+/i, "").replace(/\s+/g, " ").trim();
    return document.title.replace(/\s*\|\s*eBay.*$/i, "").trim();
  }

  function isSoldSearch() {
    const p = new URLSearchParams(location.search);
    return p.get("LH_Sold") === "1" || p.get("LH_Complete") === "1" || /sold/i.test(document.body?.innerText?.slice(0, 400) || "");
  }

  function isListingOrRevise() {
    return /\/itm\//.test(location.pathname) || /ReviseItem|revise/i.test(location.href) || Boolean(document.querySelector("#binPrice, input[name='binPrice']"));
  }

  function applyPrice(price) {
    const selectors = [
      "#binPrice",
      "input[name='binPrice']",
      "input[name='StartPrice']",
      "input[id*='StartPrice' i]",
      "input[name='price']",
      "input[aria-label*='Price' i]",
      "input[aria-label*='Buy it now' i]",
      "input[placeholder*='Price' i]",
      "input[data-testid*='price' i]",
      "input[id*='price' i]",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && "value" in el) {
        el.focus();
        const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
        if (proto && proto.set) proto.set.call(el, Number(price).toFixed(2));
        else el.value = Number(price).toFixed(2);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  function matchSku(catalog, query) {
    const q = tokenize(query);
    let best = null;
    let bestScore = 0;
    for (const item of catalog || []) {
      const score = overlapScore(q, `${item.title} ${item.player || ""}`);
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
    return bestScore >= 0.35 ? best : null;
  }

  function soldUrl(query) {
    const params = new URLSearchParams({
      _nkw: query,
      LH_Sold: "1",
      LH_Complete: "1",
      _sop: "13",
      _ipg: "25",
    });
    return `https://www.ebay.com/sch/i.html?${params.toString()}`;
  }

  global.GV = {
    DEFAULT_FEES,
    money,
    parsePrice,
    tokenize,
    overlapScore,
    verifyComps,
    scoreVelocity,
    scrapeEbay,
    pageQuery,
    isSoldSearch,
    isListingOrRevise,
    applyPrice,
    matchSku,
    soldUrl,
    netProceeds,
    round2,
  };
})(typeof window !== "undefined" ? window : self);
