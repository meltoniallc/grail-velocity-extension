#!/usr/bin/env node
"use strict";

// Side-load the unpacked Grail Velocity extension into Google Chrome for local
// testing.
//
// Branded Chrome 137+ removed the `--load-extension` command-line flag, so the
// only supported way to load an unpacked extension from the CLI is the
// DevTools `Extensions.loadUnpacked` method, which requires the CDP *pipe*
// transport plus `--enable-unsafe-extension-debugging`. Extensions also refuse
// to load in `--headless` mode, so we run headed against an X display (Xvfb is
// started automatically when no DISPLAY is present).
//
// Usage:
//   node scripts/load-extension.js                 # load + screenshot the popup
//   node scripts/load-extension.js --page options  # screenshot the options page
//   node scripts/load-extension.js --page sidepanel
//   node scripts/load-extension.js --page chrome-extension://<id>/popup/index.html
//   node scripts/load-extension.js --out /tmp/popup.png --type Wembanyama
//   node scripts/load-extension.js --keep-open      # leave Chrome running, print the id
//
// Flags:
//   --page <popup|options|sidepanel|URL>  page to open (default: popup)
//   --out <file.png>                      screenshot destination (default: /tmp/gv-<page>.png)
//   --type <text>                         type <text> into the popup search box first
//   --keep-open                           load the extension and keep Chrome alive
//   --width <n> --height <n>              screenshot viewport (default 380x620)
//   --display <:N>                        X display to use (default: existing DISPLAY or :99)
//   --user-data-dir <dir>                 Chrome profile dir (default: /tmp/gv-chrome-devtest)

const { spawn, spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const EXT_DIR = path.resolve(__dirname, "..");

const USAGE = `Side-load the unpacked Grail Velocity extension into Chrome for local testing.

Usage:
  node scripts/load-extension.js [flags]

Flags:
  --page <popup|options|sidepanel|URL>  page to open (default: popup)
  --out <file.png>                      screenshot destination (default: /tmp/gv-<page>.png)
  --type <text>                         type <text> into the popup search box first
  --keep-open                           load the extension and keep Chrome running
  --width <n> --height <n>              screenshot viewport (default 380x620)
  --display <:N>                        X display to use (default: $DISPLAY or :99)
  --user-data-dir <dir>                 Chrome profile dir (default: /tmp/gv-chrome-devtest)
  -h, --help                            show this help`;

function parseArgs(argv) {
  const opts = {
    page: "popup",
    out: null,
    type: "",
    keepOpen: false,
    width: 380,
    height: 620,
    display: process.env.DISPLAY || ":99",
    userDataDir: "/tmp/gv-chrome-devtest",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--page": opts.page = next(); break;
      case "--out": opts.out = next(); break;
      case "--type": opts.type = next(); break;
      case "--keep-open": opts.keepOpen = true; break;
      case "--width": opts.width = Number(next()); break;
      case "--height": opts.height = Number(next()); break;
      case "--display": opts.display = next(); break;
      case "--user-data-dir": opts.userDataDir = next(); break;
      case "--help": case "-h": opts.help = true; break;
      default: throw new Error(`unknown flag: ${a}`);
    }
  }
  return opts;
}

function findChrome() {
  if (process.env.GV_CHROME) return process.env.GV_CHROME;
  const candidates = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/local/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("could not find a Chrome/Chromium binary (set GV_CHROME)");
}

// Ensure an X display exists (extensions can't load in headless Chrome). Starts
// Xvfb on the requested display when nothing is listening there yet.
function ensureDisplay(display) {
  const num = display.replace(":", "");
  const sockets = [`/tmp/.X11-unix/X${num}`];
  if (sockets.some((s) => existsSync(s))) return null;
  const xvfb = spawnSync("which", ["Xvfb"], { encoding: "utf8" });
  if (xvfb.status !== 0) {
    throw new Error(
      `no X display at ${display} and Xvfb is not installed; ` +
        "start a display or set --display to an existing one",
    );
  }
  const proc = spawn("Xvfb", [display, "-screen", "0", "1280x900x24"], {
    stdio: "ignore",
    detached: false,
  });
  return proc;
}

// Minimal CDP client over the Chrome pipe transport (fd3 in, fd4 out). Messages
// are NUL-delimited JSON. Supports flattened target sessions via `sessionId`.
class PipeCDP {
  constructor(inPipe, outPipe) {
    this.inPipe = inPipe;
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    outPipe.on("data", (chunk) => this._onData(chunk));
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let idx;
    while ((idx = this.buf.indexOf(0)) !== -1) {
      const raw = this.buf.subarray(0, idx).toString("utf8");
      this.buf = this.buf.subarray(idx + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.method + ": " + JSON.stringify(msg.error))) : resolve(msg.result);
      }
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.inPipe.write(JSON.stringify(payload) + "\0");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("timeout: " + method));
        }
      }, 20000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolvePageUrl(page, id) {
  switch (page) {
    case "popup": return `chrome-extension://${id}/popup/index.html`;
    case "options": return `chrome-extension://${id}/options/index.html`;
    case "sidepanel": return `chrome-extension://${id}/sidepanel/index.html`;
    default: return page; // treat as a full URL
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const chromeBin = findChrome();
  const xvfb = ensureDisplay(opts.display);
  if (xvfb) await sleep(800);

  const chrome = spawn(chromeBin, [
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    `--user-data-dir=${opts.userDataDir}`,
    "about:blank",
  ], {
    env: { ...process.env, DISPLAY: opts.display },
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });

  const cdp = new PipeCDP(chrome.stdio[3], chrome.stdio[4]);
  const cleanup = () => {
    try { chrome.kill(); } catch {}
    if (xvfb) try { xvfb.kill(); } catch {}
  };

  await sleep(1200);
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: EXT_DIR });
  process.stdout.write(`extension loaded: ${id}\n`);

  if (opts.keepOpen) {
    process.stdout.write(
      `Chrome is running (DISPLAY=${opts.display}). Popup: ` +
        `chrome-extension://${id}/popup/index.html\nPress Ctrl-C to stop.\n`,
    );
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
    await new Promise(() => {}); // keep alive until signalled
    return;
  }

  const url = resolvePageUrl(opts.page, id);
  const out = opts.out || `/tmp/gv-${opts.page.replace(/[^a-z0-9]+/gi, "-")}.png`;
  mkdirSync(path.dirname(out), { recursive: true });

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: opts.width, height: opts.height, deviceScaleFactor: 2, mobile: false,
  }, sessionId);
  await cdp.send("Page.navigate", { url }, sessionId);
  await sleep(1600);

  if (opts.type) {
    await cdp.send("Runtime.evaluate", {
      expression: `(async()=>{const el=document.getElementById('q');if(!el)return;el.focus();const t=${JSON.stringify(opts.type)};el.value='';for(let i=0;i<t.length;i++){el.value=t.slice(0,i+1);el.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,120));}})()`,
      awaitPromise: true,
    }, sessionId);
    await sleep(600);
  }

  const facts = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify({title:document.title,h1:(document.querySelector('h1')||{}).textContent,cuts:document.querySelectorAll('#cuts li').length,suggest:document.querySelectorAll('#suggest li').length})`,
    returnByValue: true,
  }, sessionId);

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  process.stdout.write(`facts: ${facts.result.value}\n`);
  process.stdout.write(`screenshot: ${out}\n`);
  cleanup();
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`load-extension failed: ${err.message}\n`);
  process.exit(1);
});
