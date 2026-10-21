/* Page-view capture policy. No network, no DOM. Classic script. */
(function (global) {
  const URL_COOLDOWN_MS = 10 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;
  const HOUR_CAP = 300;
  const DEFAULT_PAUSE_PATTERNS = [
    "ebay.com/checkout",
    "pay.ebay.com",
    "payments.ebay.com",
    "ebay.com/mye/",
    "ebay.com/mys/",
    "mesg.ebay.com",
    "ebay.com/cnt/",
    "signin.ebay.com",
  ];
  const SEARCH_PARAMS = ["_nkw", "LH_Sold", "LH_Complete", "_sop", "_pgn", "_ipg", "_sacat", "LH_BIN", "LH_Auction"];

  function defaultSettings() {
    return {
      captureEnabled: true,
      sites: { ebay: true },
      pausePatterns: DEFAULT_PAUSE_PATTERNS.slice(),
      capturePausedUntil: 0,
      sellerHmacSecret: "",
      ownSellerId: "",
    };
  }

  function validPausePattern(value) {
    const pattern = String(value || "").trim().toLowerCase();
    if (pattern.length < 6 || pattern.length > 120) return false;
    if (pattern === "ebay.com" || pattern === "www.ebay.com" || pattern === "https://www.ebay.com") return false;
    return true;
  }

  function normalizeSettings(raw) {
    const base = defaultSettings();
    const src = raw && typeof raw === "object" ? raw : {};
    const patterns = Array.isArray(src.pausePatterns)
      ? src.pausePatterns.map((item) => String(item).trim().toLowerCase()).filter(validPausePattern)
      : base.pausePatterns;
    return {
      captureEnabled: src.captureEnabled !== false,
      sites: { ebay: !src.sites || src.sites.ebay !== false },
      pausePatterns: patterns,
      capturePausedUntil: Number(src.capturePausedUntil) || 0,
      sellerHmacSecret: String(src.sellerHmacSecret || ""),
      ownSellerId: String(src.ownSellerId || "").trim(),
    };
  }

  function cleanEbayUrl(input) {
    let url;
    try {
      url = new URL(input);
    } catch {
      return "";
    }
    url.hash = "";
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    if (/\/itm\//.test(url.pathname)) {
      url.search = "";
      return url.toString();
    }
    const keep = new Set(SEARCH_PARAMS);
    const next = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      if (keep.has(key)) next.append(key, value);
    }
    next.sort();
    url.search = next.toString() ? `?${next.toString()}` : "";
    return url.toString();
  }

  function classify(input) {
    let url;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== "ebay.com" && !host.endsWith(".ebay.com")) return null;
    if (/\/itm\//.test(url.pathname)) return { site: "ebay", pageType: "item" };
    const search = /\/sch\//.test(url.pathname);
    if (!search) return null;
    const sold = url.searchParams.get("LH_Sold") === "1";
    if (sold) return { site: "ebay", pageType: "sold_search" };
    return { site: "ebay", pageType: "active_search" };
  }

  function isPaused(input, patterns) {
    const hay = String(input || "").toLowerCase();
    return (patterns || []).some((pattern) => pattern && hay.includes(pattern));
  }

  function feedbackBucket(count) {
    const n = Number(String(count ?? "").replace(/,/g, ""));
    if (!Number.isFinite(n)) return null;
    if (n < 100) return "<100";
    if (n < 1000) return "100-1k";
    return "1k+";
  }

  function dayKey(now) {
    const date = new Date(now);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function hashMaterial(obs) {
    const price = obs.price == null || obs.price === "" || Number.isNaN(Number(obs.price))
      ? ""
      : Number(obs.price).toFixed(2);
    return `${obs.site || ""}|${obs.item_id || ""}|${obs.status || ""}|${price}|${obs.sold_date || ""}`;
  }

  function hex(buffer) {
    return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return hex(digest);
  }

  async function sellerHash(username, secret) {
    const name = String(username || "").trim().toLowerCase();
    if (!name || !secret) return null;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(name));
    return hex(sig);
  }

  function admit(rate, cleanUrl, now) {
    const recentIn = rate && rate.recent ? rate.recent : {};
    const hourIn = rate && rate.hour ? rate.hour : { start: now, count: 0 };
    let start = Number(hourIn.start) || now;
    let count = Number(hourIn.count) || 0;
    if (now - start >= HOUR_MS) {
      start = now;
      count = 0;
    }
    const recent = {};
    for (const [key, at] of Object.entries(recentIn)) {
      if (now - Number(at) < URL_COOLDOWN_MS) recent[key] = Number(at);
    }
    if (count >= HOUR_CAP) return { ok: false, reason: "hour-cap", rate: { recent, hour: { start, count } } };
    if (recent[cleanUrl] && now - recent[cleanUrl] < URL_COOLDOWN_MS) {
      return { ok: false, reason: "url-cooldown", rate: { recent, hour: { start, count } } };
    }
    recent[cleanUrl] = now;
    return { ok: true, rate: { recent, hour: { start, count: count + 1 } } };
  }

  function gate(pageUrl, settings, rate, now) {
    const prefs = normalizeSettings(settings);
    if (!prefs.captureEnabled) return { ok: false, reason: "off" };
    if (prefs.capturePausedUntil && now < prefs.capturePausedUntil) return { ok: false, reason: "paused" };
    if (isPaused(pageUrl, prefs.pausePatterns)) return { ok: false, reason: "pause-list" };
    const page = classify(pageUrl);
    if (!page) return { ok: false, reason: "page" };
    if (page.site === "ebay" && prefs.sites.ebay === false) return { ok: false, reason: "site" };
    const clean = cleanEbayUrl(pageUrl);
    const admission = admit(rate, clean, now);
    if (!admission.ok) return { ok: false, reason: admission.reason, rate: admission.rate };
    return { ok: true, page, url: clean, rate: admission.rate };
  }

  function stripSellerKeys(value) {
    if (!value || typeof value !== "object") return {};
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(seller|seller username|seller_username|username)$/i.test(key)) continue;
      out[key] = item;
    }
    return out;
  }

  async function sealObservation(obs, settings) {
    const prefs = normalizeSettings(settings);
    const username = String(obs.seller_username || "").trim();
    const own = Boolean(prefs.ownSellerId) && username.toLowerCase() === prefs.ownSellerId.toLowerCase();
    const sealed = {
      site: obs.site || "ebay",
      page_type: obs.page_type,
      url: obs.url || "",
      item_id: obs.item_id ? String(obs.item_id) : "",
      title: obs.title || "",
      price: obs.price == null || obs.price === "" ? null : Number(obs.price),
      currency: obs.currency || "USD",
      shipping: obs.shipping == null || obs.shipping === "" ? null : Number(obs.shipping),
      buying_format: obs.buying_format || null,
      accepted_offer: Boolean(obs.accepted_offer),
      status: obs.status || "active",
      sold_date: obs.sold_date || null,
      condition: obs.condition || null,
      grade_co: obs.grade_co || "",
      grade: obs.grade || "",
      cert: obs.cert || "",
      serial: obs.serial || "",
      is_auto: Boolean(obs.is_auto),
      is_rookie: Boolean(obs.is_rookie),
      parallel: obs.parallel || "",
      set_name: obs.set_name || "",
      year: obs.year || "",
      player: obs.player || "",
      card_no: obs.card_no || "",
      is_print_to_order: Boolean(obs.is_print_to_order),
      specifics: stripSellerKeys(obs.specifics),
      image_urls: Array.isArray(obs.image_urls) ? obs.image_urls.filter((item) => /^https?:/i.test(item)).slice(0, 12) : [],
      captured_at: obs.captured_at || new Date().toISOString(),
      extension_version: obs.extension_version || "",
      parser_ver: obs.parser_ver || "",
      feedback_bucket: feedbackBucket(obs.feedback_count),
      seller_hash: await sellerHash(username, prefs.sellerHmacSecret),
      own_sale: own,
      own_seller_id: own ? prefs.ownSellerId : null,
    };
    sealed.raw_hash = await sha256Hex(hashMaterial(sealed));
    return sealed;
  }

  global.GVObserve = {
    URL_COOLDOWN_MS,
    HOUR_MS,
    HOUR_CAP,
    DEFAULT_PAUSE_PATTERNS,
    defaultSettings,
    validPausePattern,
    normalizeSettings,
    cleanEbayUrl,
    classify,
    isPaused,
    feedbackBucket,
    dayKey,
    hashMaterial,
    sha256Hex,
    sellerHash,
    admit,
    gate,
    sealObservation,
  };
})(globalThis);
