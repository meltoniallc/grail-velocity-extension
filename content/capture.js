/* One capture per page view. Never navigates, never fetches. */
(function (global) {
  const WAIT_MS = 1500;
  const GRACE_MS = 1200;

  function install(deps) {
    const wait = deps.waitMs == null ? WAIT_MS : deps.waitMs;
    const grace = deps.graceMs == null ? GRACE_MS : deps.graceMs;
    const location = deps.location;
    let lastSent = "";
    let timer = 0;

    function parseNow(url) {
      const page = global.GVObserve.classify(url);
      if (!page) return [];
      const ctx = { url, now: deps.now(), version: deps.version() };
      if (page.pageType === "item") return global.GVParse.ebayItem(deps.document, ctx);
      if (page.pageType === "sold_search") return global.GVParse.ebaySoldSearch(deps.document, ctx);
      if (page.pageType === "active_search") return global.GVParse.ebayActiveSearch(deps.document, ctx);
      return [];
    }

    async function sendOnce() {
      const url = location.href;
      const clean = global.GVObserve.cleanEbayUrl(url);
      if (!clean || clean === lastSent) return;
      if (!global.GVObserve.classify(url)) return;
      let rows = parseNow(url);
      const thin = rows[0] && rows[0].page_type === "item" && Object.keys(rows[0].specifics || {}).length === 0;
      if (thin && deps.observe) {
        rows = await new Promise((resolve) => {
          let settled = false;
          const finish = (next) => {
            if (settled) return;
            settled = true;
            resolve(next);
          };
          deps.observe(() => {
            const again = parseNow(url);
            if (again[0] && Object.keys(again[0].specifics || {}).length) finish(again);
          }, grace, () => finish(parseNow(url)));
        });
      }
      if (location.href !== url) return;
      if (!rows.length) return;
      lastSent = clean;
      deps.send({ type: "GV_OBSERVE", pageUrl: url, observations: rows });
    }

    function schedule() {
      deps.clearTimeout(timer);
      timer = deps.setTimeout(() => {
        sendOnce();
      }, wait);
    }

    function notifyNavigation() {
      lastSent = "";
      schedule();
    }

    schedule();
    return { schedule, notifyNavigation };
  }

  global.GVCapture = { install, WAIT_MS, GRACE_MS };

  if (global.chrome && global.chrome.runtime && global.chrome.runtime.sendMessage && global.document && global.location) {
    const session = install({
      location: global.location,
      document: global.document,
      now: () => Date.now(),
      version: () => global.chrome.runtime.getManifest().version,
      setTimeout: global.setTimeout.bind(global),
      clearTimeout: global.clearTimeout.bind(global),
      send: (msg) => {
        global.chrome.runtime.sendMessage(msg).catch(() => {});
      },
      observe: (onMutate, grace, done) => {
        const obs = new MutationObserver(() => onMutate());
        obs.observe(global.document.documentElement, { childList: true, subtree: true });
        global.setTimeout(() => {
          obs.disconnect();
          done();
        }, grace);
      },
    });
    let href = global.location.href;
    global.setInterval(() => {
      if (global.location.href === href) return;
      href = global.location.href;
      session.notifyNavigation();
    }, 500);
  }
})(globalThis);
