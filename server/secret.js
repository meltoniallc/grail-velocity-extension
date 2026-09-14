"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function resolveSecret(opts) {
  const env = (opts && opts.env) || process.env;
  const filePath = (opts && opts.filePath) || path.join(__dirname, "..", "data", "tape.secret");
  const fromEnv = String(env.TAPE_SECRET || "").trim();
  if (fromEnv) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${fromEnv}\n`, { encoding: "utf8" });
    return { secret: fromEnv, source: "env", filePath };
  }
  try {
    const fromFile = fs.readFileSync(filePath, "utf8").trim();
    if (fromFile) return { secret: fromFile, source: "file", filePath };
  } catch {
    /* first boot */
  }
  const generated = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${generated}\n`, { encoding: "utf8" });
  return { secret: generated, source: "generated", filePath };
}

module.exports = { resolveSecret };
