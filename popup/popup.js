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
            <div class="meta">${esc(hit.kind)} · ${hit.nKept ? hit.nKept + " kept" : "book"}</div>
          </div>
          <div class="gap">${money(hit.fastCash)}</div>
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
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/"/g, "\u0026quot;");
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
  if (tab?.id && chrome.sidePanel) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
  window.close();
});

async function initPopup() {
  items = await catalog();
  renderCuts(items);
}

initPopup();
