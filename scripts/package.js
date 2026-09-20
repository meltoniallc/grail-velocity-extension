"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist");
const STAGE = path.join(OUT_DIR, "grail-velocity");
const ZIP = path.join(OUT_DIR, "grail-velocity-extension.zip");

/** Runtime files required to load-unpacked per INSTALL / manifest. */
const INCLUDE = [
  "manifest.json",
  "background.js",
  "catalog.json",
  "lib/core.js",
  "lib/tape.js",
  "content/ebay.js",
  "content/overlay.css",
  "popup/index.html",
  "popup/popup.css",
  "popup/popup.js",
  "options/index.html",
  "options/options.js",
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

function packageExtension() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(ZIP, { force: true });

  const entries = [];
  for (const rel of INCLUDE) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) {
      throw new Error(`missing package input: ${rel}`);
    }
    const dest = path.join(STAGE, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    entries.push({
      name: `grail-velocity/${rel.replace(/\\/g, "/")}`,
      data: fs.readFileSync(src),
    });
  }

  writeZip(ZIP, entries);
  return { zipPath: ZIP, include: INCLUDE.slice() };
}

if (require.main === module) {
  const result = packageExtension();
  console.log(result.zipPath);
}

module.exports = {
  INCLUDE,
  ZIP,
  STAGE,
  OUT_DIR,
  packageExtension,
  listZipNames,
  readZipEntry,
};
