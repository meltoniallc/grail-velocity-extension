"use strict";

/**
 * Meltonia desk Tape defaults.
 *
 * The private Meltonia zip (`npm run package` with MELTONIA_TAPE_SECRET) rewrites
 * tapeSecret at package time. The git copy stays empty on purpose — never commit
 * a live Railway TAPE_SECRET. Backend (Railway Tape) holds DATABASE_URL + secret;
 * Meltonia only loads the zip.
 */
(function (global) {
  const GV = global.GV || (global.GV = {});
  const TAPE_API = "https://tape-production-2810.up.railway.app";

  GV.MELTONIA_TAPE_DEFAULTS = {
    tapeApi: TAPE_API,
    tapeSecret: "",
  };

  GV.meltoniaTapeDefaults = function meltoniaTapeDefaults() {
    const d = GV.MELTONIA_TAPE_DEFAULTS || {};
    return {
      tapeApi: String(d.tapeApi || TAPE_API).replace(/\/+$/, ""),
      tapeSecret: String(d.tapeSecret || ""),
    };
  };

  /**
   * Seed chrome.storage from baked defaults when API/secret are empty.
   * force=true (install/update) re-applies baked values so a new Meltonia zip
   * replaces a stale empty or outdated operator paste without Options ritual.
   */
  GV.seedMeltoniaTapeDefaults = async function seedMeltoniaTapeDefaults(storage, opts) {
    const force = Boolean(opts && opts.force);
    const d = GV.meltoniaTapeDefaults();
    if (!d.tapeApi) return { ok: false, skipped: "no-defaults" };
    const cur = await storage.get(["tapeApi", "tapeSecret"]);
    const patch = {};
    const haveApi = String(cur.tapeApi || "").trim();
    const haveSecret = String(cur.tapeSecret || "").trim();
    if (force || !haveApi) patch.tapeApi = d.tapeApi;
    if (d.tapeSecret && (force || !haveSecret)) patch.tapeSecret = d.tapeSecret;
    if (!Object.keys(patch).length) return { ok: true, seeded: false };
    await storage.set(patch);
    return { ok: true, seeded: true, keys: Object.keys(patch) };
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
