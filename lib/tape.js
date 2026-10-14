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
      if (adapter.pushRemote) {
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

    return { putScan, getSnapshot, getScratch, suggest };
  }

  global.GVTape = { create, queryNorm, normalizeCaptureMeta, splitScanRows };
})(typeof globalThis !== "undefined" ? globalThis : self);
