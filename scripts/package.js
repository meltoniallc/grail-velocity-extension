"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist");
const STAGE = path.join(OUT_DIR, "grail-velocity");
const ZIP = path.join(OUT_DIR, "grail-velocity-extension.zip");

/** Runtime files required to load-unpacked per INSTALL / manifest. */
const INCLUDE = [
  "manifest.json",
  "background.js",
  "catalog.json",
  "lib/core.js",
  "lib/tape.js",
  "content/ebay.js",
  "content/overlay.css",
  "popup/index.html",
  "popup/popup.css",
  "popup/popup.js",
  "options/index.html",
  "options/options.js",
  "sidepanel/index.html",
  "sidepanel/sidepanel.css",
  "sidepanel/sidepanel.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

function packageExtension() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(ZIP, { force: true });

  for (const rel of INCLUDE) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) {
      throw new Error(`missing package input: ${rel}`);
    }
    const dest = path.join(STAGE, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  const zip = spawnSync("zip", ["-r", "-q", ZIP, "grail-velocity"], {
    cwd: OUT_DIR,
    encoding: "utf8",
  });
  if (zip.status !== 0) {
    throw new Error(`zip failed: ${zip.stderr || zip.stdout || zip.error}`);
  }

  return { zipPath: ZIP, include: INCLUDE.slice() };
}

if (require.main === module) {
  const result = packageExtension();
  console.log(result.zipPath);
}

module.exports = { INCLUDE, ZIP, STAGE, OUT_DIR, packageExtension };
