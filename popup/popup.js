const GV = globalThis.GV;
let items = [];

async function catalog() {
  const cached = await chrome.storage.local.get("catalog");
  if (cached.catalog) return cached.catalog;
  const res = await fetch(chrome.runtime.getURL("catalog.json"));
  const data = await res.json();
  await chrome.storage.local.set({ catalog: data, catalogAt: Date.now() });
  return data;
}

function money(n) {
  return GV.money(n);
}

function renderCuts(list) {
  const high = list
    .filter((i) => i.confidence === "High" && i.listPrice && i.fastCash)
    .sort((a, b) => b.listPrice - b.fastCash - (a.listPrice - a.fastCash))
    .slice(0, 17);
  paintRows(high, "High-conf cuts");
}

function paintRows(list, label) {
  document.getElementById("sec").textContent = label;
  const ul = document.getElementById("cuts");
  ul.innerHTML = list
    .map((i) => {
      const gap = (i.listPrice || 0) - (i.fastCash || 0);
      return `<li>
        <button class="row" type="button" data-q="${esc(i.query || soldQuery(i.title))}">
          <div>
            <div class="title">${esc(i.title)}</div>
            <div class="meta">${esc(i.id || i.kind || "tape")} · ${money(i.listPrice)} → ${money(i.fastCash)}</div>
          </div>
          <div class="gap">${i.kind === "tape" ? money(i.fastCash) : money(gap)}</div>
        </button>
      </li>`;
    })
    .join("");
}

function paintSuggest(hits) {
  const ul = document.getElementById("suggest");
  if (!hits.length) {
    ul.hidden = true;
    ul.innerHTML = "";
    return;
  }
  ul.hidden = false;
  ul.innerHTML = hits
    .map(
      (hit) => `<li>
        <button class="row" type="button" data-q="${esc(hit.query || hit.title)}">
          <div>
            <div class="title">${esc(hit.title)}</div>
            <div class="meta">${esc(hit.kind || hit.status || "comp")} · ${hit.nKept ? hit.nKept + " kept" : hit.soldDate || hit.pageType || "book"}</div>
          </div>
          <div class="gap">${money(hit.fastCash ?? hit.price)}</div>
        </button>
      </li>`,
    )
    .join("");
}

function soldQuery(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .replace(/SEALED/gi, "")
    .trim();
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function paintCapture(status) {
  if (!status) return;
  document.getElementById("today").textContent = String(status.today || 0);
  document.getElementById("queue").textContent = String(status.queue || 0);
  document.getElementById("capture-on").checked = status.captureEnabled !== false;
  document.getElementById("site-ebay").checked = !status.sites || status.sites.ebay !== false;
  const server = document.getElementById("server");
  const sync = status.server;
  server.className = "";
  if (!sync) server.textContent = "Local";
  else if (sync.ok) {
    server.textContent = "Server up";
    server.className = "ok";
  } else if (sync.error === "no-api") server.textContent = "Local queue";
  else {
    server.textContent = "Server down";
    server.className = "bad";
  }
  const last = document.getElementById("last");
  if (status.last) last.textContent = `Last ${status.last.title} · ${money(status.last.price)}`;
  else last.textContent = "No capture yet";
  const note = document.getElementById("capture-note");
  if (status.capturePausedUntil && Date.now() < status.capturePausedUntil) {
    note.textContent = `Paused until ${new Date(status.capturePausedUntil).toLocaleTimeString()}`;
  } else if (status.captureEnabled === false) note.textContent = "Capture is off.";
  else note.textContent = "Pages you open. No crawling.";
}

async function sendPatch(patch) {
  const res = await chrome.runtime.sendMessage({ type: "GV_CAPTURE_SETTINGS", patch });
  paintCapture(res);
}

let typeGen = 0;

async function onTyped() {
  const q = document.getElementById("q").value;
  const gen = (typeGen += 1);
  if (!q.trim()) {
    paintSuggest([]);
    renderCuts(items);
    return;
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: "GV_SUGGEST", q });
    if (gen !== typeGen) return;
    paintSuggest(res?.hits || []);
  } catch {
    if (gen !== typeGen) return;
    paintSuggest(GV.suggestTape(q, { catalog: items, tape: [], limit: 8 }));
  }
}

document.getElementById("search").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = document.getElementById("q").value.trim();
  if (q.length < 3) return;
  chrome.runtime.sendMessage({ type: "GV_SOLD", query: q });
});

document.getElementById("q").addEventListener("input", () => {
  onTyped();
});

document.getElementById("lookup").addEventListener("click", async () => {
  const q = document.getElementById("q").value.trim();
  const note = document.getElementById("capture-note");
  if (q.length < 2) {
    note.textContent = "Type at least two characters, then Lookup.";
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: "GV_COMP_LOOKUP", q });
  const hits = res?.hits || [];
  paintSuggest(hits);
  note.textContent = hits.length ? `${hits.length} comp hit${hits.length === 1 ? "" : "s"}.` : "No comp on the local queue or tape server.";
});

document.getElementById("suggest").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-q]");
  if (!btn) return;
  chrome.runtime.sendMessage({ type: "GV_SOLD", query: btn.getAttribute("data-q") });
});

document.getElementById("cuts").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-q]");
  if (!btn) return;
  chrome.runtime.sendMessage({ type: "GV_SOLD", query: btn.getAttribute("data-q") });
});

document.getElementById("read").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "GV_READ" });
  window.close();
});

document.getElementById("panel").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && chrome.sidePanel) await chrome.sidePanel.open({ tabId: tab.id });
  window.close();
});

document.getElementById("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("capture-on").addEventListener("change", (e) => {
  sendPatch({ captureEnabled: e.target.checked });
});

document.getElementById("site-ebay").addEventListener("change", (e) => {
  sendPatch({ sites: { ebay: e.target.checked } });
});

document.getElementById("pause-1h").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "GV_CAPTURE_PAUSE", ms: 60 * 60 * 1000 });
  paintCapture(res);
});

async function initPopup() {
  items = await catalog();
  renderCuts(items);
  try {
    paintCapture(await chrome.runtime.sendMessage({ type: "GV_CAPTURE_STATUS" }));
  } catch {
    /* popup still searches tape without the capture worker */
  }
}

initPopup();
