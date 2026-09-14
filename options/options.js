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
  const secret = secretValue();
  return secret ? `TAPE_SECRET=${secret} npm run tape` : "npm run tape";
}

async function load() {
  const data = await chrome.storage.local.get(["tapeApi", "tapeSecret"]);
  document.getElementById("tapeApi").value = data.tapeApi || "http://127.0.0.1:8787";
  document.getElementById("tapeSecret").value = data.tapeSecret || "";
}

async function save() {
  const tapeApi = apiUrl();
  const tapeSecret = secretValue();
  await chrome.storage.local.set({ tapeApi, tapeSecret });
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

load();
