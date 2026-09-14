(async () => {
  const GV = globalThis.GV;
  if (!GV) return;

  const HOST_ID = "grail-velocity-root";
  let catalog = [];
  let pageRows = [];
  let soldTape = [];
  let scanMeta = { stoppedAt: null, nCliff: 0, nRaw: 0, nKept: 0 };
  let pageMode = "page";
  let scraping = false;
  let scrapeLock = false;
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

  function panelStyle() {
    return "all:initial;position:fixed;top:0;right:0;z-index:2147483646;width:360px;height:100vh;max-width:100vw;box-shadow:-8px 0 24px rgba(0,0,0,.35);";
  }

  function dockStyle() {
    return "all:initial;position:fixed;top:88px;right:0;z-index:2147483646;";
  }

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host) return host;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = panelStyle();
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

  function modeLabel() {
    switch (pageMode) {
      case "sold":
        return "Sold tape";
      case "listing":
        return "Listing";
      case "live":
        return "Live search";
      case "page":
        return "This page";
      default:
        return "This page";
    }
  }

  function scrapeLabel() {
    if (scraping) return "Scraping…";
    if (pageMode === "sold") return "Scrape solds";
    if (pageMode === "listing") return "Scrape this listing";
    return "Scrape this page";
  }

  function listHeading() {
    if (pageMode === "sold") return "Verified solds";
    if (pageMode === "listing") return "This listing";
    return "Scraped this page";
  }

  function cashNote() {
    const soldKept = soldTape.filter((row) => row.keep);
    if (pageMode === "sold") {
      return velocity?.reasons?.[0] || "Scrape solds, then apply.";
    }
    if (soldKept.length) {
      return `Fast-Cash from ${soldKept.length} sold comps. Live asks are the list only — they never set the price.`;
    }
    if (pageRows.length) {
      return "Scraped live asks. Open solds for comps. Live prices never set Fast-Cash.";
    }
    return "Scrape this page for high-match titles. Open solds when you need comps.";
  }

  function render() {
    const host = ensureHost();
    const wrap = host.shadowRoot.querySelector(".gv");
    if (!open) {
      host.style.cssText = dockStyle();
      wrap.innerHTML = `<button class="gv-dock" type="button" data-act="open">Scrape</button>`;
      wrap.onclick = onClick;
      return;
    }
    host.style.cssText = panelStyle();
    const cash = GV.cashFromTape(velocity);
    const fast = cash.value;
    const bookRef = sku?.fastCash ?? null;
    const listed = sku?.listPrice ?? (pageMode === "sold" ? null : pageRows.find((row) => row.keep)?.price) ?? null;
    const gap = listed != null && fast != null ? listed - fast : null;
    const action = (velocity?.action || "QUARANTINE").toLowerCase();
    const kept = pageRows.filter((row) => row.keep);
    const visible = showDropped ? pageRows : kept;
    const avg =
      kept.length > 0 ? kept.reduce((sum, row) => sum + (row.matchScore || 0), 0) / kept.length : 0;
    const droppedCount = pageRows.length - kept.length;
    wrap.innerHTML = `
      <div class="gv-head">
        <div>
          <p class="gv-kicker">${esc(modeLabel())}</p>
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
            : `<div class="gv-sku"><div class="gv-ph"></div><p>No book match. Tape still prices sold comps.</p></div>`
        }
        <div class="gv-card">
          <div class="gv-row">
            <span class="gv-badge ${esc(action)}">${esc((velocity?.action || "QUARANTINE").replace("_", " "))}</span>
            <span class="gv-id">${kept.length} on page · ${soldTape.filter((row) => row.keep).length} sold</span>
          </div>
          ${
            scanMeta.nCliff
              ? `<p class="gv-note gv-cliff">Stopped at row ${scanMeta.stoppedAt + 1}. ${scanMeta.nCliff} titles no longer matched — noise parked, not priced.</p>`
              : ""
          }
          ${
            pageMode !== "sold"
              ? `<p class="gv-note">Live/listing asks stay off the sold tape. Fast-Cash only moves after sold comps exist.</p>`
              : ""
          }
          <p class="gv-kicker" style="margin-top:12px">Fast-Cash <span class="gv-src">${fast != null ? "TAPE" : "NO TAPE"}</span></p>
          <p class="gv-fast">${GV.money(fast)}</p>
          ${
            bookRef != null
              ? `<p class="gv-id" style="margin-top:4px">Book ref ${GV.money(bookRef)} — catalog, not this page. Do not apply.</p>`
              : ""
          }
          <p class="gv-id" style="margin-top:4px">${kept.length ? matchPct(avg) + " match on this page" : "Nothing scraped yet"}</p>
          <dl class="gv-dl">
            <div><dt>Listed</dt><dd class="gv-danger">${GV.money(listed)}</dd></div>
            <div><dt>Gap</dt><dd class="gv-danger">${GV.money(gap)}</dd></div>
            <div><dt>Net after fees</dt><dd class="gv-ok">${GV.money(velocity?.netMedian)}</dd></div>
            <div><dt>P25–P75</dt><dd>${GV.money(velocity?.p25)}–${GV.money(velocity?.p75)}</dd></div>
          </dl>
          <p class="gv-note">${esc(cashNote())}</p>
        </div>
        <div class="gv-actions">
          <button class="gv-btn primary scrape" type="button" data-act="scrape"${scraping ? " disabled" : ""}>
            ${esc(scrapeLabel())}
          </button>
          <button class="gv-btn ghost" type="button" data-act="sold">Open solds</button>
          <button class="gv-btn ${pageMode === "listing" ? "primary" : "ghost"}" type="button" data-act="apply"${fast == null ? " disabled" : ""}>
            ${applied != null ? "Applied " + GV.money(applied) : "Apply Fast-Cash"}
          </button>
          <button class="gv-btn wide" type="button" data-act="copy"${fast == null ? " disabled" : ""}>Copy price</button>
        </div>
        <p class="gv-sec">
          ${esc(listHeading())}
          <button type="button" class="gv-link" data-act="noise">${showDropped ? "Hide noise" : "Show " + droppedCount + " dropped"}</button>
        </p>
        ${
          visible.length
            ? `<ul class="gv-list">
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
        </ul>`
            : `<p class="gv-empty">${
                scraping
                  ? "Reading this tab…"
                  : "Nothing scraped yet. Scrape this page pulls high-match titles from live search, solds, or a listing."
              }</p>`
        }
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
    if (!wrap || !open) return;
    const form = wrap.querySelector(".gv-type");
    if (!form) return;
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
      suggests = GV.suggestTape(typeQuery, { catalog, tape: soldTape, limit: 8 });
    }
    paintSuggests();
  }

  function applySoldTape(snapshot) {
    if (!snapshot?.comps?.length) return;
    const byId = new Map(soldTape.map((row) => [row.id, row]));
    for (const comp of snapshot.comps) {
      byId.set(comp.id, {
        ...comp,
        keep: true,
        flags: comp.flags || [],
        reason: comp.reason || "Cached sold tape",
      });
    }
    soldTape = [...byId.values()];
  }

  async function loadSnapshot(q) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "GV_TAPE_GET", query: q });
      if (res?.snapshot?.comps?.length) {
        query = res.snapshot.query || q;
        applySoldTape(res.snapshot);
        scanMeta = {
          stoppedAt: soldTape.length,
          nCliff: res.snapshot.nCliff || 0,
          nRaw: res.snapshot.nRaw || soldTape.length,
          nKept: res.snapshot.nKept || soldTape.length,
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
      render();
      return;
    }
    if (act === "open") {
      open = true;
      render();
      return;
    }
    if (act === "apply") {
      const fast = GV.cashFromTape(velocity).value;
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
    if (act === "scrape") {
      await read();
      return;
    }
    if (act === "sold") {
      const q = query || typeQuery;
      if (q) location.href = GV.soldUrl(q);
      return;
    }
    if (act === "copy") {
      const fast = GV.cashFromTape(velocity).value;
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
      pageRows = pageRows.map((row) => (row.id === id ? { ...row, keep: !row.keep } : row));
      if (pageMode === "sold") {
        soldTape = GV.soldVerified(pageRows);
      }
      recompute();
      render();
    }
  }

  function recompute() {
    const listedAsk =
      pageMode === "sold" ? sku?.listPrice ?? null : pageRows.find((row) => row.keep)?.price ?? sku?.listPrice ?? null;
    velocity = GV.scoreVelocity({
      verified: soldTape.filter((row) => row.keep),
      cogs: sku?.cogs || 0,
      listPrice: listedAsk,
      settings: GV.DEFAULT_FEES,
      category: sku?.category,
    });
  }

  async function scrapeListings() {
    let listings = GV.scrapeEbay(document);
    if (!listings.length && (GV.isSearchPage() || GV.isSoldSearch() || GV.isListingOrRevise())) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      listings = GV.scrapeEbay(document);
    }
    return listings;
  }

  async function read() {
    if (scrapeLock) return;
    scrapeLock = true;
    scraping = true;
    pageMode = GV.pageMode();
    query = GV.pageQuery();
    typeQuery = typeQuery || query;
    render();
    try {
      const cached = await chrome.runtime.sendMessage({ type: "GV_TAPE_GET", query }).catch(() => null);
      if (cached?.snapshot?.comps?.length) applySoldTape(cached.snapshot);
      const listings = await scrapeListings();
      const result = GV.verifyComps(query, listings);
      scanMeta = {
        stoppedAt: result.stoppedAt,
        nCliff: result.nCliff,
        nRaw: result.nRaw,
        nKept: result.nKept,
      };
      pageRows = result.rows;
      sku = GV.matchSku(catalog, query);
      const listingPrice = document.querySelector("#binPrice, input[name='binPrice'], .x-price-primary");
      if (listingPrice && sku) {
        const live = GV.parsePrice(listingPrice.value || listingPrice.textContent);
        if (live) sku = { ...sku, listPrice: live };
      }
      if (pageMode === "sold") {
        applySoldTape({ comps: GV.soldVerified(result.rows) });
      }
      recompute();
      if (listings.length) {
        try {
          const put = await chrome.runtime.sendMessage({
            type: "GV_TAPE_PUT",
            query,
            verified: result,
            velocity,
            url: location.href,
          });
          if (put?.snapshot) applySoldTape(put.snapshot);
          recompute();
        } catch {
          /* local only */
        }
      }
    } finally {
      scraping = false;
      scrapeLock = false;
      render();
    }
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "\u0026amp;")
      .replace(/</g, "\u0026lt;")
      .replace(/>/g, "\u0026gt;")
      .replace(/"/g, "\u0026quot;");
  }

  function watchLocation() {
    let href = location.href;
    setInterval(() => {
      if (location.href === href) return;
      href = location.href;
      pageMode = GV.pageMode();
      query = GV.pageQuery();
      typeQuery = query;
      pageRows = [];
      applied = null;
      render();
      if (GV.isSoldSearch() || GV.isSearchPage() || GV.isListingOrRevise()) {
        read();
      } else if (query) {
        loadSnapshot(query);
      }
    }, 500);
  }

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg?.type === "GV_TOGGLE") {
      open = !open;
      render();
      if (open) read();
      send({ open });
    }
    if (msg?.type === "GV_READ") {
      open = true;
      read();
      send({ query, n: pageRows.length, action: velocity?.action });
    }
    return true;
  });

  await loadCatalog();
  pageMode = GV.pageMode();
  query = GV.pageQuery();
  typeQuery = query;
  render();
  watchLocation();
  if (GV.isSoldSearch() || GV.isSearchPage() || GV.isListingOrRevise()) {
    await read();
  } else if (query) {
    await loadSnapshot(query);
  }
})();
