"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { INCLUDE, ZIP, packageExtension } = require("../scripts/package");

test("package builds zip with grail-velocity/manifest.json and all runtime files", () => {
  const result = packageExtension();
  assert.equal(result.zipPath, ZIP);
  assert.ok(fs.existsSync(ZIP), "dist/grail-velocity-extension.zip missing");

  const list = spawnSync("unzip", ["-Z1", ZIP], { encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr || list.stdout);
  const names = list.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  assert.ok(names.includes("grail-velocity/manifest.json"));
  for (const rel of INCLUDE) {
    assert.ok(names.includes(`grail-velocity/${rel}`), `missing ${rel}`);
  }

  assert.ok(!names.some((n) => n.includes("node_modules")), "zip must exclude node_modules");
  assert.ok(!names.some((n) => /(^|\/)test(\/|$)/.test(n)), "zip must exclude test/");
  assert.ok(!names.some((n) => n.includes("server/")), "zip must exclude server/");
  assert.ok(!names.some((n) => n.includes("/data/") || n.endsWith("/data")), "zip must exclude data/");

  const rootManifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8")
  );
  const packed = spawnSync("unzip", ["-p", ZIP, "grail-velocity/manifest.json"], {
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const packedManifest = JSON.parse(packed.stdout);
  assert.equal(packedManifest.version, rootManifest.version);
  assert.equal(packedManifest.background.service_worker, "background.js");
});
