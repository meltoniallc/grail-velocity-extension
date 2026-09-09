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

function paint(list) {
  const ul = document.getElementById("cuts");
  ul.innerHTML = list
    .slice(0, 40)
    .map((i) => {
      const gap = (i.listPrice || 0) - (i.fastCash || 0);
      return `<li>
        <button class="row" type="button" data-q="${esc(i.title)}">
          <div>
            <div class="title">${esc(i.title)}</div>
            <div class="meta">${esc(i.id)} · ${i.confidence || "—"} · ${GV.money(i.listPrice)} → ${GV.money(i.fastCash)}</div>
          </div>
          <div class="gap">${GV.money(gap)}</div>
        </button>
      </li>`;
    })
    .join("");
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/"/g, """);
}

document.getElementById("cuts").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-q]");
  if (!btn) return;
  chrome.runtime.sendMessage({ type: "GV_SOLD", query: btn.getAttribute("data-q") });
});

document.getElementById("search").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = document.getElementById("q").value.trim();
  if (q.length < 2) {
    paint(rank(items));
    return;
  }
  const tok = GV.tokenize(q);
  const hits = items
    .map((item) => ({ item, score: GV.overlapScore(tok, `${item.title} ${item.player || ""}`) }))
    .filter((x) => x.score > 0.18)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
  paint(hits);
  chrome.runtime.sendMessage({ type: "GV_SOLD", query: q });
});

function rank(list) {
  return list
    .filter((i) => i.listPrice && i.fastCash)
    .sort((a, b) => b.listPrice - b.fastCash - (a.listPrice - a.fastCash));
}

catalog().then((data) => {
  items = data;
  paint(rank(items));
});
