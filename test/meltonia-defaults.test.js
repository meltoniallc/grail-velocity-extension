"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts } = require("./load-core");

const { GV } = loadScripts(["lib/core.js", "lib/meltonia-defaults.js"]);

function memStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const out = {};
      for (const k of keys) out[k] = data[k];
      return out;
    },
    async set(patch) {
      Object.assign(data, patch);
    },
  };
}

test("meltonia defaults bake Railway URL and empty git stub secret", () => {
  const d = GV.meltoniaTapeDefaults();
  assert.equal(d.tapeApi, "https://tape-production-2810.up.railway.app");
  assert.equal(d.tapeSecret, "");
  assert.equal(GV.tapeApiAllowed(d.tapeApi), true);
});

test("seedMeltoniaTapeDefaults fills empty storage from bake", async () => {
  const storage = memStorage({});
  GV.MELTONIA_TAPE_DEFAULTS.tapeSecret = "baked-secret";
  const res = await GV.seedMeltoniaTapeDefaults(storage, { force: false });
  assert.equal(res.seeded, true);
  assert.equal(storage.data.tapeApi, "https://tape-production-2810.up.railway.app");
  assert.equal(storage.data.tapeSecret, "baked-secret");
  const again = await GV.seedMeltoniaTapeDefaults(storage, { force: false });
  assert.equal(again.seeded, false);
  GV.MELTONIA_TAPE_DEFAULTS.tapeSecret = "";
});

test("seedMeltoniaTapeDefaults force replaces storage on Meltonia zip update", async () => {
  const storage = memStorage({
    tapeApi: "http://127.0.0.1:8787",
    tapeSecret: "old-paste",
  });
  GV.MELTONIA_TAPE_DEFAULTS.tapeSecret = "new-bake";
  const res = await GV.seedMeltoniaTapeDefaults(storage, { force: true });
  assert.equal(res.seeded, true);
  assert.equal(storage.data.tapeApi, "https://tape-production-2810.up.railway.app");
  assert.equal(storage.data.tapeSecret, "new-bake");
  GV.MELTONIA_TAPE_DEFAULTS.tapeSecret = "";
});
