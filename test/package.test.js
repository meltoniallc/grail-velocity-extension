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
  const result = packageExtension();
  assert.equal(result.zipPath, ZIP);
  assert.ok(fs.existsSync(ZIP), "dist/grail-velocity-extension.zip missing");

  const names = listZipNames(ZIP);
  assert.ok(names.includes("grail-velocity/manifest.json"));
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
});
