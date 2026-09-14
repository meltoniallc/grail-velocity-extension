(async () => {
  const GV = globalThis.GV;
  if (!GV) return;

  const HOST_ID = "grail-velocity-root";
  let catalog = [];
  let verified = [];
  let scanMeta = { stoppedAt: null, nCliff: 0, nRaw: 0, nKept: 0 };
  let velocity = null;
  let sku = null;
  let query = "";
  let applied = null;
  let open = true;
  let showDropped = false;
  let suggests = [];
  let typeQuery = "";
  let typeGen = 0;

  function cssUrl() {
    return chrome.runtime.getURL("content/overlay.css");
  }

  async function loadCatalog() {
    try {
      const cached = await chrome.storage.local.get(["catalog", "catalogAt"]);
      if (cached.catalog && Date.now() - (cached.catalogAt || 0) < 1000 * 60 * 60 * 12) {
        catalog = cached.catalog;
        return;
      }
    } catch {
      /* ignore */
    }
    try {
      const res = await fetch(chrome.runtime.getURL("catalog.json"));
      catalog = await res.json();
      await chrome.storage.local.set({ catalog, catalogAt: Date.now() });
    } catch {
      catalog = [];
    }
  }

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host) return host;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "all:initial;position:fixed;top:0;right:0;z-index:2147483646;width:360px;height:100vh;max-width:100vw;box-shadow:-8px 0 24px rgba(0,0,0,.35);";
    const shadow = host.attachShadow({ mode: "open" });
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = cssUrl();
    shadow.appendChild(link);
    const wrap = document.createElement("div");
    wrap.className = "gv";
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);
    return host;
  }

  function matchPct(score) {
    return `${Math.round((score || 0) * 100)}%`;
  }

  function render() {
    const host = ensureHost();
    host.style.display = open ? "block" : "none";
    const wrap = host.shadowRoot.querySelector(".gv");
    const fast = velocity?.fastCashPrice ?? sku?.fastCash ?? null;
    const listed = sku?.listPrice ?? null;
    const gap = listed != null && fast != null ? listed - fast : null;
    const action = (velocity?.action || "QUARANTINE").toLowerCase();
    const kept = verified.filter((v) => v.keep);
    const visible = showDropped ? verified : kept;
    const avg =
      kept.length > 0 ? kept.reduce((s, r) => s + (r.matchScore || 0), 0) / kept.length : 0;
    wrap.innerHTML = `
      <div class="gv-head">
        <div>
          <p class="gv-kicker">Grail Velocity</p>
          <p class="gv-title">High-match tape</p>
        </div>
        <button class="gv-x" type="button" data-act="close" aria-label="Hide">×</button>
      </div>
      <div class="gv-body">
        <form class="gv-type" data-act="type-form">
          <input id="gv-q" type="search" placeholder="Type a card — tape answers as you go" value="${esc(typeQuery)}" autocomplete="off" />
        </form>
        ${
          suggests.length
            ? `<ul class="gv-suggest">${suggests
                .map(
                  (hit) => `<li>
                    <button type="button" data-act="hit" data-q="${esc(hit.query || hit.title)}" data-kind="${esc(hit.kind)}">
                      <span>${esc(hit.title)}</span>
                      <span class="gv-price">${hit.kind === "tape" ? GV.money(hit.fastCash) : "book"}</span>
                    </button>
                  </li>`,
                )
                .join("")}</ul>`
            : ""
        }
        <p class="gv-q">${esc(query || "No query on this page")}</p>
        ${
          sku
            ? `<div class="gv-sku">
                ${sku.image ? `<img src="${esc(sku.image)}" alt="">` : `<div class="gv-ph"></div>`}
                <div>
                  <div class="gv-id">${esc(sku.id)}${sku.confidence ? " · " + esc(sku.confidence) : ""}</div>
                  <p>${esc(sku.title)}</p>
                </div>
              </div>`
            : `<div class="gv-sku"><div class="gv-ph"></div><p>No book match. Tape still prices the query.</p></div>`
        }
        <div class="gv-card">
          <div class="gv-row">
            <span class="gv-badge ${esc(action)}">${esc((velocity?.action || "QUARANTINE").replace("_", " "))}</span>
            <span class="gv-id">${kept.length} kept · ${matchPct(avg)} match</span>
          </div>
          ${
            scanMeta.nCliff
              ? `<p class="gv-note gv-cliff">Stopped at row ${scanMeta.stoppedAt + 1}. ${scanMeta.nCliff} titles no longer matched — noise parked, not priced.</p>`
              : ""
          }
          <p class="gv-kicker" style="margin-top:12px">Fast-Cash</p>
          <p class="gv-fast">${GV.money(fast)}</p>
          <dl class="gv-dl">
            <div><dt>Listed</dt><dd class="gv-danger">${GV.money(listed)}</dd></div>
            <div><dt>Gap</dt><dd class="gv-danger">${GV.money(gap)}</dd></div>
            <div><dt>Net after fees</dt><dd class="gv-ok">${GV.money(velocity?.netMedian)}</dd></div>
            <div><dt>P25–P75</dt><dd>${GV.money(velocity?.p25)}–${GV.money(velocity?.p75)}</dd></div>
          </dl>
          <p class="gv-note">${esc(velocity?.reasons?.[0] || "Read the sold tab, then apply.")}</p>
        </div>
        <div class="gv-actions">
          <button class="gv-btn primary" type="button" data-act="apply"${fast == null ? " disabled" : ""}>
            ${applied != null ? "Applied " + GV.money(applied) : "Apply Fast-Cash"}
          </button>
          <button class="gv-btn ghost" type="button" data-act="sold">Open solds</button>
          <button class="gv-btn wide" type="button" data-act="copy"${fast == null ? " disabled" : ""}>Copy price</button>
        </div>
        <p class="gv-sec">
          Verified solds
          <button type="button" class="gv-link" data-act="noise">${showDropped ? "Hide noise" : "Show " + (verified.length - kept.length) + " dropped"}</button>
        </p>
        <ul class="gv-list">
          ${visible
            .map(
              (row) => `<li>
                <button type="button" data-act="toggle" data-id="${esc(row.id)}" class="${row.keep ? "" : "gv-drop"}">
                  <span>
                    <span class="gv-match">${matchPct(row.matchScore)}</span>
                    ${esc(row.title)}
                  </span>
                  <span class="gv-price">${GV.money(row.price)}</span>
                </button>
              </li>`,
            )
            .join("")}
        </ul>
      </div>
    `;
    wrap.onclick = onClick;
    const box = wrap.querySelector("#gv-q");
    if (box) {
      box.addEventListener("input", onType);
      box.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const q = box.value.trim();
          if (q) location.href = GV.soldUrl(q);
        }
      });
    }
  }

  function paintSuggests() {
    const wrap = ensureHost().shadowRoot.querySelector(".gv");
    if (!wrap) return;
    const form = wrap.querySelector(".gv-type");
    let ul = wrap.querySelector(".gv-suggest");
    if (!suggests.length) {
      if (ul) ul.remove();
      return;
    }
    if (!ul) {
      ul = document.createElement("ul");
      ul.className = "gv-suggest";
      form.after(ul);
    }
    ul.innerHTML = suggests
      .map(
        (hit) => `<li>
          <button type="button" data-act="hit" data-q="${esc(hit.query || hit.title)}" data-kind="${esc(hit.kind)}">
            <span>${esc(hit.title)}</span>
            <span class="gv-price">${hit.kind === "tape" ? GV.money(hit.fastCash) : "book"}</span>
          </button>
        </li>`,
      )
      .join("");
  }

  async function onType(e) {
    typeQuery = e.target.value;
    const gen = (typeGen += 1);
    if (!typeQuery.trim()) {
      suggests = [];
      paintSuggests();
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({ type: "GV_SUGGEST", q: typeQuery });
      if (gen !== typeGen) return;
      suggests = res?.hits || [];
    } catch {
      if (gen !== typeGen) return;
      suggests = GV.suggestTape(typeQuery, { catalog, tape: [], limit: 8 });
    }
    paintSuggests();
  }

  async function loadSnapshot(q) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "GV_TAPE_GET", query: q });
      if (res?.snapshot?.comps?.length) {
        query = res.snapshot.query || q;
        verified = res.snapshot.comps.map((c) => ({
          ...c,
          keep: true,
          flags: [],
          reason: "Cached high-match",
        }));
        scanMeta = {
          stoppedAt: verified.length,
          nCliff: res.snapshot.nCliff || 0,
          nRaw: res.snapshot.nRaw || verified.length,
          nKept: res.snapshot.nKept || verified.length,
        };
        sku = GV.matchSku(catalog, query);
        recompute();
        render();
        return true;
      }
    } catch {
      /* local miss */
    }
    return false;
  }

  async function onClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    if (act === "close") {
      open = false;
      const host = document.getElementById(HOST_ID);
      if (host) host.style.display = "none";
      return;
    }
    if (act === "apply") {
      const fast = velocity?.fastCashPrice ?? sku?.fastCash;
      if (fast == null) return;
      const ok = GV.applyPrice(fast);
      applied = fast;
      if (!ok) {
        navigator.clipboard?.writeText(Number(fast).toFixed(2));
      }
      await chrome.storage.local.set({ lastApply: { sku: sku?.id, price: fast, at: Date.now() } });
      render();
      return;
    }
    if (act === "sold" && query) {
      location.href = GV.soldUrl(query);
      return;
    }
    if (act === "copy") {
      const fast = velocity?.fastCashPrice ?? sku?.fastCash;
      if (fast != null) navigator.clipboard?.writeText(Number(fast).toFixed(2));
      return;
    }
    if (act === "noise") {
      showDropped = !showDropped;
      render();
      return;
    }
    if (act === "hit") {
      const q = btn.getAttribute("data-q");
      typeQuery = q;
      suggests = [];
      const hitCached = await loadSnapshot(q);
      if (!hitCached) {
        query = q;
        sku = GV.matchSku(catalog, q);
        render();
      }
      return;
    }
    if (act === "toggle") {
      const id = btn.getAttribute("data-id");
      verified = verified.map((v) => (v.id === id ? { ...v, keep: !v.keep } : v));
      recompute();
      render();
    }
  }

  function recompute() {
    velocity = GV.scoreVelocity({
      verified,
      cogs: sku?.cogs || 0,
      listPrice: sku?.listPrice,
      settings: GV.DEFAULT_FEES,
      category: sku?.category,
    });
  }

  function applySnapshot(snapshot) {
    if (!snapshot?.comps?.length) return;
    const byId = new Map(verified.filter((v) => v.keep).map((v) => [v.id, v]));
    for (const c of snapshot.comps) byId.set(c.id, { ...c, keep: true, flags: c.flags || [], reason: c.reason || "Cached high-match" });
    verified = [...byId.values()].concat(verified.filter((v) => !v.keep && !byId.has(v.id)));
    scanMeta = {
      ...scanMeta,
      nKept: snapshot.nKept || byId.size,
      nCliff: snapshot.nCliff || scanMeta.nCliff,
      nRaw: snapshot.nRaw || scanMeta.nRaw,
    };
  }

  async function read() {
    query = GV.pageQuery();
    typeQuery = typeQuery || query;
    const cached = await chrome.runtime.sendMessage({ type: "GV_TAPE_GET", query }).catch(() => null);
    if (cached?.snapshot?.comps?.length) {
      applySnapshot(cached.snapshot);
      sku = GV.matchSku(catalog, query);
      recompute();
      render();
    }
    const listings = GV.scrapeEbay(document);
    const result = GV.verifyComps(query, listings);
    scanMeta = {
      stoppedAt: result.stoppedAt,
      nCliff: result.nCliff,
      nRaw: result.nRaw,
      nKept: result.nKept,
    };
    verified = result.rows;
    sku = GV.matchSku(catalog, query);
    const listingPrice = document.querySelector("#binPrice, input[name='binPrice'], .x-price-primary");
    if (listingPrice && sku) {
      const live = GV.parsePrice(listingPrice.value || listingPrice.textContent);
      if (live) sku = { ...sku, listPrice: live };
    }
    recompute();
    try {
      const put = await chrome.runtime.sendMessage({
        type: "GV_TAPE_PUT",
        query,
        verified: result,
        velocity,
        url: location.href,
      });
      if (put?.snapshot) applySnapshot(put.snapshot);
      recompute();
    } catch {
      /* local only */
    }
    render();
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "\u0026amp;")
      .replace(/</g, "\u0026lt;")
      .replace(/>/g, "\u0026gt;")
      .replace(/"/g, "\u0026quot;");
  }

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg?.type === "GV_TOGGLE") {
      open = !open;
      const host = document.getElementById(HOST_ID);
      if (host) host.style.display = open ? "block" : "none";
      if (open) read();
      send({ open });
    }
    if (msg?.type === "GV_READ") {
      open = true;
      read();
      send({ query, n: verified.length, action: velocity?.action });
    }
    return true;
  });

  await loadCatalog();
  if (GV.isSoldSearch() || GV.isListingOrRevise() || GV.scrapeEbay(document).length) {
    read();
  }
})();
