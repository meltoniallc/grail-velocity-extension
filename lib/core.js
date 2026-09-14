/* Grail Velocity — shared core (content, popup, sidepanel). Classic script. */
(function (global) {
  const FILLER = new Set([
    "the", "a", "an", "and", "of", "for", "with", "card", "cards", "rookie", "rc", "sp", "ssp",
    "base", "basketball", "football", "baseball", "hockey", "soccer", "nba", "nfl", "mlb", "nhl",
    "pokemon", "pokémon", "tcg", "hobby", "box", "blaster", "mega", "pack", "case", "edition",
    "university", "san", "antonio", "spurs", "sealed", "psa", "bgs", "sgc", "cgc", "csg", "hga",
    "gem", "mint", "auto", "autograph", "numbered", "parallel", "short", "print", "from", "the",
  ]);
  const GENERIC_BRAND = new Set(["topps", "panini", "upper", "deck"]);
  const SET_WORDS = new Set([
    "mercury", "prizm", "optic", "chrome", "select", "mosaic", "bowman", "donruss", "hoops",
    "phoenix", "fleer", "immaculate", "flawless", "noir", "contenders", "chronicles",
    "certified", "absolute", "prestige", "revolution", "status", "illusions", "origins",
    "spectra", "knockout", "motif", "now", "heritage", "stadium", "club", "finest", "stadiumclub",
  ]);
  const PARALLEL_WORDS = new Set([
    "refractor", "holo", "silver", "gold", "blue", "red", "green", "orange", "purple", "black",
    "white", "pink", "french", "kaleidoscope", "wave", "laser", "lazer", "explosion", "velocity",
    "premium", "winter", "shimmer", "speckle", "tie-dye", "tiedye", "cracked", "ice", "reactive",
  ]);
  const GRADE_RE = /\b(psa|bgs|sgc|cgc|csg|hga)\s*(\d{1,2}(?:\.\d)?)\b/i;
  const SERIAL_RE = /\b(?:#?\s*)(\d{1,3})\s*\/\s*(\d{1,4})\b/;
  const YEAR_RE = /\b((?:19|20)\d{2}(?:-?\d{2})?)\b/;
  const CARD_NO_RE = /#\s*([a-z]{0,4}-?\d{1,3})\b/i;
  const LOT_RE = /\b(lot of|lot\s*\d|\d+\s*x\s*\d|wholesale lot|bulk lot)\b/i;
  const BREAK_RE = /\b(break|spot|pyt|random team|team break|case break)\b/i;
  const MYSTERY_RE = /\b(mystery|grab bag|repack|random card)\b/i;
  const REPRINT_RE = /\b(reprint|replica|custom|digital|nft)\b/i;
  const KEEP_MIN = 0.72;
  const TIGHT_MIN = 0.85;
  const CLIFF_AFTER_KEEP = 3;
  const CLIFF_FROM_START = 4;
  const HARD_FLAGS = [
    "lot",
    "break",
    "mystery",
    "reprint",
    "wrong_player",
    "wrong_year",
    "wrong_set",
    "wrong_number",
    "wrong_print_run",
    "wrong_parallel",
  ];

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

  function applyAliases(s) {
    return String(s || "")
      .replace(/\bwemby\b/gi, "wembanyama")
      .replace(/\bpokémon\b/gi, "pokemon");
  }

  function fold(s) {
    return applyAliases(s)
      .toLowerCase()
      .replace(/[^a-z0-9#/.\s-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractCardNo(text) {
    const m = String(text || "").match(CARD_NO_RE);
    if (!m) return null;
    return m[1].replace(/^0+/, "").toLowerCase();
  }

  function tokenize(query) {
    const raw = (query || "").trim();
    const lower = fold(raw);
    const yearM = lower.match(YEAR_RE);
    const gradeM = String(query || "").match(GRADE_RE);
    const serialM = lower.match(SERIAL_RE);
    const cardNo = extractCardNo(lower);
    const words = lower
      .replace(/[^a-z0-9/#.\s-]/g, " ")
      .split(/[\s/_-]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 1 && !FILLER.has(w));
    const player = [];
    const setDistinctive = [];
    const setGeneric = [];
    const parallel = [];
    for (const w of unique(words)) {
      if (/^\d{4}$/.test(w) || w === cardNo) continue;
      if (serialM && (w === serialM[1] || w === serialM[2])) continue;
      if (GENERIC_BRAND.has(w)) {
        setGeneric.push(w);
        continue;
      }
      if (SET_WORDS.has(w)) {
        setDistinctive.push(w);
        continue;
      }
      if (PARALLEL_WORDS.has(w)) {
        parallel.push(w);
        continue;
      }
      if (w.length > 3 && !/^\d+$/.test(w)) player.push(w);
    }
    return {
      raw,
      words: unique(words),
      year: yearM ? yearM[1] : null,
      grade: gradeM ? { company: gradeM[1].toLowerCase(), value: gradeM[2] } : null,
      serial: serialM ? { num: serialM[1], pop: serialM[2] } : null,
      cardNo,
      player,
      setDistinctive,
      setGeneric,
      parallel,
      isLotQuery: /\blot\b|\bx\s*\d+\b|\d+\s*x\b/.test(lower),
    };
  }

  function overlapScore(q, title) {
    const t = fold(title);
    const words = q.words || tokenize(q.raw || q).words;
    if (!words.length) return 0;
    let hit = 0;
    for (const w of words) if (t.includes(w)) hit += 1;
    return hit / words.length;
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
    const rows = [];
    let missStreak = 0;
    let keptCount = 0;
    let cliffed = false;
    let stoppedAt = null;
    const list = listings || [];

    for (let i = 0; i < list.length; i += 1) {
      if (cliffed) {
        rows.push({
          ...list[i],
          matchScore: 0,
          flags: ["beyond_cliff"],
          keep: false,
          reason: "Past eBay relevance cliff",
        });
        continue;
      }
      const scored = scoreOne(q, list[i]);
      rows.push(scored);
      if (scored.keep) {
        missStreak = 0;
        keptCount += 1;
      } else {
        missStreak += 1;
        const limit = keptCount > 0 ? CLIFF_AFTER_KEEP : CLIFF_FROM_START;
        if (missStreak >= limit) {
          cliffed = true;
          stoppedAt = i - missStreak + 1;
          for (let j = stoppedAt; j <= i; j += 1) {
            const flags = unique([...(rows[j].flags || []), "beyond_cliff"]);
            rows[j] = {
              ...rows[j],
              flags,
              keep: false,
              reason: "Past eBay relevance cliff",
            };
          }
        }
      }
    }

    const keptPrices = rows.filter((s) => s.keep).map((s) => s.price);
    let scoredRows = rows;
    if (keptPrices.length >= 5) {
      const s = [...keptPrices].sort((a, b) => a - b);
      const q1 = quantile(s, 0.25);
      const q3 = quantile(s, 0.75);
      const iqr = q3 - q1;
      const lo = q1 - 1.5 * iqr;
      const hi = q3 + 1.5 * iqr;
      const outliers = new Set(s.filter((p) => p < lo || p > hi));
      scoredRows = rows.map((row) => {
        if (row.keep && outliers.has(row.price)) {
          return { ...row, keep: false, reason: `${row.reason}; IQR outlier vs the verified set` };
        }
        return row;
      });
    }

    const nKept = scoredRows.filter((r) => r.keep).length;
    const nCliff = scoredRows.filter((r) => (r.flags || []).includes("beyond_cliff")).length;
    return {
      rows: scoredRows,
      stoppedAt: stoppedAt == null ? scoredRows.length : stoppedAt,
      nKept,
      nCliff,
      nRaw: list.length,
      query,
    };
  }

  function scoreOne(q, listing) {
    const title = listing.title || "";
    const flags = [];
    const t = fold(title);
    let score = 0;

    if (!q.isLotQuery && LOT_RE.test(t)) flags.push("lot");
    if (BREAK_RE.test(t)) flags.push("break");
    if (MYSTERY_RE.test(t)) flags.push("mystery");
    if (REPRINT_RE.test(t)) flags.push("reprint");

    if (q.player.length) {
      const last = [...q.player].sort((a, b) => b.length - a.length)[0];
      const hits = q.player.filter((w) => t.includes(w));
      if (!t.includes(last) || hits.length === 0) flags.push("wrong_player");
      else score += 0.28 * (hits.length / q.player.length);
    }

    if (q.year) {
      const ym = t.match(YEAR_RE);
      if (ym && !yearsCompatible(q.year, ym[1])) flags.push("wrong_year");
      else if (ym && yearsCompatible(q.year, ym[1])) score += 0.12;
    }

    if (q.setDistinctive.length) {
      const hits = q.setDistinctive.filter((w) => t.includes(w));
      if (!hits.length) flags.push("wrong_set");
      else score += 0.22 * (hits.length / q.setDistinctive.length);
    } else if (q.setGeneric.length) {
      if (!q.setGeneric.some((w) => t.includes(w))) flags.push("wrong_set");
      else score += 0.1;
    }

    if (q.cardNo) {
      const listingNo = extractCardNo(title);
      if (!listingNo || listingNo !== q.cardNo) flags.push("wrong_number");
      else score += 0.18;
    }

    if (q.serial) {
      const sm = t.match(SERIAL_RE);
      if (!sm || sm[2] !== q.serial.pop) flags.push("wrong_print_run");
      else score += 0.12;
    }

    if (q.parallel.length) {
      const hits = q.parallel.filter((w) => t.includes(w));
      if (hits.length < q.parallel.length) flags.push("wrong_parallel");
      else score += 0.08;
    }

    const identity = unique([...q.player, ...q.setDistinctive, ...q.setGeneric, ...q.parallel]);
    if (identity.length) {
      const extraHits = identity.filter((w) => t.includes(w)).length;
      score += 0.22 * (extraHits / identity.length);
    } else {
      score += overlapScore(q, title);
    }

    if (q.grade) {
      const gm = title.match(GRADE_RE);
      if (gm) {
        if (gm[2] !== q.grade.value) flags.push("grade_mismatch");
      } else if (/\braw\b/.test(t) || !GRADE_RE.test(title)) flags.push("grade_mismatch");
    }

    score = Math.min(1, round2(score));
    if (score < KEEP_MIN) flags.push("weak_title");
    const hard = flags.some((f) => HARD_FLAGS.includes(f));
    const keep = !hard && score >= KEEP_MIN;
    if (hard) score = Math.min(score, KEEP_MIN - 0.01);
    let reason = "Partial match";
    if (flags.length) reason = flags.join(" · ");
    else if (score >= TIGHT_MIN) reason = "Tight title match";
    return { ...listing, matchScore: round2(score), flags, keep, reason };
  }

  function soldVerified(rows) {
    return (rows || []).filter((row) => row.keep && row.kind !== "active");
  }

  function scoreVelocity(opts) {
    const settings = opts.settings || DEFAULT_FEES;
    const rows = opts.verified || [];
    const kept = rows.filter((v) => v.keep && v.price > 0 && v.kind !== "active");
    const n = rows.length;
    const nKept = kept.length;
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
      reasons: ["Need 2+ high-match comps before a price is actionable."],
      warnings,
    };
    const tight = kept.filter((k) => (k.matchScore ?? 0) >= TIGHT_MIN);
    if (nKept < 2 || (nKept < 3 && tight.length < 2)) return empty;
    const prices = kept.map((k) => k.price).sort((a, b) => a - b);
    const median = round2(quantile(prices, 0.5));
    const p25 = round2(quantile(prices, 0.25));
    const p75 = round2(quantile(prices, 0.75));
    const netMedian = netProceeds(median, settings);
    const cogs = Math.max(0, opts.cogs || 0);
    const marginPct = cogs > 0 ? round2((netMedian - cogs) / cogs) : null;
    const fastCashPrice = round2(p25 * 0.98);
    const listPrice = opts.listPrice ?? null;
    const reasons = [];
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
    } else if ((nKept >= 8 || tight.length >= 2) && (marginPct ?? 1) >= 0.15) {
      action = "FAST_CASH";
      reasons.push("High-match tape. Fast-cash at P25 beats sitting on median.");
    } else {
      action = "LIST";
      reasons.push("List at median. Want C, need A.");
    }
    return {
      action,
      score: Math.min(100, nKept * 8 + Math.round((tight[0]?.matchScore || 0) * 20)),
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

  function prefixScore(needle, hay) {
    const n = fold(needle);
    const h = fold(hay);
    if (!n || !h) return 0;
    if (h === n) return 1;
    if (h.startsWith(n)) return 0.92 + Math.min(0.07, n.length / 80);
    const nt = n.split(" ").filter(Boolean);
    const ht = h.split(" ").filter(Boolean);
    if (nt.length === 1 && n.length <= 2) {
      if (ht.some((tok) => tok.startsWith(n))) return 0.7;
      if (h.includes(n)) return 0.4;
      return 0;
    }
    let hit = 0;
    for (const tok of nt) {
      if (ht.some((x) => x.startsWith(tok) || x.includes(tok))) hit += 1;
    }
    if (!hit) return 0;
    if (hit === nt.length) return 0.45 + 0.4 * (hit / Math.max(ht.length, nt.length));
    if (nt.length >= 3 && hit / nt.length < 0.7) return 0;
    return 0.2 * (hit / nt.length);
  }

  function suggestTape(query, opts) {
    const needle = fold(query);
    if (!needle) return [];
    const limit = (opts && opts.limit) || 8;
    const tape = (opts && opts.tape) || [];
    const catalog = (opts && opts.catalog) || [];
    const hits = [];
    for (const snap of tape) {
      const title = snap.title || snap.query || "";
      const score = Math.max(prefixScore(needle, snap.query || ""), prefixScore(needle, title)) + 0.06;
      if (score > 0.06) {
        hits.push({
          kind: "tape",
          score,
          query: snap.query || title,
          title,
          fastCash: snap.fastCash,
          nKept: snap.nKept,
          at: snap.at,
        });
      }
    }
    for (const item of catalog) {
      const score = Math.max(
        prefixScore(needle, item.title || ""),
        prefixScore(needle, item.player || ""),
        prefixScore(needle, item.id || ""),
      );
      if (score > 0) {
        hits.push({
          kind: "book",
          score,
          query: item.title,
          title: item.title,
          fastCash: item.fastCash,
          id: item.id,
          listPrice: item.listPrice,
        });
      }
    }
    hits.sort((a, b) => b.score - a.score || (b.at || 0) - (a.at || 0));
    const seen = new Set();
    const out = [];
    for (const hit of hits) {
      const key = fold(hit.title || hit.query);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
      if (out.length >= limit) break;
    }
    return out;
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
    if (!out.length && /\/itm\//.test(location.pathname)) {
      const itemTitle =
        text(doc, "#itemTitle, .x-item-title__mainTitle, h1") || pageQuery();
      const itemPrice =
        parsePrice(text(doc, ".x-price-primary, #prcIsum, .x-bin-price, [itemprop='price']")) ||
        parsePrice(doc.querySelector("[itemprop='price']")?.getAttribute("content"));
      const itemId = (location.pathname.match(/\/itm\/(?:[^/]+\/)?(\d{9,20})/) || [])[1];
      if (itemTitle && itemPrice) {
        out.push({
          id: itemId || `ebay-item-${itemPrice}`,
          title: itemTitle.replace(/^Details about\s+/i, "").replace(/\s+/g, " ").trim(),
          price: itemPrice,
          shipping: null,
          soldDate: null,
          url: location.href.split("?")[0],
          image: doc.querySelector("img#icImg, .ux-image-carousel img")?.getAttribute("src") || null,
          condition: null,
          source: "ebay",
          kind: isSoldSearch() || /this listing (has )?sold/i.test(doc.body?.innerText?.slice(0, 2000) || "") ? "sold" : "active",
        });
      }
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
    return p.get("LH_Sold") === "1" || p.get("LH_Complete") === "1";
  }

  function isSearchPage() {
    return /\/sch\//.test(location.pathname) || Boolean(document.querySelector(".s-item, .s-card, li[data-viewport]"));
  }

  function pageMode() {
    if (isSoldSearch()) return "sold";
    if (isListingOrRevise()) return "listing";
    if (isSearchPage()) return "live";
    return "page";
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
      const scored = scoreOne(q, { title: `${item.title} ${item.player || ""}`, price: 1 });
      const score = Math.max(scored.matchScore, overlapScore(q, `${item.title} ${item.player || ""}`));
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
    return bestScore >= KEEP_MIN ? best : null;
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
    KEEP_MIN,
    TIGHT_MIN,
    money,
    parsePrice,
    tokenize,
    overlapScore,
    verifyComps,
    soldVerified,
    scoreVelocity,
    suggestTape,
    scrapeEbay,
    pageQuery,
    pageMode,
    isSoldSearch,
    isSearchPage,
    isListingOrRevise,
    applyPrice,
    matchSku,
    soldUrl,
    netProceeds,
    round2,
    fold,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
