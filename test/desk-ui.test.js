"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("extension is 2.1.0 and the desk uses the Meltonia palette", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.version, "2.1.0");
  assert.ok(manifest.permissions.includes("alarms"));
  const css = read("popup/popup.css") + read("options/options.css") + read("sidepanel/sidepanel.css");
  assert.match(css, /#050505/);
  assert.match(css, /#121212/);
  assert.match(css, /#e5e4e2/);
  assert.match(css, /#d4af37/);
  assert.match(css, /#22c7c9/);
  assert.doesNotMatch(css, /#65b8b0/i);
  assert.match(css, /Bebas Neue/);
  assert.match(css, /Assistant/);
  assert.match(css, /DM Mono/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(css, /border-radius:\s*[5-9]\d*px/);
  assert.doesNotMatch(css, /border-radius:\s*1\d+px/);
  assert.match(css, /\.role\.tape/);
  assert.match(css, /\.role\.ask/);
  assert.match(css, /\.desk-status/);
});

test("popup and options are keyboard controls with no inline handlers", () => {
  for (const rel of ["popup/index.html", "options/index.html", "sidepanel/index.html"]) {
    const html = read(rel);
    assert.doesNotMatch(html, /\son\w+=/i);
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i);
  }
  const popup = read("popup/index.html");
  assert.match(popup, /id="capture-on"/);
  assert.match(popup, /id="site-ebay"/);
  assert.match(popup, /id="pause-1h"/);
  assert.match(popup, /id="today"/);
  assert.match(popup, /id="queue"/);
  assert.match(popup, /id="last"/);
  assert.match(popup, /id="lookup"/);
  assert.match(popup, /id="desk-status"/);
  assert.match(popup, /id="roles"/);
  assert.match(popup, /data-role="tape"/);
  assert.match(popup, /data-role="ask"/);
  assert.match(popup, /data-role="book"/);
  assert.match(popup, /lib\/overlay\.js/);
  assert.match(popup, /for="q"/);
  const panel = read("sidepanel/index.html");
  assert.match(panel, /Side panel · cut queue/);
  assert.match(panel, /id="desk-status"/);
  assert.match(panel, /data-role="tape"/);
  assert.match(panel, /data-role="ask"/);
  assert.doesNotMatch(panel, /data-role="book"/);
  assert.doesNotMatch(panel, /\bbook dressed\b/i);
  assert.match(panel, /List → Fast-Cash gaps only/);
  const options = read("options/index.html");
  assert.match(options, /for="pause-list"/);
  assert.match(options, /for="seller-secret"/);
  assert.match(options, /Seller HMAC secret never leaves this browser/i);
  assert.match(options, /id="presetRailway"/);
  assert.match(options, /Use Railway Tape/);
  assert.match(options, /tape-production-2810\.up\.railway\.app/);
  const readme = read("README.md");
  assert.match(readme, /2\.1\.0/);
  assert.match(readme, /Load unpacked/);
  assert.match(readme, /User Agreement/);
  assert.match(readme, /personally views/);
});
