importScripts(
  "lib/core.js",
  "lib/tape.js",
  "lib/cardfields.js",
  "lib/observe.js",
  "lib/outbox.js",
  "lib/capture-runtime.js",
);

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
      const hits = await store().suggest(msg.q || "", { catalog: await catalog(), limit: 8 });
      sendResponse({ hits });
    })();
    return true;
  }
  if (msg?.type === "GV_TAPE_GET") {
    (async () => {
      const snapshot = await store().getSnapshot(msg.query || "");
      sendResponse({ snapshot });
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

let captureRuntimePromise;

function captureRuntime() {
  if (!captureRuntimePromise) {
    captureRuntimePromise = Promise.resolve(globalThis.GVOutbox.createIdbOutbox()).then((outbox) =>
      globalThis.GVCaptureRuntime.createCaptureRuntime({
        storage: {
          get: (keys) => chrome.storage.local.get(keys),
          set: (values) => chrome.storage.local.set(values),
        },
        outbox,
        now: () => Date.now(),
        setBadge: async (text) => {
          await chrome.action.setBadgeText({ text });
          await chrome.action.setBadgeBackgroundColor({ color: "#d4af37" });
          if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#050505" });
        },
        postObserve: async (rows) => {
          const settings = await chrome.storage.local.get(["tapeApi", "tapeSecret"]);
          const endpoint = String(settings.tapeApi || "").replace(/\/+$/, "");
          if (!endpoint) return { ok: false, error: "no-api" };
          const headers = { "Content-Type": "application/json" };
          if (settings.tapeSecret) headers["X-Tape-Secret"] = String(settings.tapeSecret);
          const res = await fetch(`${endpoint}/observe`, {
            method: "POST",
            headers,
            body: JSON.stringify({ observations: rows }),
          });
          if (!res.ok) return { ok: false, status: res.status, error: `status ${res.status}` };
          return { ok: true, status: res.status };
        },
        searchObserved: async (q) => {
          const settings = await chrome.storage.local.get(["tapeApi", "tapeSecret"]);
          const endpoint = String(settings.tapeApi || "").replace(/\/+$/, "");
          if (!endpoint) return [];
          const headers = {};
          if (settings.tapeSecret) headers["X-Tape-Secret"] = String(settings.tapeSecret);
          const res = await fetch(`${endpoint}/comps?q=${encodeURIComponent(q)}`, { headers });
          if (!res.ok) return [];
          const body = await res.json();
          return Array.isArray(body.hits) ? body.hits : [];
        },
      }),
    );
  }
  return captureRuntimePromise;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "GV_OBSERVE") {
    (async () => {
      try {
        const runtime = await captureRuntime();
        sendResponse(await runtime.onObserve(msg.pageUrl, msg.observations));
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
    })();
    return true;
  }
  if (msg?.type === "GV_CAPTURE_STATUS") {
    (async () => {
      const runtime = await captureRuntime();
      sendResponse(await runtime.status());
    })();
    return true;
  }
  if (msg?.type === "GV_CAPTURE_SETTINGS") {
    (async () => {
      const runtime = await captureRuntime();
      await runtime.update(msg.patch || {});
      sendResponse(await runtime.status());
    })();
    return true;
  }
  if (msg?.type === "GV_CAPTURE_PAUSE") {
    (async () => {
      const runtime = await captureRuntime();
      await runtime.pauseFor(msg.ms || 60 * 60 * 1000);
      sendResponse(await runtime.status());
    })();
    return true;
  }
  if (msg?.type === "GV_CAPTURE_FLUSH") {
    (async () => {
      const runtime = await captureRuntime();
      sendResponse(await runtime.flush());
    })();
    return true;
  }
  if (msg?.type === "GV_COMP_LOOKUP") {
    (async () => {
      const runtime = await captureRuntime();
      sendResponse({ hits: await runtime.lookup(msg.q || "") });
    })();
    return true;
  }
  return false;
});

if (chrome.alarms) {
  chrome.alarms.create("gv-observe-flush", { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "gv-observe-flush") return;
    captureRuntime()
      .then((runtime) => runtime.flush())
      .catch(() => {});
  });
}
