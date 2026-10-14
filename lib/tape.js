/* Grail Velocity — durable tape (verified prices) + scratch (rejected). Classic script. */
(function (global) {
  const GV = global.GV;
  const KEEP_SCRATCH_MS = 7 * 24 * 3600 * 1000;
  const MAX_SCRATCH = 400;

  /**
   * putScan contract (additive; match math unchanged — KEEP_MIN/TIGHT_MIN/cliff/Fast-Cash stay in core):
   * - Kept sold rows that pass durableSoldComp → durable tapeSnapshots (+ Postgres when remote).
   * - Everything else (rejects, cliff noise, live asks even if keep) → tapeScratch (+ SQLite when remote).
   * - Capture meta on every scan: mode ("auto"|"manual"), pageMode, stoppedAt, nCliff
   *   → Chrome scratch entry and SQLite page_scans (via pushRemote payload).
   */
  function queryNorm(q) {
    return GV.fold(q);
  }

  function compactComp(row) {
    return {
      id: row.id,
      title: row.title,
      price: row.price,
      matchScore: row.matchScore,
      soldDate: row.soldDate || null,
      url: row.url || null,
      kind: GV.isSoldComp(row) ? "sold" : row.kind || "active",
      keep: true,
    };
  }

  function normalizeCaptureMeta(scan, verified) {
    const v = verified || {};
    const mode = scan && scan.mode === "manual" ? "manual" : "auto";
    const pageMode = (scan && scan.pageMode) || null;
    const stoppedAt =
      scan && scan.stoppedAt != null
        ? scan.stoppedAt
        : v.stoppedAt != null
          ? v.stoppedAt
          : null;
    const nCliff =
      scan && scan.nCliff != null
        ? Number(scan.nCliff) || 0
        : v.nCliff != null
          ? Number(v.nCliff) || 0
          : 0;
    return { mode, pageMode, stoppedAt, nCliff };
  }

  /** Split verified rows: kept solds → durable; rejects / cliff / live asks → scratch. */
  function splitScanRows(rows) {
    const list = rows || [];
    const keptSold = list.filter((r) => r.keep && GV.isSoldComp(r));
    const parked = list.filter((r) => !r.keep || !GV.isSoldComp(r));
    return { keptSold, parked };
  }

  /** Stable fingerprint of durable comps for remote coalesce (ignore at/url/mode churn). */
  function snapshotPushSig(snapshot) {
    const comps = (snapshot && snapshot.comps) || [];
    const body = comps
      .map((c) => `${c.id}\t${Number(c.price)}\t${c.kind || "sold"}\t${Number(c.matchScore) || 0}`)
      .sort()
      .join("|");
    return `${(snapshot && snapshot.queryNorm) || ""}\0${body}\0${Number((snapshot && snapshot.nCliff) || 0)}`;
  }

  /** Stable fingerprint of one scratch entry's parked set. */
  function scratchPushSig(entry) {
    const listings = (entry && entry.listings) || [];
    const body = listings
      .map(
        (l) =>
          `${l.id}\t${Number(l.price)}\t${l.kind || ""}\t${l.keep ? 1 : 0}\t${(l.flags || []).slice().sort().join(",")}`,
      )
      .sort()
      .join("|");
    return `${(entry && entry.queryNorm) || ""}\0${body}\0${Number((entry && entry.nCliff) || 0)}\0${
      entry && entry.stoppedAt != null ? entry.stoppedAt : ""
    }`;
  }

  /**
   * Push remote only when durable comps or parked scratch set changed vs prior local state.
   * Local save always runs; remote is coalesced separately.
   */
  function remotePushNeeded(prevSnap, prevScratchEntry, nextSnap, nextScratchEntry) {
    if (snapshotPushSig(nextSnap) !== snapshotPushSig(prevSnap || { comps: [], queryNorm: nextSnap?.queryNorm })) {
      return true;
    }
    if (scratchPushSig(nextScratchEntry) !== scratchPushSig(prevScratchEntry || { listings: [], queryNorm: nextSnap?.queryNorm })) {
      return true;
    }
    return false;
  }

  /**
   * Coerce a remote row into a durable sold comp candidate.
   * Rejects live asks (kind active) and non-durable shapes — scratch must never land here.
   */
  function remoteRowToDurable(row) {
    if (!row || typeof row !== "object") return null;
    if (row.kind === "active") return null;
    const id = row.id != null ? row.id : row.itemId != null ? row.itemId : row.item_id;
    if (id == null || id === "") return null;
    const price = Number(row.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    const soldDate = row.soldDate || row.sold_date || null;
    const kind = row.kind === "sold" || soldDate ? "sold" : row.kind || "sold";
    const candidate = {
      id: String(id),
      title: String(row.title || ""),
      price,
      matchScore: Number(row.matchScore != null ? row.matchScore : row.match_score) || 0,
      soldDate,
      url: row.url || null,
      kind,
      keep: true,
    };
    if (!GV.durableSoldComp(candidate)) return null;
    return compactComp(candidate);
  }

  /**
   * Build durable sold comps from GET /tape payload (snapshot.comps + verifiedPrices).
   * Never imports scratch / active asks into Fast-Cash.
   */
  function durableCompsFromRemote(remote) {
    const payload = remote || {};
    const snap = payload.snapshot || null;
    const prices = payload.verifiedPrices || payload.verified_prices || [];
    const byId = new Map();
    for (const row of prices) {
      const c = remoteRowToDurable(row);
      if (c) byId.set(c.id, c);
    }
    for (const row of (snap && snap.comps) || []) {
      const c = remoteRowToDurable(row);
      if (c) byId.set(c.id, c);
    }
    return [...byId.values()];
  }

  function create(adapter) {
    async function load() {
      const data = (await adapter.load()) || {};
      return {
        snapshots: data.snapshots || [],
        scratch: data.scratch || [],
      };
    }

    async function putScan(scan) {
      const { snapshots, scratch } = await load();
      const query = scan.query || "";
      const norm = queryNorm(query);
      const verified = scan.verified || {};
      const rows = verified.rows || [];
      const { keptSold, parked } = splitScanRows(rows);
      const meta = normalizeCaptureMeta(scan, verified);
      const existing = snapshots.find((s) => s.queryNorm === norm);
      const priorScratch = [...scratch].reverse().find((s) => s.queryNorm === norm) || null;
      const compsById = new Map();
      if (existing) {
        for (const c of existing.comps || []) {
          if (!GV.durableSoldComp(c)) continue;
          compsById.set(c.id, { ...c, kind: "sold" });
        }
      }
      for (const c of keptSold) compsById.set(c.id, compactComp(c));
      const comps = [...compsById.values()];
      const priced = GV.scoreVelocity({
        verified: comps.map((c) => ({ ...c, keep: true })),
        cogs: 0,
      });
      const nCliff =
        meta.nCliff ||
        parked.filter((d) => (d.flags || []).includes("beyond_cliff")).length;
      const snap = {
        query,
        queryNorm: norm,
        title: query,
        comps,
        nKept: comps.length,
        nRaw: (existing?.nRaw || 0) + rows.length,
        nCliff,
        stoppedAt: meta.stoppedAt,
        mode: meta.mode,
        pageMode: meta.pageMode,
        median: priced.median,
        p25: priced.p25,
        p75: priced.p75,
        fastCash: comps.length ? priced.fastCashPrice ?? null : existing?.fastCash ?? null,
        at: Date.now(),
        url: scan.url || null,
      };
      const nextSnaps = snapshots.filter((s) => s.queryNorm !== norm).concat(snap);
      const now = Date.now();
      const scratchEntry = {
        query,
        queryNorm: norm,
        at: now,
        url: scan.url || null,
        mode: meta.mode,
        pageMode: meta.pageMode,
        stoppedAt: meta.stoppedAt,
        nCliff,
        listings: parked.map((d) => ({
          id: d.id,
          title: d.title,
          price: d.price,
          matchScore: d.matchScore,
          flags: d.flags,
          reason: d.reason,
          kind: d.kind || (d.keep ? "active" : "dropped"),
          keep: Boolean(d.keep),
        })),
      };
      const nextScratch = scratch
        .filter((s) => now - (s.at || 0) < KEEP_SCRATCH_MS)
        .concat(scratchEntry)
        .slice(-MAX_SCRATCH);

      await adapter.saveSnapshots(nextSnaps);
      await adapter.saveScratch(nextScratch);
      if (adapter.pushRemote && remotePushNeeded(existing, priorScratch, snap, scratchEntry)) {
        await adapter.pushRemote({ snapshot: snap, scratch: scratchEntry });
      }
      return snap;
    }

    async function getSnapshot(query) {
      const { snapshots } = await load();
      const norm = queryNorm(query);
      const snap = snapshots.find((s) => s.queryNorm === norm) || null;
      if (!snap) return null;
      const comps = (snap.comps || [])
        .filter((c) => GV.durableSoldComp(c))
        .map((c) => ({ ...c, kind: "sold" }));
      return { ...snap, comps, nKept: comps.length };
    }

    /**
     * Merge Postgres pull into Chrome tapeSnapshots.
     * Local durable comps win on item id (Chrome remains online SoT).
     * Never writes scratch; never pushRemote (hydrate is read-side only).
     */
    async function hydrateFromRemote(remote) {
      const payload = remote || {};
      const remoteComps = durableCompsFromRemote(payload);
      if (!remoteComps.length) return null;
      const snapIn = payload.snapshot || {};
      const query = snapIn.query || snapIn.queryRaw || snapIn.title || "";
      const norm = snapIn.queryNorm || queryNorm(query);
      if (!norm) return null;
      const { snapshots } = await load();
      const existing = snapshots.find((s) => s.queryNorm === norm) || null;
      const compsById = new Map();
      if (existing) {
        for (const c of existing.comps || []) {
          if (!GV.durableSoldComp(c)) continue;
          compsById.set(String(c.id), { ...c, kind: "sold" });
        }
      }
      for (const c of remoteComps) {
        if (!compsById.has(c.id)) compsById.set(c.id, c);
      }
      const comps = [...compsById.values()];
      if (!comps.length) return null;
      const priced = GV.scoreVelocity({
        verified: comps.map((c) => ({ ...c, keep: true })),
        cogs: 0,
      });
      const snap = {
        query: query || existing?.query || norm,
        queryNorm: norm,
        title: query || existing?.title || norm,
        comps,
        nKept: comps.length,
        nRaw: Math.max(Number(existing?.nRaw) || 0, Number(snapIn.nRaw) || 0, comps.length),
        nCliff: existing?.nCliff != null ? existing.nCliff : snapIn.nCliff != null ? snapIn.nCliff : 0,
        stoppedAt: existing?.stoppedAt != null ? existing.stoppedAt : null,
        mode: existing?.mode || "auto",
        pageMode: existing?.pageMode || null,
        median: priced.median,
        p25: priced.p25,
        p75: priced.p75,
        fastCash: priced.fastCashPrice ?? null,
        at: Date.now(),
        url: existing?.url || null,
        hydratedFrom: "postgres",
      };
      const nextSnaps = snapshots.filter((s) => s.queryNorm !== norm).concat(snap);
      await adapter.saveSnapshots(nextSnaps);
      // Scratch untouched; no pushRemote — write path stays live→SQLite / solds→Postgres only.
      return snap;
    }

    async function getScratch(query) {
      const { scratch } = await load();
      const norm = queryNorm(query);
      const listings = scratch.filter((s) => s.queryNorm === norm).flatMap((s) => s.listings || []);
      return { listings, entries: scratch.filter((s) => s.queryNorm === norm) };
    }

    async function suggest(q, opts) {
      const { snapshots } = await load();
      return GV.suggestTape(q, {
        tape: snapshots,
        catalog: (opts && opts.catalog) || [],
        limit: (opts && opts.limit) || 8,
      });
    }

    return { putScan, getSnapshot, getScratch, suggest, hydrateFromRemote };
  }

  global.GVTape = {
    create,
    queryNorm,
    normalizeCaptureMeta,
    splitScanRows,
    snapshotPushSig,
    scratchPushSig,
    remotePushNeeded,
    remoteRowToDurable,
    durableCompsFromRemote,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
