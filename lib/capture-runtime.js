/* Service-worker capture controller. Persists through the storage and outbox adapters. */
(function (global) {
  function createCaptureRuntime(io) {
    let tail = Promise.resolve();
    function exclusive(fn) {
      const run = tail.then(fn, fn);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }

    async function readSettings() {
      const data = await io.storage.get(["captureSettings"]);
      return global.GVObserve.normalizeSettings(data.captureSettings);
    }

    async function writeSettings(next) {
      const prefs = global.GVObserve.normalizeSettings(next);
      await io.storage.set({ captureSettings: prefs });
      return prefs;
    }

    async function paint(count) {
      if (!io.setBadge) return;
      await io.setBadge(count ? String(Math.min(count, 999)) : "");
    }

    async function todayCount(now) {
      const data = await io.storage.get(["captureDay"]);
      const day = global.GVObserve.dayKey(now);
      if (!data.captureDay || data.captureDay.day !== day) return 0;
      return Number(data.captureDay.count) || 0;
    }

    async function addToday(n, now) {
      const day = global.GVObserve.dayKey(now);
      const count = (await todayCount(now)) + n;
      await io.storage.set({ captureDay: { day, count } });
      await paint(count);
      return count;
    }

    function rememberRow(row) {
      return {
        title: row.title,
        price: row.price,
        at: row.captured_at,
        page_type: row.page_type,
        url: row.url,
        status: row.status,
        sold_date: row.sold_date,
      };
    }

    async function onObserve(pageUrl, observations) {
      const now = io.now();
      const prefs = await readSettings();
      const stored = await io.storage.get(["captureRate"]);
      const decision = global.GVObserve.gate(pageUrl, prefs, stored.captureRate, now);
      if (!decision.ok) return { ok: false, reason: decision.reason, accepted: 0 };
      const sealed = [];
      for (const obs of observations || []) {
        const row = await global.GVObserve.sealObservation(obs, prefs);
        if (!row.title || !row.item_id) continue;
        sealed.push(row);
      }
      if (!sealed.length) return { ok: false, reason: "empty", accepted: 0 };
      const again = await io.storage.get(["captureRate"]);
      const commit = global.GVObserve.gate(pageUrl, prefs, again.captureRate, now);
      if (!commit.ok) return { ok: false, reason: commit.reason, accepted: 0 };
      await io.storage.set({ captureRate: commit.rate });
      const added = await io.outbox.putMany(sealed);
      if (added) await addToday(added, now);
      const data = await io.storage.get(["captureRecent"]);
      const recent = Array.isArray(data.captureRecent) ? data.captureRecent : [];
      const nextRecent = sealed.map(rememberRow).concat(recent).slice(0, 8);
      await io.storage.set({ captureRecent: nextRecent });
      return { ok: true, accepted: added, seen: sealed.length };
    }

    async function update(patch) {
      const current = await readSettings();
      const next = {
        ...current,
        ...patch,
        sites: { ...current.sites, ...(patch && patch.sites ? patch.sites : {}) },
      };
      if (!patch || !Object.prototype.hasOwnProperty.call(patch, "sellerHmacSecret")) {
        next.sellerHmacSecret = current.sellerHmacSecret;
      }
      return writeSettings(next);
    }

    async function status() {
      const now = io.now();
      const prefs = await readSettings();
      const data = await io.storage.get(["captureSync", "captureRecent"]);
      const recent = Array.isArray(data.captureRecent) ? data.captureRecent : [];
      return {
        captureEnabled: prefs.captureEnabled,
        sites: prefs.sites,
        pausePatterns: prefs.pausePatterns,
        capturePausedUntil: prefs.capturePausedUntil,
        ownSellerId: prefs.ownSellerId,
        hasSellerSecret: Boolean(prefs.sellerHmacSecret),
        today: await todayCount(now),
        queue: await io.outbox.size(),
        last: recent[0] || null,
        server: data.captureSync || null,
      };
    }

    async function flush() {
      const batch = await io.outbox.peek(40);
      if (!batch.length) return { ok: true, sent: 0 };
      let result;
      try {
        result = await io.postObserve(batch);
      } catch (err) {
        result = { ok: false, error: String(err.message || err) };
      }
      if (!result || !result.ok) {
        await io.storage.set({
          captureSync: { ok: false, at: io.now(), error: result && result.error ? result.error : "post failed", status: result && result.status },
        });
        return { ok: false, sent: 0, error: result && result.error };
      }
      await io.outbox.remove(batch.map((row) => row.raw_hash));
      await io.storage.set({ captureSync: { ok: true, at: io.now(), sent: batch.length } });
      return { ok: true, sent: batch.length };
    }

    async function lookup(q) {
      const needle = String(q || "").trim();
      if (needle.length < 2) return [];
      let remote = [];
      if (io.searchObserved) {
        try {
          remote = await io.searchObserved(needle);
        } catch {
          remote = [];
        }
      }
      const data = await io.storage.get(["captureRecent"]);
      const recent = Array.isArray(data.captureRecent) ? data.captureRecent : [];
      const folded = needle.toLowerCase();
      const local = recent.filter((row) => String(row.title || "").toLowerCase().includes(folded));
      const seen = new Set();
      const hits = [];
      for (const row of [...remote, ...local]) {
        const key = `${row.url || ""}|${row.title || ""}|${row.price || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push(row);
        if (hits.length >= 8) break;
      }
      return hits;
    }

    return {
      status: () => exclusive(status),
      update: (patch) => exclusive(() => update(patch)),
      pauseFor: (ms) => exclusive(() => update({ capturePausedUntil: io.now() + Number(ms || 0) })),
      onObserve: (pageUrl, observations) => exclusive(() => onObserve(pageUrl, observations)),
      flush: () => exclusive(flush),
      lookup: (q) => exclusive(() => lookup(q)),
    };
  }

  global.GVCaptureRuntime = { createCaptureRuntime };
})(globalThis);
