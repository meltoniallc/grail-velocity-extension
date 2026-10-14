importScripts("lib/core.js", "lib/tape.js");

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
});

function chromeAdapter() {
  return {
    async load() {
      const data = await chrome.storage.local.get(["tapeSnapshots", "tapeScratch"]);
      return { snapshots: data.tapeSnapshots || [], scratch: data.tapeScratch || [] };
    },
    async saveSnapshots(snapshots) {
      await chrome.storage.local.set({ tapeSnapshots: snapshots });
    },
    async saveScratch(scratch) {
      await chrome.storage.local.set({ tapeScratch: scratch });
    },
    async pushRemote(payload) {
      const settings = await chrome.storage.local.get(["tapeApi", "tapeSecret"]);
      const endpoint = String(settings.tapeApi || "").replace(/\/+$/, "");
      if (!endpoint) return { ok: true, skipped: "no-api" };
      const headers = { "Content-Type": "application/json" };
      if (settings.tapeSecret) headers["X-Tape-Secret"] = String(settings.tapeSecret);
      try {
        const res = await fetch(`${endpoint}/tape`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
        const body = await res.text();
        await chrome.storage.local.set({
          tapeSync: { ok: res.ok, status: res.status, at: Date.now(), body: body.slice(0, 240) },
        });
        return { ok: res.ok, status: res.status };
      } catch (err) {
        await chrome.storage.local.set({
          tapeSync: { ok: false, error: String(err.message || err), at: Date.now() },
        });
        return { ok: false, error: String(err.message || err) };
      }
    },
  };
}

function store() {
  return globalThis.GVTape.create(chromeAdapter());
}

async function catalog() {
  const cached = await chrome.storage.local.get("catalog");
  return cached.catalog || [];
}

async function tapeEndpoint() {
  const settings = await chrome.storage.local.get(["tapeApi", "tapeSecret"]);
  const endpoint = String(settings.tapeApi || "").replace(/\/+$/, "");
  if (!endpoint) return null;
  const headers = {};
  if (settings.tapeSecret) headers["X-Tape-Secret"] = String(settings.tapeSecret);
  return { endpoint, headers };
}

/** Optional GET /suggest when local Chrome tape is miss/thin. Tape hits only; never opens sold tabs. */
async function fetchRemoteSuggest(q, limit) {
  const cfg = await tapeEndpoint();
  if (!cfg) return [];
  try {
    const url = `${cfg.endpoint}/suggest?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(limit))}`;
    const res = await fetch(url, { headers: cfg.headers });
    if (!res.ok) return [];
    const body = await res.json().catch(() => ({}));
    const hits = Array.isArray(body.hits) ? body.hits : [];
    return hits.filter((h) => h && h.kind === "tape");
  } catch {
    return [];
  }
}

async function suggestWithRemoteFallback(q, limit) {
  const needle = String(q || "").trim();
  const localHits = await store().suggest(needle, { catalog: await catalog(), limit });
  if (!needle || !globalThis.GV.localTapeThin(localHits)) return localHits;
  const remoteHits = await fetchRemoteSuggest(needle, limit);
  if (!remoteHits.length) return localHits;
  return globalThis.GV.mergeSuggestHits(localHits, remoteHits, { limit });
}

/** Optional GET /tape?q= — verified solds only; never scratch. */
async function fetchRemoteTape(q) {
  const cfg = await tapeEndpoint();
  if (!cfg) return null;
  const needle = String(q || "").trim();
  if (!needle) return null;
  try {
    const url = `${cfg.endpoint}/tape?q=${encodeURIComponent(needle)}`;
    const res = await fetch(url, { headers: cfg.headers });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body || body.ok === false) return null;
    return {
      source: body.source || "postgres",
      snapshot: body.snapshot || null,
      verifiedPrices: Array.isArray(body.verifiedPrices) ? body.verifiedPrices : [],
    };
  } catch {
    return null;
  }
}

/**
 * Cold-start / Options pull: hydrate Chrome tapeSnapshots from Postgres.
 * Local durable comps win; scratch is never imported; write path unchanged.
 */
async function pullAndHydrate(q) {
  const remote = await fetchRemoteTape(q);
  if (!remote) return { ok: false, error: "No Tape API response (is the server running?)." };
  if (!remote.snapshot && !(remote.verifiedPrices || []).length) {
    return { ok: true, snapshot: null, hydrated: false, source: remote.source };
  }
  const snapshot = await store().hydrateFromRemote(remote);
  return {
    ok: true,
    snapshot,
    hydrated: Boolean(snapshot),
    source: remote.source,
    nComps: snapshot ? (snapshot.comps || []).length : 0,
  };
}

async function getSnapshotWithColdHydrate(q) {
  const needle = String(q || "").trim();
  let snapshot = await store().getSnapshot(needle);
  if (snapshot && (snapshot.comps || []).length) return snapshot;
  if (!needle) return snapshot;
  const pulled = await pullAndHydrate(needle);
  if (pulled.hydrated && pulled.snapshot) return pulled.snapshot;
  return snapshot;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "GV_OPEN_SIDEPANEL" && sender.tab?.id != null) {
    (async () => {
      try {
        await chrome.sidePanel.open({ tabId: sender.tab.id });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }
  if (msg?.type === "GV_SOLD" && msg.query) {
    chrome.tabs.create({ url: globalThis.GV.soldUrl(msg.query) });
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "GV_SUGGEST") {
    (async () => {
      const hits = await suggestWithRemoteFallback(msg.q || "", 8);
      sendResponse({ hits });
    })();
    return true;
  }
  if (msg?.type === "GV_TAPE_GET") {
    (async () => {
      // Cold local tape: optional Postgres hydrate (verified solds only).
      const snapshot = await getSnapshotWithColdHydrate(msg.query || "");
      sendResponse({ snapshot });
    })();
    return true;
  }
  if (msg?.type === "GV_TAPE_PULL") {
    (async () => {
      try {
        const result = await pullAndHydrate(msg.query || "");
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
    })();
    return true;
  }
  if (msg?.type === "GV_TAPE_PUT") {
    (async () => {
      const snapshot = await store().putScan({
        query: msg.query,
        verified: msg.verified,
        velocity: msg.velocity,
        url: msg.url,
        mode: msg.mode,
        pageMode: msg.pageMode,
        stoppedAt: msg.stoppedAt,
        nCliff: msg.nCliff,
      });
      sendResponse({ snapshot });
    })();
    return true;
  }
  if (msg?.type === "GV_TAPE_PING") {
    (async () => {
      const settings = await chrome.storage.local.get(["tapeApi", "tapeSecret"]);
      const endpoint = String(settings.tapeApi || "").replace(/\/+$/, "");
      if (!endpoint) {
        sendResponse({ ok: false, error: "Set Tape API first. Default is http://127.0.0.1:8787." });
        return;
      }
      try {
        const healthRes = await fetch(`${endpoint}/health`);
        const health = await healthRes.json().catch(() => ({}));
        if (!healthRes.ok || !health.ok) {
          sendResponse({ ok: false, error: "Tape API answered but is not healthy." });
          return;
        }
        const headers = {};
        if (settings.tapeSecret) headers["X-Tape-Secret"] = String(settings.tapeSecret);
        const pingRes = await fetch(`${endpoint}/ping`, { headers });
        if (pingRes.status === 401) {
          sendResponse({
            ok: false,
            error: "Secret does not match. Copy the value printed in the npm run tape terminal, paste it here, Save, then check again.",
          });
          return;
        }
        if (!pingRes.ok) {
          sendResponse({ ok: false, error: `Tape API returned ${pingRes.status}.` });
          return;
        }
        const ping = await pingRes.json().catch(() => ({}));
        sendResponse({ ok: true, postgres: Boolean(ping.postgres) });
      } catch {
        sendResponse({
          ok: false,
          error: "Tape API is not running. In the grail-velocity folder (package.json is there): npm run tape",
        });
      }
    })();
    return true;
  }
  return false;
});
