/* Grail Velocity — shared catalog load + local-first typeahead. Classic script. */
(function (global) {
  const GV = global.GV;
  if (!GV) return;

  /** Refresh catalog.json cache after this age (overlay historically used 12h). */
  const CATALOG_MAX_AGE_MS = 1000 * 60 * 60 * 12;

  function chromeApi() {
    return typeof chrome !== "undefined" ? chrome : null;
  }

  /**
   * Load the operator book from chrome.storage, or fetch catalog.json and cache it.
   * Never opens sold tabs. opts:
   *   maxAgeMs — refetch when cache older (default 12h); Infinity keeps any cache
   *   storage  — chrome.storage.local-like { get, set }
   *   getURL   — chrome.runtime.getURL
   *   fetch    — fetch implementation (false ⇒ storage-only, no network)
   */
  async function loadCatalog(opts) {
    const o = opts || {};
    const api = chromeApi();
    const storage = o.storage || api?.storage?.local;
    const maxAge =
      o.maxAgeMs != null && Number.isFinite(Number(o.maxAgeMs))
        ? Math.max(0, Number(o.maxAgeMs))
        : o.maxAgeMs === Infinity
          ? Infinity
          : CATALOG_MAX_AGE_MS;
    const getURL =
      o.getURL ||
      (api?.runtime?.getURL ? (p) => api.runtime.getURL(p) : null);
    const doFetch = o.fetch === false ? null : o.fetch || global.fetch;

    if (storage?.get) {
      try {
        const cached = await storage.get(["catalog", "catalogAt"]);
        if (cached.catalog) {
          const age = Date.now() - (cached.catalogAt || 0);
          if (maxAge === Infinity || age < maxAge) return cached.catalog;
        }
      } catch {
        /* fall through to fetch */
      }
    }

    if (!doFetch || !getURL) return [];

    try {
      const res = await doFetch(getURL("catalog.json"));
      const data = await res.json();
      if (storage?.set) {
        try {
          await storage.set({ catalog: data, catalogAt: Date.now() });
        } catch {
          /* ignore cache write failures */
        }
      }
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  /**
   * Local-first typeahead used by popup, side panel, and overlay.
   * Prefer GV_SUGGEST (background: Chrome tape first, optional remote fill).
   * On messaging failure, fall back to in-page suggestTape so keystrokes
   * never open sold tabs or block on a dead worker.
   *
   * opts: catalog, tape, limit, sendMessage
   */
  async function suggestLocalFirst(q, opts) {
    const o = opts || {};
    const needle = String(q || "");
    const limit = Number.isFinite(Number(o.limit)) ? Math.max(1, Math.floor(Number(o.limit))) : 8;
    const catalog = o.catalog || [];
    const tape = o.tape || [];
    const api = chromeApi();
    const send =
      o.sendMessage ||
      (api?.runtime?.sendMessage
        ? (msg) => api.runtime.sendMessage(msg)
        : null);

    if (!needle.trim()) return [];

    if (send) {
      try {
        const res = await send({ type: "GV_SUGGEST", q: needle });
        if (res && Array.isArray(res.hits)) return res.hits;
      } catch {
        /* local suggestTape fallback */
      }
    }

    return GV.suggestTape(needle, { catalog, tape, limit });
  }

  GV.CATALOG_MAX_AGE_MS = CATALOG_MAX_AGE_MS;
  GV.loadCatalog = loadCatalog;
  GV.suggestLocalFirst = suggestLocalFirst;
})(typeof globalThis !== "undefined" ? globalThis : self);
