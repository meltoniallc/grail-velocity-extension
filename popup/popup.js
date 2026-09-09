const GV = globalThis.GV;

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

function renderCuts(items) {
  const high = items
    .filter((i) => i.confidence === "High" && i.listPrice && i.fastCash)
    .sort((a, b) => b.listPrice - b.fastCash - (a.listPrice - a.fastCash))
    .slice(0, 17);
  const ul = document.getElementById("cuts");
  ul.innerHTML = high
    .map((i) => {
      const gap = i.listPrice - i.fastCash;
      return `<li>
        <button class="row" type="button" data-q="${esc(soldQuery(i.title))}">
          <div>
            <div class="title">${esc(i.title)}</div>
            <div class="meta">${esc(i.id)} · ${money(i.listPrice)} → ${money(i.fastCash)}</div>
          </div>
          <div class="gap">${money(gap)}</div>
        </button>
      </li>`;
    })
    .join("");
  ul.onclick = (e) => {
    const btn = e.target.closest("[data-q]");
    if (!btn) return;
    chrome.runtime.sendMessage({ type: "GV_SOLD", query: btn.getAttribute("data-q") });
  };
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

document.getElementById("search").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = document.getElementById("q").value.trim();
  if (q.length < 3) return;
  chrome.runtime.sendMessage({ type: "GV_SOLD", query: q });
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

catalog().then(renderCuts);
