/* Grail Velocity — durable tape (verified prices) + scratch (rejected). Classic script. */
(function (global) {
  const GV = global.GV;
  const KEEP_SCRATCH_MS = 7 * 24 * 3600 * 1000;
  const MAX_SCRATCH = 400;

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
      keep: true,
    };
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
      const kept = rows.filter((r) => r.keep);
      const dropped = rows.filter((r) => !r.keep);
      const existing = snapshots.find((s) => s.queryNorm === norm);
      const compsById = new Map();
      if (existing) {
        for (const c of existing.comps || []) compsById.set(c.id, c);
      }
      for (const c of kept) compsById.set(c.id, compactComp(c));
      const comps = [...compsById.values()];
      const priced = GV.scoreVelocity({
        verified: comps.map((c) => ({ ...c, keep: true })),
        cogs: 0,
      });
      const snap = {
        query,
        queryNorm: norm,
        title: query,
        comps,
        nKept: comps.length,
        nRaw: (existing?.nRaw || 0) + rows.length,
        nCliff: verified.nCliff || dropped.filter((d) => (d.flags || []).includes("beyond_cliff")).length,
        median: priced.median,
        p25: priced.p25,
        p75: priced.p75,
        fastCash: priced.fastCashPrice ?? scan.velocity?.fastCashPrice ?? null,
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
        listings: dropped.map((d) => ({
          id: d.id,
          title: d.title,
          price: d.price,
          matchScore: d.matchScore,
          flags: d.flags,
          reason: d.reason,
          keep: false,
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
      return snapshots.find((s) => s.queryNorm === norm) || null;
    }

    async function getScratch(query) {
      const { scratch } = await load();
      const norm = queryNorm(query);
      const listings = scratch.filter((s) => s.queryNorm === norm).flatMap((s) => s.listings || []);
      return { listings };
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

  global.GVTape = { create, queryNorm };
})(typeof globalThis !== "undefined" ? globalThis : self);
