"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveSecret } = require("../server/secret");

test("reuses the same tape secret from disk so Options does not have to chase a new hash", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-secret-"));
  const filePath = path.join(dir, "tape.secret");
  const first = resolveSecret({ env: {}, filePath });
  const second = resolveSecret({ env: {}, filePath });
  assert.equal(first.source, "generated");
  assert.equal(second.source, "file");
  assert.equal(first.secret, second.secret);
  assert.match(first.secret, /^[a-f0-9]{32}$/);
});

test("env TAPE_SECRET wins and is written to the file for the next boot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-secret-"));
  const filePath = path.join(dir, "tape.secret");
  const first = resolveSecret({ env: { TAPE_SECRET: "from-options" }, filePath });
  assert.equal(first.secret, "from-options");
  assert.equal(first.source, "env");
  const second = resolveSecret({ env: {}, filePath });
  assert.equal(second.secret, "from-options");
});
