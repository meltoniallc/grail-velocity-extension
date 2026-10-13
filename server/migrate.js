"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS_DIR = path.join(__dirname, "..", "db", "migrations");

async function vectorAvailable(pool) {
  const { rows } = await pool.query(
    "SELECT 1 AS ok FROM pg_available_extensions WHERE name = 'vector' LIMIT 1",
  );
  return rows.length > 0;
}

async function appliedVersions(pool) {
  const { rows } = await pool.query("SELECT version FROM schema_migrations");
  return new Set(rows.map((row) => String(row.version)));
}

async function applyMigrations(pool, opts = {}) {
  const dir = opts.dir || MIGRATIONS_DIR;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  );
  const files = fs
    .readdirSync(dir)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  const have = await appliedVersions(pool);
  const applied = [];
  const skipped = [];
  for (const file of files) {
    const version = file.match(/^(\d+)/)[1];
    if (have.has(version)) continue;
    if (file.startsWith("002")) {
      const ready = await vectorAvailable(pool);
      if (!ready) {
        skipped.push(file);
        continue;
      }
    }
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING", [
        version,
      ]);
      applied.push(file);
    } catch (err) {
      if (file.startsWith("002")) {
        skipped.push(file);
        continue;
      }
      throw err;
    }
  }
  return { applied, skipped };
}

module.exports = { applyMigrations, vectorAvailable, MIGRATIONS_DIR };
