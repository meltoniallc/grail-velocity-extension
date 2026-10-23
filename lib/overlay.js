/* Grail Velocity — operator UX helpers (overlay, side panel). Classic script. */
(function (global) {
  const GV = global.GV;
  if (!GV) return;

  const OVERLAY_HOST_ID = "grail-velocity-root";

  function findingsText(opts) {
    const query = opts.query;
    const velocity = opts.velocity;
    const pageRows = opts.pageRows || [];
    const soldTape = opts.soldTape || [];
    const money = opts.money || GV.money;
    const cashFromTape = opts.cashFromTape || GV.cashFromTape;
    const keptPage = pageRows.filter((row) => row.keep);
    const keptSold = soldTape.filter((row) => row.keep);
    const fast = cashFromTape(velocity).value;
    const lines = [
      `Grail Velocity — ${query || "(no query)"}`,
      `Action: ${velocity?.action || "QUARANTINE"}`,
      `Fast-Cash: ${money(fast)}`,
      `P25–P75: ${money(velocity?.p25)}–${money(velocity?.p75)}`,
      `Net after fees: ${money(velocity?.netMedian)}`,
      `Page kept: ${keptPage.length}/${pageRows.length}`,
      `Sold kept: ${keptSold.length}/${soldTape.length}`,
      "",
      "Sold tape:",
      ...keptSold.map((r) => `- ${r.title} — ${money(r.price)}`),
    ];
    if (velocity?.reasons?.length) {
      lines.push("", "Why:", ...velocity.reasons.map((r) => `- ${r}`));
    }
    return lines.join("\n");
  }

  function isInsideHost(node, hostId) {
    const id = hostId || OVERLAY_HOST_ID;
    if (!node) return false;
    if (node.id === id) return true;
    if (node.nodeType === 1 && node.closest?.("#" + id)) return true;
    if (node.nodeType === 3 && node.parentElement?.closest?.("#" + id)) return true;
    return false;
  }

  function pageChanged(mutations, hostId) {
    for (const m of mutations || []) {
      if (isInsideHost(m.target, hostId)) continue;
      for (const n of m.addedNodes || []) {
        if (isInsideHost(n, hostId)) continue;
        return true;
      }
      for (const n of m.removedNodes || []) {
        if (isInsideHost(n, hostId)) continue;
        return true;
      }
      if (m.type === "attributes" || m.type === "characterData") return true;
    }
    return false;
  }

  function isOverlayToggleHotkey(e) {
    if (!e || !e.altKey || !e.shiftKey) return false;
    if (e.key !== "g" && e.key !== "G") return false;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return false;
    return true;
  }

  function preserveKeepToggles(rows, prevKeep, queryUnchanged) {
    const list = rows || [];
    if (!queryUnchanged || !prevKeep || !prevKeep.size) return list;
    return list.map((row) => (prevKeep.has(row.id) ? { ...row, keep: prevKeep.get(row.id) } : row));
  }

  function lastReadPayload(opts) {
    const pageRows = opts.pageRows || [];
    const soldTape = opts.soldTape || [];
    const cashFromTape = opts.cashFromTape || GV.cashFromTape;
    const keptSold = soldTape.filter((row) => row.keep);
    return {
      query: opts.query,
      n: soldTape.length || pageRows.length,
      kept: keptSold.length || pageRows.filter((row) => row.keep).length,
      action: opts.velocity?.action || "QUARANTINE",
      fastCash: cashFromTape(opts.velocity).value,
      at: opts.at,
    };
  }

  function listedAsk(pageMode, sku, pageRows) {
    if (pageMode === "sold") return null;
    const pageAsk = (pageRows || []).find((row) => row.keep)?.price;
    if (pageAsk != null) return pageAsk;
    return null;
  }

  function mergeKeepIntoSoldTape(soldTape, pageRows) {
    const byId = new Map((soldTape || []).map((row) => [row.id, row]));
    for (const row of pageRows || []) {
      if (!byId.has(row.id)) continue;
      if (row.kind === "active") continue;
      byId.set(row.id, { ...byId.get(row.id), keep: row.keep });
    }
    return [...byId.values()];
  }

  function npmTapeCommand(secret) {
    const s = String(secret || "").trim();
    if (!s) return "npm run tape";
    const quoted = `'${s.replace(/'/g, `'\\''`)}'`;
    return `TAPE_SECRET=${quoted} npm run tape`;
  }

  function formatLastRead(lastRead, now, money) {
    const fmt = money || GV.money;
    if (!lastRead?.at) {
      return "No tab scraped yet. On eBay: Scrape this page, or Alt+Shift+G.";
    }
    const age = Math.max(0, Math.round(((now || Date.now()) - lastRead.at) / 60000));
    const when = age < 1 ? "just now" : age === 1 ? "1m ago" : `${age}m ago`;
    const cash = lastRead.fastCash != null ? " · " + fmt(lastRead.fastCash) : "";
    return `Last read ${when}: ${lastRead.query || "—"} · ${lastRead.kept}/${lastRead.n} kept · ${String(lastRead.action || "").replace("_", " ")}${cash}`;
  }

  function rankCuts(list) {
    return (list || [])
      .filter((i) => i.listPrice && i.fastCash)
      .sort((a, b) => b.listPrice - b.fastCash - (a.listPrice - a.fastCash));
  }

  function queueCopyText(items, money) {
    const fmt = money || GV.money;
    const ranked = rankCuts(items).slice(0, 40);
    if (!ranked.length) return "";
    const header = "id\ttitle\tlist\tfastCash\tgap\n";
    const text = ranked
      .map((i) => {
        const gap = (i.listPrice || 0) - (i.fastCash || 0);
        return `${i.id}\t${i.title}\t${fmt(i.listPrice)}\t${fmt(i.fastCash)}\t${fmt(gap)}`;
      })
      .join("\n");
    return header + text;
  }

  /** Tiny overlay capture line: watching | scraped | cliffed (no match-math changes). */
  function captureStatus(opts) {
    const o = opts || {};
    if (o.scraping) return "watching";
    if ((o.nCliff || 0) > 0) return "cliffed";
    if ((o.nRaw || 0) > 0 || (o.pageRows && o.pageRows.length) || (o.soldTape && o.soldTape.length)) {
      return "scraped";
    }
    return "watching";
  }

  /**
   * Operator-facing desk copy for capture + Fast-Cash empty states.
   * Aligns overlay / panel language; does not change match math.
   */
  const DESK_EMPTY = {
    watching: "watching solds…",
    noTape: "NO TAPE — Get solds (or wait for auto-capture)",
    cliff: "cliff — junk parked in scratch",
    scraped: "scraped",
  };

  /** sessionStorage key for pending Get solds capture after sold-search navigation. */
  const GET_SOLDS_PENDING_KEY = "gvGetSolds";

  /**
   * Plan the Get solds primary action (NO TAPE desk).
   * scrape = already on matching sold search; navigate = open sold URL then capture.
   * Typeahead never calls this — only the explicit Get solds control.
   */
  function planGetSolds(opts) {
    const o = opts || {};
    const q = String(o.query || "").trim();
    if (!q) return { action: "noop", reason: "no_query" };
    const href = o.href || "";
    const pageMode = o.pageMode;
    const info = typeof GV.soldSearchPage === "function" ? GV.soldSearchPage(href) : null;
    const onSold = pageMode === "sold" || Boolean(info);
    if (onSold) {
      const pageQ = String((info && info.query) || o.pageQuery || "").trim();
      if (!pageQ || pageQ.toLowerCase() === q.toLowerCase()) {
        return { action: "scrape", query: q };
      }
    }
    const url =
      typeof GV.soldUrl === "function" ? GV.soldUrl(q) : `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1`;
    return { action: "navigate", query: q, url };
  }

  function encodeGetSoldsPending(query, at) {
    const q = String(query || "").trim();
    if (!q) return null;
    return JSON.stringify({ q, at: at || Date.now() });
  }

  /**
   * Read + clear a pending Get solds flag if it matches the landing query and is fresh.
   * Returns the query string when capture should run; otherwise null.
   */
  function consumeGetSoldsPending(store, pageQuery, now, maxAgeMs) {
    if (!store || typeof store.getItem !== "function") return null;
    let raw;
    try {
      raw = store.getItem(GET_SOLDS_PENDING_KEY);
    } catch {
      return null;
    }
    if (!raw) return null;
    const clear = () => {
      try {
        store.removeItem(GET_SOLDS_PENDING_KEY);
      } catch {
        /* ignore */
      }
    };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      clear();
      return null;
    }
    const q = String(parsed?.q || "").trim();
    const at = Number(parsed?.at) || 0;
    const age = (now || Date.now()) - at;
    const maxAge = Number.isFinite(Number(maxAgeMs)) ? Number(maxAgeMs) : 60_000;
    const pageQ = String(pageQuery || "").trim();
    if (!q || age < 0 || age > maxAge) {
      clear();
      return null;
    }
    if (pageQ && pageQ.toLowerCase() !== q.toLowerCase()) {
      return null;
    }
    clear();
    return q;
  }

  function deskStatusLine(statusOrOpts) {
    const status =
      typeof statusOrOpts === "string" ? statusOrOpts : captureStatus(statusOrOpts || {});
    if (status === "cliffed") return DESK_EMPTY.cliff;
    if (status === "scraped") return DESK_EMPTY.scraped;
    return DESK_EMPTY.watching;
  }

  /** Fast-Cash empty / NO TAPE line under the price. */
  function deskNoTapeLine() {
    return DESK_EMPTY.noTape;
  }

  /**
   * Quiet tape sync badge copy from chrome.storage tapeSync.
   * Returns { kind: "ok"|"bad"|"idle", label, detail, banner? } — never throws.
   * Failures include a desk banner so a dead Postgres push is impossible to miss.
   */
  function formatTapeSync(sync, now) {
    const t = now || Date.now();
    if (!sync || typeof sync !== "object" || sync.at == null) {
      return { kind: "idle", label: "sync —", detail: "No Tape API push yet." };
    }
    const ageMs = Math.max(0, t - (Number(sync.at) || 0));
    const ageMin = Math.round(ageMs / 60000);
    const when = ageMin < 1 ? "just now" : ageMin === 1 ? "1m ago" : `${ageMin}m ago`;
    if (sync.ok) {
      return { kind: "ok", label: `sync OK · ${when}`, detail: `Last push ${when}.` };
    }
    const err = String(sync.error || sync.body || `HTTP ${sync.status || "?"}`).slice(0, 120);
    const detail = err || `Last push failed ${when}.`;
    return {
      kind: "bad",
      label: `SYNC FAIL · ${when}`,
      detail,
      banner: `SYNC FAIL — ${detail} Open Options → Tape.`,
    };
  }

  /** Focus Options on scratch for this query (cliff → inspector). */
  function optionsScratchFocus(query) {
    const q = String(query || "").trim();
    return { pullQuery: q, inspectScratch: "local", at: Date.now() };
  }

  /** Auto-capture preference: default ON (undefined/null/true). Explicit false disables. */
  function autoCaptureEnabled(value) {
    return value !== false;
  }

  /**
   * Pref off ⇒ no MutationObserver / location / boot auto-read.
   * Manual Scrape / GV_READ / hotkey still call read with mode "manual".
   */
  function shouldScheduleAutoRead(autoCapture) {
    return autoCaptureEnabled(autoCapture);
  }

  /**
   * Bucket a parked scratch listing for the inspector.
   * cliff / weak_title / active — never durable Fast-Cash.
   */
  function scratchBucket(row) {
    const flagsRaw = row && row.flags;
    const flags = Array.isArray(flagsRaw)
      ? flagsRaw
      : String(flagsRaw || "")
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean);
    const kind = row && row.kind;
    if (kind === "active" || (row && row.keep && !flags.includes("beyond_cliff"))) {
      return "active";
    }
    if (flags.includes("beyond_cliff") || row?.beyondCliff || row?.beyond_cliff) {
      return "cliff";
    }
    if (flags.includes("weak_title")) return "weak_title";
    return flags[0] || (row && row.reason) || "dropped";
  }

  /**
   * Last N scratch reasons for one query (newest first).
   * Accepts getScratch() shape { listings, entries } or a bare listings array.
   */
  function scratchReasons(scratch, opts) {
    const o = opts || {};
    const lim = Number.isFinite(Number(o.limit))
      ? Math.min(100, Math.max(1, Math.floor(Number(o.limit))))
      : 24;
    const money = o.money || GV.money;
    let listings = [];
    if (Array.isArray(scratch)) {
      listings = scratch;
    } else if (scratch && Array.isArray(scratch.entries) && scratch.entries.length) {
      // Newest scan entries first so the inspector shows recent cliff / drop reasons.
      listings = scratch.entries
        .slice()
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .flatMap((e) =>
          (e.listings || []).map((l) => ({
            ...l,
            at: l.at != null ? l.at : e.at,
            query: e.query || l.query,
          })),
        );
    } else if (scratch && Array.isArray(scratch.listings)) {
      listings = scratch.listings;
    }
    return listings.slice(0, lim).map((row) => {
      const bucket = row.bucket || scratchBucket(row);
      const price = row.price != null ? money(row.price) : "—";
      const reason = row.reason || (Array.isArray(row.flags) ? row.flags.join(" · ") : "") || bucket;
      return {
        bucket,
        reason,
        title: row.title || "",
        price: row.price != null ? Number(row.price) : null,
        priceLabel: price,
        kind: row.kind || null,
        flags: Array.isArray(row.flags) ? row.flags : [],
        at: row.at || null,
        id: row.id != null ? row.id : null,
        label: `${bucket}: ${row.title || "—"} · ${price}`,
      };
    });
  }

  GV.OVERLAY_HOST_ID = OVERLAY_HOST_ID;
  GV.findingsText = findingsText;
  GV.isInsideHost = isInsideHost;
  GV.pageChanged = pageChanged;
  GV.isOverlayToggleHotkey = isOverlayToggleHotkey;
  GV.preserveKeepToggles = preserveKeepToggles;
  GV.lastReadPayload = lastReadPayload;
  GV.formatLastRead = formatLastRead;
  GV.listedAsk = listedAsk;
  GV.mergeKeepIntoSoldTape = mergeKeepIntoSoldTape;
  GV.npmTapeCommand = npmTapeCommand;
  GV.rankCuts = rankCuts;
  GV.queueCopyText = queueCopyText;
  GV.captureStatus = captureStatus;
  GV.DESK_EMPTY = DESK_EMPTY;
  GV.GET_SOLDS_PENDING_KEY = GET_SOLDS_PENDING_KEY;
  GV.planGetSolds = planGetSolds;
  GV.encodeGetSoldsPending = encodeGetSoldsPending;
  GV.consumeGetSoldsPending = consumeGetSoldsPending;
  GV.deskStatusLine = deskStatusLine;
  GV.deskNoTapeLine = deskNoTapeLine;
  GV.formatTapeSync = formatTapeSync;
  GV.optionsScratchFocus = optionsScratchFocus;
  GV.autoCaptureEnabled = autoCaptureEnabled;
  GV.shouldScheduleAutoRead = shouldScheduleAutoRead;
  GV.scratchBucket = scratchBucket;
  GV.scratchReasons = scratchReasons;
})(typeof globalThis !== "undefined" ? globalThis : self);
