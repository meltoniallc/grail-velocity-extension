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

function paint(list, label) {
  const ul = document.getElementById("cuts");
  const meta = document.getElementById("meta");
  const n = list.length;
  if (meta) {
    meta.textContent = n
      ? `${n} in queue${label ? " · " + label : ""}`
      : "No cuts match — widen search or refresh the book.";
  }

  if (!n) {
    ul.innerHTML = `<li class="empty">Nothing in the cut queue for this filter. Search the book or open sold tape from a title.</li>`;
    return;
  }

  ul.innerHTML = list
    .slice(0, 40)
    .map((i) => {
      const gap = (i.listPrice || 0) - (i.fastCash || 0);
      const q = i.query || i.title;
      return `<li>
        <button class="row" type="button" data-q="${esc(q)}">
          <div>
            <div class="title">${esc(i.title)}</div>
            <div class="meta">${esc(i.id || i.kind || "—")} · ${i.nKept ? i.nKept + " kept" : i.confidence || "—"} · ${GV.money(i.listPrice)} → ${GV.money(i.fastCash)}</div>
          </div>
          <div class="gap">${i.kind === "tape" ? GV.money(i.fastCash) : GV.money(gap)}</div>
        </button>
      </li>`;
    })
    .join("");
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/"/g, "\u0026quot;");
}

function rank(list) {
  return list
    .filter((i) => i.listPrice && i.fastCash)
    .sort((a, b) => b.listPrice - b.fastCash - (a.listPrice - a.fastCash));
}

async function paintLastRead() {
  const el = document.getElementById("last");
  if (!el) return;
  try {
    const { lastRead } = await chrome.storage.local.get("lastRead");
    if (!lastRead?.at) {
      el.textContent = "No tab read yet. On eBay: popup → Read this tab, or Alt+Shift+G.";
      return;
    }
    const age = Math.max(0, Math.round((Date.now() - lastRead.at) / 60000));
    const when = age < 1 ? "just now" : age === 1 ? "1m ago" : `${age}m ago`;
    el.textContent = `Last read ${when}: ${lastRead.query || "—"} · ${lastRead.kept}/${lastRead.n} kept · ${String(lastRead.action || "").replace("_", " ")}${lastRead.fastCash != null ? " · " + GV.money(lastRead.fastCash) : ""}`;
  } catch {
    el.textContent = "Could not load last read status.";
  }
}

let typeGen = 0;

async function onTyped() {
  const q = document.getElementById("q").value.trim();
  const gen = (typeGen += 1);
  if (q.length < 1) {
    paint(rank(items), "by gap");
    return;
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: "GV_SUGGEST", q });
    if (gen !== typeGen) return;
    if (res?.hits?.length) {
      paint(res.hits, "suggest");
      return;
    }
  } catch {
    /* book fallback */
  }
  if (gen !== typeGen) return;
  const tok = GV.tokenize(q);
  const hits = items
    .map((item) => ({ item, score: GV.overlapScore(tok, `${item.title} ${item.player || ""}`) }))
    .filter((x) => x.score > 0.18)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
  paint(hits, "search");
}

document.getElementById("cuts").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-q]");
  if (!btn) return;
  chrome.runtime.sendMessage({ type: "GV_SOLD", query: btn.getAttribute("data-q") });
});

document.getElementById("search").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = document.getElementById("q").value.trim();
  if (q.length < 2) return;
  chrome.runtime.sendMessage({ type: "GV_SOLD", query: q });
});

document.getElementById("q").addEventListener("input", () => {
  onTyped();
});

const copyQueueBtn = document.getElementById("copy-queue");
if (copyQueueBtn) {
  copyQueueBtn.addEventListener("click", async () => {
    const ranked = rank(items).slice(0, 40);
    if (!ranked.length) return;
    const text = ranked
      .map((i) => {
        const gap = (i.listPrice || 0) - (i.fastCash || 0);
        return `${i.id}\t${i.title}\t${GV.money(i.listPrice)}\t${GV.money(i.fastCash)}\t${GV.money(gap)}`;
      })
      .join("\n");
    const header = "id\ttitle\tlist\tfastCash\tgap\n";
    const meta = document.getElementById("meta");
    try {
      await navigator.clipboard.writeText(header + text);
      if (meta) meta.textContent = `Copied ${ranked.length} cuts to clipboard.`;
    } catch {
      if (meta) meta.textContent = "Clipboard blocked — copy failed.";
    }
  });
}

async function initPanel() {
  items = await catalog();
  paint(rank(items), "by gap");
  paintLastRead();
}

initPanel();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lastRead) paintLastRead();
});
