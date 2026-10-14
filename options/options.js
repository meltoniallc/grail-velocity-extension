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

function mintSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function npmCommand() {
  return globalThis.GV.npmTapeCommand(secretValue());
}

async function load() {
  const data = await chrome.storage.local.get(["tapeApi", "tapeSecret", "autoCapture"]);
  document.getElementById("tapeApi").value = data.tapeApi || "http://127.0.0.1:8787";
  document.getElementById("tapeSecret").value = data.tapeSecret || "";
  document.getElementById("autoCapture").checked = globalThis.GV.autoCaptureEnabled(data.autoCapture);
}

async function save() {
  const tapeApi = apiUrl();
  const tapeSecret = secretValue();
  const autoCapture = document.getElementById("autoCapture").checked;
  await chrome.storage.local.set({ tapeApi, tapeSecret, autoCapture });
}

document.getElementById("opts").addEventListener("submit", async (e) => {
  e.preventDefault();
  await save();
  setStatus("Saved. Reload eBay tabs if the API URL changed.", "ok");
});

document.getElementById("mint").addEventListener("click", async () => {
  document.getElementById("tapeSecret").value = mintSecret();
  await save();
  setStatus("New secret saved here. Copy the npm command, stop the old server, and start it with that command so both sides match.", "ok");
});

document.getElementById("copySecret").addEventListener("click", async () => {
  const secret = secretValue();
  if (!secret) {
    setStatus("Mint a secret or paste the one from the npm run tape terminal.", "bad");
    return;
  }
  await navigator.clipboard.writeText(secret);
  await save();
  setStatus("Secret copied.", "ok");
});

document.getElementById("copyCmd").addEventListener("click", async () => {
  if (!secretValue()) document.getElementById("tapeSecret").value = mintSecret();
  await save();
  await navigator.clipboard.writeText(npmCommand());
  setStatus("Copied. In the grail-velocity folder (the one with package.json): paste that command. The server will print the same secret on boot.", "ok");
});

document.getElementById("check").addEventListener("click", async () => {
  await save();
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
  await save();
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
  await save();
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

load();
