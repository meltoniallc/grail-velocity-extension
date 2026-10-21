"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");

function run(script, args) {
  return spawnSync("python3", [path.join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function field(stdout, name) {
  const match = stdout.match(new RegExp(`^${name}=(.+)$`, "m"));
  assert.ok(match, stdout);
  return match[1];
}

test("cardsight dry-run prints counts and does not create a database", () => {
  const result = run("load_cardsight.py", []);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(field(result.stdout, "in"), "5");
  assert.equal(field(result.stdout, "matched"), "3");
  assert.equal(field(result.stdout, "unmatched"), "2");
  assert.equal(field(result.stdout, "duplicates"), "1");
  assert.equal(field(result.stdout, "dry_run"), "true");
  assert.equal(run("load_cardsight.py", ["--commit"]).status, 2);
});

test("cardsight commit is idempotent and flags print-to-order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-cardsight-"));
  const sqlite = path.join(dir, "cardsight.sqlite");
  const first = run("load_cardsight.py", ["--commit", "--sqlite", sqlite]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(field(first.stdout, "inserted"), "4");
  assert.equal(field(first.stdout, "dry_run"), "false");
  const db = new DatabaseSync(sqlite);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comps").get().n, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cards").get().n, 3);
  const now = db.prepare("SELECT is_print_to_order FROM cards WHERE set_name = ?").get("Topps Now");
  assert.equal(now.is_print_to_order, 1);
  const second = run("load_cardsight.py", ["--commit", "--sqlite", sqlite]);
  assert.equal(field(second.stdout, "duplicates"), "5");
  assert.equal(field(second.stdout, "inserted"), "0");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comps").get().n, 4);
});

test("mascot CSV stub is read-only", () => {
  const result = run("load_mascot.py", []);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(field(result.stdout, "in"), "2");
  assert.equal(field(result.stdout, "mapped"), "1");
  assert.equal(field(result.stdout, "missing_sku"), "1");
  assert.equal(field(result.stdout, "read_only"), "true");
  const refused = run("load_mascot.py", ["--commit"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /read-only/);
  const source = fs.readFileSync(path.join(ROOT, "scripts", "load_mascot.py"), "utf8");
  assert.doesNotMatch(source, /sqlite3|urllib|requests/);
});
