"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const SECRET_FILES =
  /(^|\/)(\.env|tape\.secret|id_rsa|id_ed25519)(\.|$)|(^|\/)[^/]+\.pem$/i;

const PATTERNS = [
  { name: "private-key", re: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/ },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
];

function trackedFiles(cwd) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "buffer" });
  return out
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function inspect(rel, text) {
  const findings = [];
  const norm = String(rel || "").replace(/\\/g, "/");
  if (SECRET_FILES.test(norm)) {
    findings.push({ file: norm, reason: "secret-filename" });
    return findings;
  }
  if (!text) return findings;
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) findings.push({ file: norm, reason: name });
  }
  return findings;
}

function scan(opts = {}) {
  const cwd = opts.cwd || ROOT;
  const files = opts.files || trackedFiles(cwd);
  const findings = [];
  for (const rel of files) {
    const norm = rel.replace(/\\/g, "/");
    if (/\.(png|jpg|jpeg|gif|webp|zip|woff2?)$/i.test(norm)) continue;
    const fileFindings = inspect(norm, null);
    if (fileFindings.some((f) => f.reason === "secret-filename")) {
      findings.push(...fileFindings);
      continue;
    }
    let text = opts.contents && Object.prototype.hasOwnProperty.call(opts.contents, rel)
      ? opts.contents[rel]
      : null;
    if (text == null) {
      try {
        text = fs.readFileSync(path.join(cwd, rel), "utf8");
      } catch {
        continue;
      }
    }
    findings.push(...inspect(norm, text));
  }
  return findings;
}

function main() {
  const findings = scan();
  if (findings.length) {
    for (const f of findings) {
      console.error(`${f.file}: ${f.reason}`);
    }
    process.exit(1);
  }
  console.log("no committed secrets");
}

if (require.main === module) {
  main();
}

module.exports = { inspect, scan, SECRET_FILES, PATTERNS };
