"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeCtx() {
  const ctx = { console };
  ctx.self = ctx;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return ctx;
}

function loadScript(relPath, existing) {
  const ctx = existing || makeCtx();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", relPath), "utf8"), ctx);
  return ctx;
}

function loadScripts(relPaths) {
  const ctx = makeCtx();
  for (const relPath of relPaths) loadScript(relPath, ctx);
  return ctx;
}

module.exports = { loadScript, loadScripts };
