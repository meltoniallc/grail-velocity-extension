(() => {
  const GV = globalThis.GV;
  if (!GV) return;

  const HOST_ID = "grail-velocity-root";
  let catalog = [];
  let verified = [];
  let velocity = null;
  let sku = null;
  let query = "";
  let applied = null;
  let open = true;

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

  function render() {
    const host = ensureHost();
    host.style.display = open ? "block" : "none";
    const wrap = host.shadowRoot.querySelector(".gv");
    const fast = velocity?.fastCashPrice ?? sku?.fastCash ?? null;
    const listed = sku?.listPrice ?? null;
    const gap = listed != null && fast != null ? listed - fast : null;
    const action = (velocity?.action || "QUARANTINE").toLowerCase();
    const kept = verified.filter((v) => v.keep);
    wrap.innerHTML = `
      <div class="gv-head">
        <div>
          <p class="gv-kicker">Grail Velocity</p>
          <p class="gv-title">On eBay as you</p>
        </div>
        <button class="gv-x" type="button" data-act="close" aria-label="Hide">×</button>
      </div>
      <div class="gv-body">
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
            <span class="gv-id">${kept.length}/${verified.length} kept</span>
          </div>
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
        <p class="gv-sec">Sold tape</p>
        <ul class="gv-list">
          ${verified
            .map(
              (row) => `<li>
                <button type="button" data-act="toggle" data-id="${esc(row.id)}" class="${row.keep ? "" : "gv-drop"}">
                  <span>${esc(row.title)}</span>
                  <span class="gv-price">${GV.money(row.price)}</span>
                </button>
              </li>`,
            )
            .join("")}
        </ul>
      </div>
    `;
    wrap.onclick = onClick;
  }

  function onClick(e) {
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
      chrome.storage.local.set({ lastApply: { sku: sku?.id, price: fast, at: Date.now() } });
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

  function read() {
    query = GV.pageQuery();
    const listings = GV.scrapeEbay(document);
    verified = GV.verifyComps(query, listings);
    sku = GV.matchSku(catalog, query);
    if (sku?.listPrice && !document.querySelector("#binPrice, input[name='binPrice']")) {
      /* keep listed from book */
    }
    const listingPrice = document.querySelector("#binPrice, input[name='binPrice'], .x-price-primary");
    if (listingPrice && sku) {
      const live = GV.parsePrice(listingPrice.value || listingPrice.textContent);
      if (live) sku = { ...sku, listPrice: live };
    }
    recompute();
    render();
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&")
      .replace(/</g, "<")
      .replace(/>/g, ">")
      .replace(/"/g, """);
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

  loadCatalog().then(() => {
    if (GV.isSoldSearch() || GV.isListingOrRevise() || GV.scrapeEbay(document).length) {
      read();
    }
  });
})();
