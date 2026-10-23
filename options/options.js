function apiUrl() {
  return document.getElementById("tapeApi").value.trim().replace(/\/+$/, "");
}

function secretValue() {
  return document.getElementById("tapeSecret").value.trim();
}

function setStatus(text, kind) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = kind || "";
}

function paintSync(sync) {
  const el = document.getElementById("syncStatus");
  if (!el || !globalThis.GV?.formatTapeSync) return;
  const info = globalThis.GV.formatTapeSync(sync);
  el.textContent =
    info.kind === "idle"
      ? "Last push: — (sync status appears after a Tape API write)"
      : `Last push: ${info.label}${info.kind === "bad" && info.detail ? " — " + info.detail : ""}`;
  el.className = `help sync ${info.kind}`;
}

async function applyOptionsFocus(focus) {
  if (!focus || typeof focus !== "object") return;
  const q = String(focus.pullQuery || "").trim();
  if (q) document.getElementById("pullQuery").value = q;
  await chrome.storage.local.remove("optionsFocus");
  const tools = document.querySelector("details.tools");
  if (tools && (focus.inspectScratch || q)) tools.open = true;
  if (focus.inspectScratch && q) {
    await inspectScratch(focus.inspectScratch === "remote");
  } else if (q) {
    setStatus("Query ready — Pull from server or Inspect scratch.", "ok");
  }
}

async function load() {
  const presets = globalThis.GV.tapeApiPresets();
  const data = await chrome.storage.local.get([
    "tapeApi",
    "tapeSecret",
    "autoCapture",
    "tapeSync",
    "optionsFocus",
  ]);
  document.getElementById("tapeApi").value = data.tapeApi || presets.railway;
  document.getElementById("tapeSecret").value = data.tapeSecret || "";
  document.getElementById("autoCapture").checked = globalThis.GV.autoCaptureEnabled(data.autoCapture);
  paintSync(data.tapeSync);
  try {
    const ver = chrome.runtime.getManifest().version;
    const el = document.getElementById("ext-ver");
    if (el && ver) el.textContent = ver;
  } catch {
    /* options still works offline of manifest */
  }
  await applyOptionsFocus(data.optionsFocus);
}

async function applyPreset(kind) {
  const presets = globalThis.GV.tapeApiPresets();
  const url = kind === "local" ? presets.local : presets.railway;
  document.getElementById("tapeApi").value = url;
  document.getElementById("tapeSecret").focus();
  if (!(await save())) return;
  setStatus(
    kind === "local"
      ? "Local Tape URL saved. Paste the secret from npm run tape, then Check connection."
      : "Railway Tape URL saved. Paste TAPE_SECRET from Railway → tape service, then Check connection.",
    "ok",
  );
}

/**
 * Desk Options exposes one capture control. Keep eBay on and captureEnabled
 * aligned with auto-capture so gate() and overlay schedule stay in sync.
 * Advanced capture prefs stay in storage/code defaults — Options does not edit them.
 */
async function saveCaptureAligned(autoCapture) {
  return chrome.runtime.sendMessage({
    type: "GV_CAPTURE_SETTINGS",
    patch: {
      captureEnabled: autoCapture !== false,
      sites: { ebay: true },
    },
  });
}

async function save() {
  const tapeApi = apiUrl();
  if (tapeApi && !globalThis.GV.tapeApiAllowed(tapeApi)) {
    const presets = globalThis.GV.tapeApiPresets();
    setStatus(`Tape URL must be ${presets.local} or ${presets.railway}.`, "bad");
    return false;
  }
  const tapeSecret = secretValue();
  const autoCapture = document.getElementById("autoCapture").checked;
  await chrome.storage.local.set({ tapeApi, tapeSecret, autoCapture });
  await saveCaptureAligned(autoCapture);
  return true;
}

document.getElementById("opts").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!(await save())) return;
  setStatus("Saved. Reload eBay tabs if the Tape URL changed.", "ok");
});

document.getElementById("presetRailway").addEventListener("click", () => applyPreset("railway"));
document.getElementById("presetLocal").addEventListener("click", () => applyPreset("local"));

document.getElementById("check").addEventListener("click", async () => {
  if (!(await save())) return;
  setStatus("Checking…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "GV_TAPE_PING" });
    if (res?.ok) {
      setStatus(
        res.postgres
          ? "Connected. Verified solds will persist in Postgres."
          : "Connected. No DATABASE_URL, so verified solds stay in the extension; junk still parks in SQLite.",
        "ok",
      );
      return;
    }
    setStatus(res?.error || "Could not reach the tape API.", "bad");
  } catch (err) {
    setStatus(String(err.message || err), "bad");
  }
});

document.getElementById("pull").addEventListener("click", async () => {
  if (!(await save())) return;
  const query = document.getElementById("pullQuery").value.trim();
  if (!query) {
    setStatus("Enter a query to pull (one query_norm from Postgres).", "bad");
    return;
  }
  setStatus("Pulling verified solds…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "GV_TAPE_PULL", query });
    if (!res?.ok) {
      setStatus(res?.error || "Pull failed.", "bad");
      return;
    }
    if (!res.hydrated) {
      setStatus(
        res.source === "none"
          ? "Tape API has no Postgres (DATABASE_URL). Nothing to hydrate."
          : "No verified solds on the server for that query.",
        "bad",
      );
      return;
    }
    setStatus(
      `Hydrated ${res.nComps} verified sold comp${res.nComps === 1 ? "" : "s"} into local tape. Scratch was not imported.`,
      "ok",
    );
  } catch (err) {
    setStatus(String(err.message || err), "bad");
  }
});

const SCRATCH_LIMIT = 24;

function paintScratchReasons(reasons, emptyText) {
  const ul = document.getElementById("scratchList");
  if (!ul) return;
  const list = reasons || [];
  if (!list.length) {
    ul.innerHTML = `<li class="empty">${emptyText || "No scratch for this query."}</li>`;
    return;
  }
  ul.innerHTML = list
    .map((r) => {
      const bucket = String(r.bucket || "dropped");
      const title = String(r.title || "—")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/"/g, "&quot;");
      const reason = String(r.reason || bucket)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;");
      const price = r.priceLabel || (r.price != null ? globalThis.GV.money(r.price) : "—");
      return `<li><span class="bucket ${bucket}">${bucket}</span> ${title}<br /><span style="color:var(--subtle)">${reason} · ${price}</span></li>`;
    })
    .join("");
}

async function inspectScratch(remote) {
  if (!(await save())) return;
  const query = document.getElementById("pullQuery").value.trim();
  if (!query) {
    setStatus("Enter a query to inspect scratch.", "bad");
    paintScratchReasons([], "Enter a query first.");
    return;
  }
  setStatus(remote ? "Reading server scratch…" : "Reading local scratch…");
  try {
    const res = await chrome.runtime.sendMessage({
      type: remote ? "GV_SCRATCH_REMOTE" : "GV_SCRATCH_GET",
      query,
      limit: SCRATCH_LIMIT,
    });
    if (!res?.ok) {
      setStatus(res?.error || "Scratch inspect failed.", "bad");
      paintScratchReasons([], "Could not load scratch.");
      return;
    }
    const payload = remote ? res.listings || [] : res;
    const reasons = globalThis.GV.scratchReasons(payload, { limit: SCRATCH_LIMIT });
    paintScratchReasons(
      reasons,
      remote ? "No SQLite scratch for this query (or TTL expired)." : "No local scratch for this query.",
    );
    const n = reasons.length;
    setStatus(
      n
        ? `${n} scratch reason${n === 1 ? "" : "s"} (${res.source || (remote ? "sqlite" : "local")}). Scratch never feeds Fast-Cash.`
        : remote
          ? "No server scratch for that query."
          : "No local scratch for that query.",
      n ? "ok" : "bad",
    );
  } catch (err) {
    setStatus(String(err.message || err), "bad");
    paintScratchReasons([], "Could not load scratch.");
  }
}

document.getElementById("scratchLocal").addEventListener("click", () => inspectScratch(false));
document.getElementById("scratchRemote").addEventListener("click", () => inspectScratch(true));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tapeSync) paintSync(changes.tapeSync.newValue);
});

load();
