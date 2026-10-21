const GV = globalThis.GV;
let items = [];

function paint(list, label) {
  const ul = document.getElementById("cuts");
  const meta = document.getElementById("meta");
  const n = list.length;
  if (meta) {
    meta.textContent = n
      ? `${n} in queue${label ? " · " + label : ""}`
      : "No cuts match — widen search or refresh the catalog.";
  }

  if (!n) {
    ul.innerHTML = `<li class="empty">Nothing in the cut queue. Type for instant tape, or open solds from a title. Fast-Cash stays sold tape only.</li>`;
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
  return GV.rankCuts(list);
}

async function paintLastRead() {
  const el = document.getElementById("last");
  if (!el) return;
  try {
    const { lastRead } = await chrome.storage.local.get("lastRead");
    el.textContent = GV.formatLastRead(lastRead, Date.now());
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
  const hits = await GV.suggestLocalFirst(q, { catalog: items, tape: [], limit: 8 });
  if (gen !== typeGen) return;
  if (hits.length) {
    paint(hits, "suggest");
    return;
  }
  const tok = GV.tokenize(q);
  const bookHits = items
    .map((item) => ({ item, score: GV.overlapScore(tok, `${item.title} ${item.player || ""}`) }))
    .filter((x) => x.score > 0.18)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
  paint(bookHits, "search");
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
    const text = GV.queueCopyText(items);
    if (!text) return;
    const ranked = GV.rankCuts(items).slice(0, 40);
    const meta = document.getElementById("meta");
    try {
      await navigator.clipboard.writeText(text);
      if (meta) meta.textContent = `Copied ${ranked.length} cuts to clipboard.`;
    } catch {
      if (meta) meta.textContent = "Clipboard blocked — copy failed.";
    }
  });
}

async function initPanel() {
  items = await GV.loadCatalog();
  paint(rank(items), "by gap");
  paintLastRead();
}

initPanel();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lastRead) paintLastRead();
});
