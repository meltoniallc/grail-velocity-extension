"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { loadScripts } = require("./load-core");

const { GV } = loadScripts(["lib/core.js"]);

function waitPort(child) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += String(chunk);
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        child.stderr.off("data", onData);
        resolve(Number(m[1]));
      }
    };
    child.stderr.on("data", onData);
    child.once("exit", (code) => reject(new Error("tape server exited " + code + "\n" + buf)));
    setTimeout(() => reject(new Error("tape server did not start\n" + buf)), 5000);
  });
}

test("tape server parks noise in sqlite and does not require postgres", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-tape-http-"));
  const sqlite = path.join(dir, "scratch.sqlite");
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], {
    env: { ...process.env, PORT: "0", SQLITE_PATH: sqlite, TAPE_SECRET: "test-secret" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const port = await waitPort(child);
    const query = "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 74/99";
    const verified = GV.verifyComps(query, [
      { id: "a", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 11/99", price: 120 },
      { id: "b", title: "2023-24 Topps Mercury Victor Wembanyama #5 Refractor 22/99", price: 110 },
      { id: "c", title: "2023 Panini Prizm Victor Wembanyama #5 Silver", price: 4.99 },
    ]);
    const kept = verified.rows.filter((r) => r.keep);
    const dropped = verified.rows.filter((r) => !r.keep);
    const res = await fetch(`http://127.0.0.1:${port}/tape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tape-Secret": "test-secret" },
      body: JSON.stringify({
        snapshot: {
          query,
          queryNorm: GV.fold(query),
          comps: kept,
          nKept: kept.length,
          nRaw: verified.nRaw,
          nCliff: verified.nCliff,
          fastCash: 107.8,
        },
        scratch: { query, queryNorm: GV.fold(query), listings: dropped },
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.scratch, "sqlite");
    assert.equal(body.postgres.skipped, "no-postgres");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(sqlite);
    const rows = db.prepare("SELECT title FROM raw_listings").all();
    assert.ok(rows.some((r) => /Prizm/i.test(r.title)));
    assert.equal(
      rows.some((r) => /Mercury Victor Wembanyama #5 Refractor 11\/99/i.test(r.title)),
      false,
    );
  } finally {
    child.kill();
  }
});
