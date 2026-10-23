"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist");
const STAGE = path.join(OUT_DIR, "grail-velocity");
const ZIP = path.join(OUT_DIR, "grail-velocity-2.1.0-meltonia.zip");
const DEFAULTS_REL = "lib/meltonia-defaults.js";
const DEFAULT_TAPE_API = "https://tape-production-2810.up.railway.app";

/** Runtime files required to load-unpacked per INSTALL / manifest. */
const INCLUDE = [
  "manifest.json",
  "background.js",
  "catalog.json",
  "lib/core.js",
  "lib/meltonia-defaults.js",
  "lib/tape.js",
  "lib/overlay.js",
  "lib/suggest.js",
  "lib/sync.js",
  "lib/cardfields.js",
  "lib/observe.js",
  "lib/outbox.js",
  "lib/capture-runtime.js",
  "content/ebay.js",
  "content/capture.js",
  "content/overlay.css",
  "content/parsers/common.js",
  "content/parsers/cards.js",
  "content/parsers/ebay-item.js",
  "content/parsers/ebay-sold-search.js",
  "content/parsers/ebay-active-search.js",
  "popup/index.html",
  "popup/popup.css",
  "popup/popup.js",
  "options/index.html",
  "options/options.css",
  "options/options.js",
  "fonts/bebas-neue-latin-400.woff2",
  "fonts/assistant-latin-400.woff2",
  "fonts/assistant-latin-600.woff2",
  "fonts/dm-mono-latin-400.woff2",
  "sidepanel/index.html",
  "sidepanel/sidepanel.css",
  "sidepanel/sidepanel.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/** Pure-Node ZIP (deflate) — no OS zip/unzip binaries. */
function writeZip(zipPath, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(8),
      u16(0),
      u16(0),
      u32(crc),
      u32(compressed.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      compressed,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(8),
      u16(0),
      u16(0),
      u32(crc),
      u32(compressed.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralDir = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);

  fs.writeFileSync(zipPath, Buffer.concat([...locals, centralDir, end]));
}

function listZipNames(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const names = [];
  let i = 0;
  while (i + 30 <= buf.length) {
    const sig = buf.readUInt32LE(i);
    if (sig === 0x04034b50) {
      const method = buf.readUInt16LE(i + 8);
      const compSize = buf.readUInt32LE(i + 18);
      const nameLen = buf.readUInt16LE(i + 26);
      const extraLen = buf.readUInt16LE(i + 28);
      const name = buf.slice(i + 30, i + 30 + nameLen).toString("utf8");
      names.push(name);
      i += 30 + nameLen + extraLen + compSize;
      if (method !== 0 && method !== 8) {
        throw new Error(`unsupported zip method ${method} for ${name}`);
      }
      continue;
    }
    if (sig === 0x02014b50 || sig === 0x06054b50) break;
    break;
  }
  return names;
}

function readZipEntry(zipPath, entryName) {
  const buf = fs.readFileSync(zipPath);
  let i = 0;
  while (i + 30 <= buf.length) {
    const sig = buf.readUInt32LE(i);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const uncompSize = buf.readUInt32LE(i + 22);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString("utf8");
    const dataStart = i + 30 + nameLen + extraLen;
    const data = buf.slice(dataStart, dataStart + compSize);
    i = dataStart + compSize;
    if (name !== entryName) continue;
    if (method === 0) return data.slice(0, uncompSize);
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error(`unsupported zip method ${method}`);
  }
  throw new Error(`zip entry not found: ${entryName}`);
}

/**
 * Bake Meltonia Tape URL + secret into the zip only (not back into git).
 * MELTONIA_TAPE_SECRET (or TAPE_SECRET) required when MELTONIA_PACKAGE_STRICT=1.
 */
function resolveMeltoniaBake(env = process.env) {
  const tapeApi = String(env.MELTONIA_TAPE_API || DEFAULT_TAPE_API)
    .trim()
    .replace(/\/+$/, "");
  const tapeSecret = String(env.MELTONIA_TAPE_SECRET || env.TAPE_SECRET || "").trim();
  const strict =
    String(env.MELTONIA_PACKAGE_STRICT || "").trim() === "1" ||
    String(env.MELTONIA_PACKAGE_STRICT || "").toLowerCase() === "true";
  if (strict && !tapeSecret) {
    throw new Error(
      "MELTONIA_PACKAGE_STRICT requires MELTONIA_TAPE_SECRET (Railway tape service secret). Do not commit it.",
    );
  }
  return { tapeApi, tapeSecret, strict };
}

function renderMeltoniaDefaultsSource({ tapeApi, tapeSecret }) {
  return `"use strict";

/**
 * Generated for the private Meltonia zip — do not commit live secrets.
 * Agents set MELTONIA_TAPE_SECRET at package time; Railway holds the same value.
 */
(function (global) {
  const GV = global.GV || (global.GV = {});
  const TAPE_API = ${JSON.stringify(tapeApi)};

  GV.MELTONIA_TAPE_DEFAULTS = {
    tapeApi: TAPE_API,
    tapeSecret: ${JSON.stringify(tapeSecret)},
  };

  GV.meltoniaTapeDefaults = function meltoniaTapeDefaults() {
    const d = GV.MELTONIA_TAPE_DEFAULTS || {};
    return {
      tapeApi: String(d.tapeApi || TAPE_API).replace(new RegExp("/+$"), ""),
      tapeSecret: String(d.tapeSecret || ""),
    };
  };

  GV.seedMeltoniaTapeDefaults = async function seedMeltoniaTapeDefaults(storage, opts) {
    const force = Boolean(opts && opts.force);
    const d = GV.meltoniaTapeDefaults();
    if (!d.tapeApi) return { ok: false, skipped: "no-defaults" };
    const cur = await storage.get(["tapeApi", "tapeSecret"]);
    const patch = {};
    const haveApi = String(cur.tapeApi || "").trim();
    const haveSecret = String(cur.tapeSecret || "").trim();
    if (force || !haveApi) patch.tapeApi = d.tapeApi;
    if (d.tapeSecret && (force || !haveSecret)) patch.tapeSecret = d.tapeSecret;
    if (!Object.keys(patch).length) return { ok: true, seeded: false };
    await storage.set(patch);
    return { ok: true, seeded: true, keys: Object.keys(patch) };
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
`;
}

function packageExtension(opts = {}) {
  const env = opts.env || process.env;
  const bake = resolveMeltoniaBake(env);
  const defaultsSource = renderMeltoniaDefaultsSource(bake);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(ZIP, { force: true });

  const entries = [];
  for (const rel of INCLUDE) {
    const dest = path.join(STAGE, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let data;
    if (rel === DEFAULTS_REL) {
      data = Buffer.from(defaultsSource, "utf8");
      fs.writeFileSync(dest, data);
    } else {
      const src = path.join(ROOT, rel);
      if (!fs.existsSync(src)) {
        throw new Error(`missing package input: ${rel}`);
      }
      fs.copyFileSync(src, dest);
      data = fs.readFileSync(src);
    }
    entries.push({
      name: `grail-velocity/${rel.replace(/\\/g, "/")}`,
      data,
    });
  }

  writeZip(ZIP, entries);
  return {
    zipPath: ZIP,
    include: INCLUDE.slice(),
    baked: { tapeApi: bake.tapeApi, hasSecret: Boolean(bake.tapeSecret) },
  };
}

if (require.main === module) {
  const result = packageExtension();
  console.log(result.zipPath);
  console.log(
    result.baked.hasSecret
      ? `baked Tape ${result.baked.tapeApi} (secret yes)`
      : `baked Tape ${result.baked.tapeApi} (secret empty — set MELTONIA_TAPE_SECRET for Meltonia handoff)`,
  );
}

module.exports = {
  INCLUDE,
  ZIP,
  STAGE,
  OUT_DIR,
  DEFAULT_TAPE_API,
  packageExtension,
  resolveMeltoniaBake,
  renderMeltoniaDefaultsSource,
  listZipNames,
  readZipEntry,
};
