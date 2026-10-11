"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { inspect, scan } = require("../scripts/check-secrets");

const ROOT = path.join(__dirname, "..");
const CI_YML = path.join(ROOT, ".github/workflows/ci.yml");

test("CI workflow steps each have run or uses so GitHub can start the job", () => {
  const yml = fs.readFileSync(CI_YML, "utf8");
  assert.match(yml, /^name:\s*CI\s*$/m);
  const steps = [];
  const stepRe = /^\s+- (?:name:|uses:|run:).*$/gm;
  let m;
  while ((m = stepRe.exec(yml))) {
    const start = m.index;
    const next = yml.slice(start + m[0].length).search(/^\s+- (?:name:|uses:|run:)/m);
    const chunk = next === -1 ? yml.slice(start) : yml.slice(start, start + m[0].length + next);
    steps.push(chunk);
  }
  assert.ok(steps.length >= 4, "expected checkout, node, install, test, secrets");
  for (const step of steps) {
    assert.match(
      step,
      /^\s+- uses:|^\s+- run:|\n\s+uses:|\n\s+run:/m,
      `step is missing run or uses:\n${step.slice(0, 160)}`
    );
  }
  assert.doesNotMatch(yml, /Placeholder for CSS\/HTML lint/);
  assert.doesNotMatch(yml, /git diff --cached/);
  assert.match(yml, /node-version:\s*"22"/);
  assert.doesNotMatch(yml, /node-version:\s*"20"/);
});

test("secret scanner is clean on this checkout", () => {
  assert.deepEqual(scan({ cwd: ROOT }), []);
});

test("secret scanner flags committed secret files and token-shaped values", () => {
  assert.equal(inspect("data/tape.secret")[0].reason, "secret-filename");
  assert.equal(inspect(".env")[0].reason, "secret-filename");
  assert.equal(
    inspect("lib/core.js", "const t = \"ghp_" + "A".repeat(36) + "\";")[0].reason,
    "github-token"
  );
  assert.equal(
    inspect("README.md", "TAPE_SECRET=$(openssl rand -hex 32)").length,
    0,
    "docs that name TAPE_SECRET must not fail CI"
  );
});
