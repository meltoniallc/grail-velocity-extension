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
  let readGen = 0;
  let velocity = null;
  let sku = null;
  let query = "";
  let applied = null;
  let open = true;
  let showDropped = false;
  let suggests = [];
  let typeQuery = "";
  let typeGen = 0;
  let statusMsg = "";
  let settings = { ...GV.DEFAULT_FEES };
  let autoCapture = true;
  let lastSig = "";
  let observeTimer = null;
  let statusTimer = null;
  let canContinueSolds = false;
  let nextSoldHref = null;
  let followingSoldPage = false;
  let tapeSync = null;

  function cssUrl() {
    return chrome.runtime.getURL("content/overlay.css");
  }

  async function loadCatalog() {
    catalog = await GV.loadCatalog();
  }

  async function loadPrefs() {
    try {
      const stored = await chrome.storage.local.get(["fees", "overlayOpen", "autoCapture", "tapeSync"]);
      if (stored.fees && typeof stored.fees === "object") {
        settings = { ...GV.DEFAULT_FEES, ...stored.fees };
      }
      if (typeof stored.overlayOpen === "boolean") open = stored.overlayOpen;
      autoCapture = GV.autoCaptureEnabled(stored.autoCapture);
      if (stored.tapeSync && typeof stored.tapeSync === "object") tapeSync = stored.tapeSync;
    } catch {
      /* ignore */
    }
  }

  function setStatus(msg, ms = 3500) {
    statusMsg = msg || "";
    if (statusTimer) clearTimeout(statusTimer);
    if (msg && ms > 0) {
      statusTimer = setTimeout(() => {
        statusMsg = "";
        if (open) render();
      }, ms);
    }
    if (open) render();
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

  function setOpen(next) {
    open = next;
    chrome.storage.local.set({ overlayOpen: open }).catch(() => {});
    render();
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
    if (scanMeta.nCliff) return GV.deskStatusLine("cliffed");
    if (pageMode === "sold") {
      return velocity?.reasons?.[0] || "Scrape solds, then apply.";
    }
    if (soldKept.length) {
      return `Fast-Cash from ${soldKept.length} sold comps. Live asks are the list only — they never set the price.`;
    }
    if (pageRows.length) {
      return "Scraped live asks. Open solds for comps. Live prices never set Fast-Cash.";
    }
    return GV.deskStatusLine("watching");
  }

  function emptyListMsg() {
    if (scraping || (!pageRows.length && pageMode === "sold")) return GV.deskStatusLine("watching");
    if (scanMeta.nCliff && !pageRows.filter((row) => row.keep).length) {
      return GV.deskStatusLine("cliffed");
    }
    if (pageMode === "sold") {
      return "Sold results are still loading, or selectors missed this layout. Wait a beat or scrape again.";
    }
    return "Nothing scraped yet. Scrape this page pulls high-match titles from live search, solds, or a listing.";
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
    const listed = GV.listedAsk(pageMode, sku, pageRows);
    const gap = listed != null && fast != null ? listed - fast : null;
    const action = (velocity?.action || "QUARANTINE").toLowerCase();
    const kept = pageRows.filter((row) => row.keep);
    const visible = showDropped ? pageRows : kept;
    const avg =
      kept.length > 0 ? kept.reduce((sum, row) => sum + (row.matchScore || 0), 0) / kept.length : 0;
    const droppedCount = pageRows.length - kept.length;
    const captureKey = GV.captureStatus({
      scraping,
      nCliff: scanMeta.nCliff,
      nRaw: scanMeta.nRaw,
      pageRows,
      soldTape,
    });
    const captureLine = GV.deskStatusLine(captureKey);
    const syncInfo = GV.formatTapeSync(tapeSync);
    const tapeChip = fast != null ? "TAPE" : "NO TAPE";
    const tapeHint =
      fast != null
        ? kept.length
          ? matchPct(avg) + " match on this page"
          : "Sold comps only — Apply uses this price."
        : GV.deskNoTapeLine();
    const cliffed = captureKey === "cliffed" || (scanMeta.nCliff || 0) > 0;
    wrap.innerHTML = `
      <div class="gv-head">
        <div>
          <p class="gv-kicker">${esc(modeLabel())}</p>
          <p class="gv-title">High-match tape</p>
          <p class="gv-sync ${esc(syncInfo.kind)}" title="${esc(syncInfo.detail)}" data-tape-sync="${esc(syncInfo.kind)}">${esc(syncInfo.label)}</p>
        </div>
        <button class="gv-x" type="button" data-act="close" aria-label="Hide">×</button>
      </div>
      ${
        syncInfo.kind === "bad" && syncInfo.banner
          ? `<p class="gv-sync-banner" role="alert" data-tape-sync="bad">${esc(syncInfo.banner)}</p>`
          : ""
      }
      <div class="gv-body">
        <form class="gv-type" data-act="type-form">
          <input id="gv-q" type="search" placeholder="Type a card — tape answers as you go" value="${esc(typeQuery)}" autocomplete="off" />
        </form>
        <p class="gv-hint">Alt+Shift+G toggles this panel</p>
        ${
          suggests.length
            ? `<ul class="gv-suggest">${suggests
                .map(
                  (hit) => `<li>
                    <button type="button" data-act="hit" data-q="${esc(hit.query || hit.title)}" data-kind="${esc(hit.kind)}">
                      <span>${esc(hit.title)}</span>
                      <span class="gv-price">${hit.kind === "tape" ? GV.money(hit.fastCash) : "catalog"}</span>
                    </button>
                  </li>`,
                )
                .join("")}</ul>`
            : ""
        }
        <p class="gv-q">${esc(query || "No query on this page")}</p>
        <p class="gv-id" data-capture-status="${esc(captureKey)}">${esc(captureLine)}</p>
        ${
          sku
            ? `<div class="gv-sku">
                ${sku.image ? `<img src="${esc(sku.image)}" alt="">` : `<div class="gv-ph"></div>`}
                <div>
                  <div class="gv-id">${esc(sku.id)}${sku.confidence ? " · " + esc(sku.confidence) : ""}</div>
                  <p>${esc(sku.title)}</p>
                </div>
              </div>`
            : `<div class="gv-sku"><div class="gv-ph"></div><p>No catalog match. Tape still prices sold comps.</p></div>`
        }
        <div class="gv-card">
          <div class="gv-row">
            <span class="gv-badge ${esc(action)}">${esc((velocity?.action || "QUARANTINE").replace("_", " "))}</span>
            <span class="gv-id">${kept.length} on page · ${soldTape.filter((row) => row.keep).length} sold</span>
          </div>
          ${
            cliffed
              ? `<p class="gv-note gv-cliff">${esc(GV.deskStatusLine("cliffed"))}${
                  scanMeta.nCliff
                    ? ` Stopped at row ${scanMeta.stoppedAt + 1} (${scanMeta.nCliff} miss${scanMeta.nCliff === 1 ? "" : "es"}).`
                    : ""
                } <button type="button" class="gv-link" data-act="scratch">Inspect scratch</button></p>`
              : ""
          }
          ${
            pageMode !== "sold"
              ? `<p class="gv-note">Live/listing asks stay off the sold tape. Fast-Cash only moves after sold comps exist.</p>`
              : ""
          }
          <div class="gv-roles">
            <div class="gv-role gv-role-tape" data-role="tape">
              <p class="gv-role-kicker">Fast-Cash <span class="gv-src${fast == null ? " none" : ""}">${esc(tapeChip)}</span></p>
              <p class="gv-role-value gv-fast">${GV.money(fast)}</p>
              <p class="gv-role-hint">${esc(tapeHint)}</p>
            </div>
            <div class="gv-role gv-role-ask" data-role="ask">
              <p class="gv-role-kicker">Listed ask</p>
              <p class="gv-role-value">${listed != null ? GV.money(listed) : "—"}</p>
              <p class="gv-role-hint">${pageMode === "sold" ? "Sold search — no live ask on this page." : "Live BIN/ask on this page. Never sets Fast-Cash."}</p>
            </div>
            <div class="gv-role gv-role-book" data-role="book">
              <p class="gv-role-kicker">Book ref</p>
              <p class="gv-role-value">${bookRef != null ? GV.money(bookRef) : "—"}</p>
              <p class="gv-role-hint">Catalog only — not sold tape. Do not Apply.</p>
            </div>
          </div>
          <p class="gv-id" style="margin-top:8px">${kept.length ? matchPct(avg) + " match on this page" : scraping ? GV.deskStatusLine("watching") : "Nothing scraped yet"}</p>
          <dl class="gv-dl">
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
          ${
            canContinueSolds
              ? `<button class="gv-btn ghost" type="button" data-act="continue-solds"${scraping || followingSoldPage ? " disabled" : ""}>Continue solds</button>`
              : ""
          }
          <button class="gv-btn ${pageMode === "listing" ? "primary" : "ghost"}" type="button" data-act="apply"${fast == null ? " disabled" : ""}>
            ${applied != null ? "Applied " + GV.money(applied) : "Apply Fast-Cash"}
          </button>
          <button class="gv-btn wide" type="button" data-act="copy"${fast == null ? " disabled" : ""}>Copy price</button>
          <button class="gv-btn wide" type="button" data-act="copy-findings"${!soldTape.length && !pageRows.length ? " disabled" : ""}>Copy findings</button>
        </div>
        ${statusMsg ? `<p class="gv-status" role="status">${esc(statusMsg)}</p>` : ""}
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
            : `<p class="gv-empty">${esc(emptyListMsg())}</p>`
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
            <span class="gv-price">${hit.kind === "tape" ? GV.money(hit.fastCash) : "catalog"}</span>
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
    const hits = await GV.suggestLocalFirst(typeQuery, {
      catalog,
      tape: soldTape,
      limit: 8,
    });
    if (gen !== typeGen) return;
    suggests = hits;
    paintSuggests();
  }

  function findingsText() {
    return GV.findingsText({ query, velocity, pageRows, soldTape });
  }

  function applySoldTape(snapshot) {
    if (!snapshot?.comps?.length) return;
    const byId = new Map(soldTape.map((row) => [row.id, row]));
    for (const comp of snapshot.comps) {
      if (comp.kind === "active") continue;
      byId.set(comp.id, {
        ...comp,
        kind: "sold",
        keep: true,
        flags: comp.flags || [],
        reason: comp.reason || "Cached sold tape",
      });
    }
    soldTape = [...byId.values()].filter((row) => row.kind !== "active");
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
        writeLastRead();
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
      setOpen(false);
      return;
    }
    if (act === "open") {
      setOpen(true);
      return;
    }
    if (act === "apply") {
      const fast = GV.cashFromTape(velocity).value;
      if (fast == null) return;
      const ok = GV.applyPrice(fast);
      applied = fast;
      await chrome.storage.local.set({ lastApply: { sku: sku?.id, price: fast, at: Date.now() } });
      if (ok) {
        setStatus(`Wrote ${GV.money(fast)} into the price field.`);
      } else {
        try {
          await navigator.clipboard.writeText(Number(fast).toFixed(2));
          setStatus(`No price field here — copied ${GV.money(fast)} to clipboard.`);
        } catch {
          setStatus(`Could not write or copy ${GV.money(fast)}.`);
          render();
        }
      }
      return;
    }
    if (act === "scrape") {
      await read({ force: true, mode: "manual" });
      return;
    }
    if (act === "sold") {
      const q = query || typeQuery;
      if (q) location.href = GV.soldUrl(q);
      return;
    }
    if (act === "continue-solds") {
      followNextSoldPage("manual");
      return;
    }
    if (act === "copy") {
      const fast = GV.cashFromTape(velocity).value;
      if (fast == null) return;
      try {
        await navigator.clipboard.writeText(Number(fast).toFixed(2));
        setStatus(`Copied ${GV.money(fast)}.`);
      } catch {
        setStatus("Clipboard blocked — copy failed.");
      }
      return;
    }
    if (act === "copy-findings") {
      try {
        await navigator.clipboard.writeText(findingsText());
        setStatus("Copied findings (action + kept comps).");
      } catch {
        setStatus("Clipboard blocked — copy failed.");
      }
      return;
    }
    if (act === "noise") {
      showDropped = !showDropped;
      render();
      return;
    }
    if (act === "scratch") {
      const q = query || typeQuery || "";
      await chrome.storage.local.set({ optionsFocus: GV.optionsScratchFocus(q) });
      chrome.runtime.openOptionsPage();
      setStatus(q ? `Opening Options scratch for “${q.slice(0, 48)}${q.length > 48 ? "…" : ""}”.` : "Opening Options scratch inspector.");
      return;
    }
    if (act === "hit") {
      // Typeahead never opens sold tabs — load retained tape only.
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
        soldTape = GV.mergeKeepIntoSoldTape(soldTape, pageRows);
      }
      recompute();
      lastSig = sigNow();
      writeLastRead();
      render();
    }
  }

  function recompute() {
    velocity = GV.scoreVelocity({
      verified: soldTape.filter((row) => row.keep && GV.isSoldComp(row)),
      cogs: sku?.cogs || 0,
      listPrice: GV.listedAsk(pageMode, sku, pageRows),
      settings,
      category: sku?.category,
    });
  }

  function sigNow() {
    const page = pageRows.map((v) => `${v.id}:${v.price}:${v.keep ? 1 : 0}`).join("|");
    const sold = soldTape.map((v) => `${v.id}:${v.price}:${v.keep ? 1 : 0}`).join("|");
    return `${query}::${page}::${sold}::${sku?.id || ""}::${velocity?.action || ""}`;
  }

  function writeLastRead() {
    chrome.storage.local
      .set({
        lastRead: GV.lastReadPayload({
          query,
          pageRows,
          soldTape,
          velocity,
          at: Date.now(),
        }),
      })
      .catch(() => {});
  }

  function updateContinueSolds(scan) {
    const info = GV.soldSearchPage(location.href);
    const page = info?.page || 1;
    const nextUrl = pageMode === "sold" ? GV.nextSoldPageUrl(location.href, query) : null;
    nextSoldHref = nextUrl;
    canContinueSolds = GV.shouldContinueSoldPages({
      pageMode,
      page,
      nKept: scan?.nKept ?? scanMeta.nKept,
      nCliff: scan?.nCliff ?? scanMeta.nCliff,
      nRaw: scan?.nRaw ?? scanMeta.nRaw,
      nextUrl,
      maxPages: GV.SOLD_PAGE_CAP,
    });
  }

  function followNextSoldPage(reason) {
    if (!canContinueSolds || !nextSoldHref) return false;
    if (followingSoldPage) return false;
    followingSoldPage = true;
    setStatus(
      reason === "auto" ? "Auto-following next sold page…" : "Opening next sold page…",
      4000,
    );
    location.href = nextSoldHref;
    return true;
  }

  async function scrapeListings() {
    let listings = GV.scrapeEbay(document);
    if (!listings.length && (GV.isSearchPage() || GV.isSoldSearch() || GV.isListingOrRevise())) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      listings = GV.scrapeEbay(document);
    }
    return listings;
  }

  async function read(opts = false) {
    const options =
      opts && typeof opts === "object"
        ? { force: Boolean(opts.force), mode: opts.mode === "manual" ? "manual" : "auto" }
        : { force: Boolean(opts), mode: opts ? "manual" : "auto" };
    const force = options.force;
    const captureMode = options.mode;
    const gen = (readGen += 1);
    scraping = true;
    const prevQ = query;
    const prevKeep = new Map(pageRows.map((row) => [row.id, row.keep]));
    pageMode = GV.pageMode();
    query = GV.pageQuery();
    typeQuery = typeQuery || query;
    render();
    try {
      // Tape lookup (may cold-hydrate from the Tape API) and the DOM scrape are
      // independent: start both, then apply in the original order.
      const cachedP = chrome.runtime.sendMessage({ type: "GV_TAPE_GET", query }).catch(() => null);
      const listingsP = scrapeListings();
      const cached = await cachedP;
      if (gen !== readGen) return;
      if (cached?.snapshot?.comps?.length) applySoldTape(cached.snapshot);
      const listings = await listingsP;
      if (gen !== readGen) return;
      const result = GV.verifyComps(query, listings);
      scanMeta = {
        stoppedAt: result.stoppedAt,
        nCliff: result.nCliff,
        nRaw: result.nRaw,
        nKept: result.nKept,
        mode: captureMode,
        pageMode,
      };
      pageRows = GV.preserveKeepToggles(result.rows, prevKeep, query === prevQ);
      sku = GV.matchSku(catalog, query);
      const listingPrice = document.querySelector("#binPrice, input[name='binPrice'], .x-price-primary");
      if (listingPrice && sku) {
        const live = GV.parsePrice(listingPrice.value || listingPrice.textContent);
        if (live) sku = { ...sku, listPrice: live };
      }
      if (pageMode === "sold") {
        applySoldTape({ comps: GV.soldVerified(pageRows) });
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
            mode: captureMode,
            pageMode,
            stoppedAt: result.stoppedAt,
            nCliff: result.nCliff,
          });
          if (gen !== readGen) return;
          if (put?.snapshot) applySoldTape(put.snapshot);
          recompute();
        } catch {
          /* local only */
        }
      }
      if (gen !== readGen) return;
      updateContinueSolds(result);
      const next = sigNow();
      if (!force && next === lastSig) {
        /* still allow sold pagination after identical sig */
      } else {
        lastSig = next;
        writeLastRead();
      }
      // Auto-follow next sold page only on sold-search, never from typeahead.
      if (
        captureMode === "auto" &&
        GV.shouldScheduleAutoRead(autoCapture) &&
        canContinueSolds &&
        nextSoldHref
      ) {
        followNextSoldPage("auto");
        return;
      }
    } finally {
      if (gen === readGen) {
        scraping = false;
        render();
      }
    }
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "\u0026amp;")
      .replace(/</g, "\u0026lt;")
      .replace(/>/g, "\u0026gt;")
      .replace(/"/g, "\u0026quot;");
  }

  function pageChanged(mutations) {
    return GV.pageChanged(mutations, HOST_ID);
  }

  function shouldWatchPage() {
    return GV.isSoldSearch() || GV.isSearchPage() || GV.isListingOrRevise() || GV.scrapeEbay(document).length > 0;
  }

  function scheduleRead() {
    if (!GV.shouldScheduleAutoRead(autoCapture)) return;
    if (observeTimer) clearTimeout(observeTimer);
    observeTimer = setTimeout(() => {
      if (!GV.shouldScheduleAutoRead(autoCapture)) return;
      if (shouldWatchPage()) read({ force: false, mode: "auto" });
    }, 450);
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
      soldTape = [];
      sku = null;
      velocity = null;
      applied = null;
      lastSig = "";
      canContinueSolds = false;
      nextSoldHref = null;
      followingSoldPage = false;
      scanMeta = { stoppedAt: null, nCliff: 0, nRaw: 0, nKept: 0 };
      render();
      if (
        GV.shouldScheduleAutoRead(autoCapture) &&
        (GV.isSoldSearch() || GV.isSearchPage() || GV.isListingOrRevise())
      ) {
        read({ force: true, mode: "auto" });
      } else if (query) {
        loadSnapshot(query);
      }
    }, 500);
  }

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg?.type === "GV_TOGGLE") {
      setOpen(!open);
      if (open) read({ force: true, mode: "manual" });
      send({ open });
    }
    if (msg?.type === "GV_READ") {
      setOpen(true);
      read({ force: true, mode: "manual" });
      send({ query, n: pageRows.length, action: velocity?.action });
    }
    return true;
  });

  document.addEventListener(
    "keydown",
    (e) => {
      if (!GV.isOverlayToggleHotkey(e)) return;
      e.preventDefault();
      setOpen(!open);
      if (open) read({ force: true, mode: "manual" });
    },
    true,
  );

  await Promise.all([loadCatalog(), loadPrefs()]);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.autoCapture) {
      autoCapture = GV.autoCaptureEnabled(changes.autoCapture.newValue);
      if (!GV.shouldScheduleAutoRead(autoCapture) && observeTimer) {
        clearTimeout(observeTimer);
        observeTimer = null;
      }
    }
    if (changes.tapeSync) {
      tapeSync = changes.tapeSync.newValue || null;
      if (open) render();
    }
  });
  pageMode = GV.pageMode();
  query = GV.pageQuery();
  typeQuery = query;
  render();
  watchLocation();
  const mo = new MutationObserver((mutations) => {
    if (!pageChanged(mutations)) return;
    scheduleRead();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  if (
    GV.shouldScheduleAutoRead(autoCapture) &&
    (GV.isSoldSearch() || GV.isSearchPage() || GV.isListingOrRevise())
  ) {
    await read({ force: true, mode: "auto" });
  } else if (query) {
    await loadSnapshot(query);
  }
})();
