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

function pauseLines() {
  return document
    .getElementById("pause-list")
    .value.split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function load() {
  const data = await chrome.storage.local.get(["tapeApi", "tapeSecret", "captureSettings"]);
  document.getElementById("tapeApi").value = data.tapeApi || "http://127.0.0.1:8787";
  document.getElementById("tapeSecret").value = data.tapeSecret || "";
  const prefs = data.captureSettings || {};
  document.getElementById("capture-on").checked = prefs.captureEnabled !== false;
  document.getElementById("site-ebay").checked = !prefs.sites || prefs.sites.ebay !== false;
  const patterns = Array.isArray(prefs.pausePatterns) ? prefs.pausePatterns : globalThis.GVObserve.DEFAULT_PAUSE_PATTERNS;
  document.getElementById("pause-list").value = patterns.join("\n");
  document.getElementById("seller-secret").value = prefs.sellerHmacSecret || "";
  document.getElementById("own-seller").value = prefs.ownSellerId || "";
}

async function saveCapture() {
  return chrome.runtime.sendMessage({
    type: "GV_CAPTURE_SETTINGS",
    patch: {
      captureEnabled: document.getElementById("capture-on").checked,
      sites: { ebay: document.getElementById("site-ebay").checked },
      pausePatterns: pauseLines(),
      sellerHmacSecret: document.getElementById("seller-secret").value.trim(),
      ownSellerId: document.getElementById("own-seller").value.trim(),
    },
  });
}

async function save() {
  await chrome.storage.local.set({ tapeApi: apiUrl(), tapeSecret: secretValue() });
  await saveCapture();
}

document.getElementById("opts").addEventListener("submit", async (e) => {
  e.preventDefault();
  await save();
  setStatus("Saved. Reload eBay tabs if the API URL changed.", "ok");
});

document.getElementById("mint").addEventListener("click", async () => {
  document.getElementById("tapeSecret").value = mintSecret();
  await save();
  setStatus("New tape secret saved here. Copy the npm command and restart the server so both sides match.", "ok");
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
  setStatus("Copied. Run it in the grail-velocity folder, the one with package.json.", "ok");
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

load();
