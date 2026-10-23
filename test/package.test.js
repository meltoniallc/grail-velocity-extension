"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  INCLUDE,
  ZIP,
  packageExtension,
  listZipNames,
  readZipEntry,
} = require("../scripts/package");

test("package builds zip with grail-velocity/manifest.json and all runtime files", () => {
  const result = packageExtension({
    env: { ...process.env, MELTONIA_TAPE_SECRET: "test-bake-secret-not-for-prod", MELTONIA_PACKAGE_STRICT: "" },
  });
  assert.equal(result.zipPath, ZIP);
  assert.ok(fs.existsSync(ZIP), "dist/grail-velocity-2.1.0-meltonia.zip missing");
  assert.match(path.basename(ZIP), /^grail-velocity-2\.1\.0-meltonia\.zip$/);
  assert.equal(result.baked.hasSecret, true);

  const names = listZipNames(ZIP);
  assert.ok(names.includes("grail-velocity/manifest.json"));
  assert.ok(names.includes("grail-velocity/lib/meltonia-defaults.js"));
  for (const rel of INCLUDE) {
    assert.ok(names.includes(`grail-velocity/${rel}`), `missing ${rel}`);
  }

  assert.ok(!names.some((n) => n.includes("node_modules")), "zip must exclude node_modules");
  assert.ok(!names.some((n) => /(^|\/)test(\/|$)/.test(n)), "zip must exclude test/");
  assert.ok(!names.some((n) => n.includes("server/")), "zip must exclude server/");
  assert.ok(
    !names.some((n) => n.includes("/data/") || n.endsWith("/data")),
    "zip must exclude data/"
  );

  const rootManifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8")
  );
  const packedManifest = JSON.parse(
    readZipEntry(ZIP, "grail-velocity/manifest.json").toString("utf8")
  );
  assert.equal(packedManifest.version, rootManifest.version);
  assert.equal(packedManifest.background.service_worker, "background.js");

  const baked = readZipEntry(ZIP, "grail-velocity/lib/meltonia-defaults.js").toString("utf8");
  assert.match(baked, /tape-production-2810\.up\.railway\.app/);
  assert.match(baked, /test-bake-secret-not-for-prod/);
  // Git stub must stay empty — bake is zip-only.
  const stub = fs.readFileSync(path.join(__dirname, "../lib/meltonia-defaults.js"), "utf8");
  assert.doesNotMatch(stub, /test-bake-secret-not-for-prod/);
  assert.match(stub, /tapeSecret:\s*""/);
});

test("strict Meltonia package refuses an empty Tape secret", () => {
  assert.throws(
    () =>
      packageExtension({
        env: { MELTONIA_PACKAGE_STRICT: "1", MELTONIA_TAPE_SECRET: "", TAPE_SECRET: "" },
      }),
    /MELTONIA_PACKAGE_STRICT/,
  );
});
