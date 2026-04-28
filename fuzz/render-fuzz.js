#!/usr/bin/env node
// Browser-stage fuzz harness. Spawns Chromium via Playwright, loads the
// renderer in a real DOM, and feeds it mutated PDFs via a base64 data URL.
// Detects render hangs (wall-clock timeout), thrown render errors, and page
// errors (uncaught exceptions, console errors). Saves minimized artifacts.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(rootDir, "fixtures");
const artifactsDir = path.join(rootDir, "fuzz", "artifacts-render");

const args = parseArgs(process.argv.slice(2));
const seed = Number(args.seed || Date.now());
const rng = mulberry32(seed >>> 0);
const cases = Number(args.cases || 200);
const timeoutMs = Number(args.timeout || 4000);
const headed = Boolean(args.headed);

const seeds = await loadSeeds();
if (!seeds.length) throw new Error("No fixture PDF seeds found.");

// Static server rooted at the project so the harness page can import the
// renderer module via /src/pdf-lite/index.js.
const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const filePath = urlPath === "/"
      ? path.join(rootDir, "fuzz", "render-harness.html")
      : path.join(rootDir, urlPath.replace(/^\//, ""));
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403); res.end(); return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const harnessUrl = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext();
let page = await context.newPage();

const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err?.message || err)));
page.on("crash", () => pageErrors.push("page crashed"));

await page.goto(harnessUrl);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });

console.log(`pdf-crumb render fuzz: ${cases} cases, seed ${seed}, timeout ${timeoutMs}ms`);

let parsed = 0, rejected = 0, timedOut = 0, crashed = 0;
const unexpected = [];

for (let index = 0; index < cases; index += 1) {
  const seed = pick(seeds, rng);
  const bytes = mutate(seed.bytes, rng);
  pageErrors.length = 0;
  const result = await runCase(bytes);

  if (pageErrors.length) {
    crashed += 1;
    unexpected.push({ index, seed: seed.name, reason: `pageerror: ${pageErrors[0]}` });
    await saveArtifact(index, seed.name, bytes, "pageerror");
  } else if (result.status === "ok") {
    parsed += 1;
  } else if (result.status === "rejected") {
    rejected += 1;
  } else if (result.status === "timeout") {
    timedOut += 1;
    unexpected.push({ index, seed: seed.name, reason: "timeout" });
    await saveArtifact(index, seed.name, bytes, "timeout");
    // Reload after a hang because the page is in an unknown state.
    await safeReload();
  } else {
    unexpected.push({ index, seed: seed.name, reason: result.message || result.status });
    await saveArtifact(index, seed.name, bytes, "unexpected");
  }

  if ((index + 1) % 25 === 0 || index + 1 === cases) {
    console.log(`${index + 1}/${cases} ok=${parsed} rejected=${rejected} timeout=${timedOut} pageerror=${crashed}`);
  }
}

console.log(`done: ok=${parsed} rejected=${rejected} timeout=${timedOut} pageerror=${crashed}`);
if (unexpected.length) {
  console.error("unexpected outcomes:");
  for (const item of unexpected.slice(0, 20)) {
    console.error(`case ${item.index} from ${item.seed}: ${item.reason}`);
  }
  process.exitCode = 1;
}

await browser.close();
server.close();

async function runCase(bytes) {
  const base64 = Buffer.from(bytes).toString("base64");
  try {
    const result = await Promise.race([
      page.evaluate(async (b64) => {
        try {
          const out = await window.__renderCase(b64);
          return { status: "ok", ...out };
        } catch (error) {
          return { status: "rejected", message: String(error?.message || error) };
        }
      }, base64),
      new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), timeoutMs)),
    ]);
    return result;
  } catch (error) {
    return { status: "evaluate-error", message: String(error?.message || error) };
  }
}

async function safeReload() {
  try {
    await page.goto(harnessUrl, { timeout: 5000 });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
  } catch {
    // If reload fails, swap the page entirely.
    try { await page.close(); } catch {}
    const fresh = await context.newPage();
    fresh.on("pageerror", (err) => pageErrors.push(String(err?.message || err)));
    fresh.on("crash", () => pageErrors.push("page crashed"));
    await fresh.goto(harnessUrl);
    await fresh.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
    page = fresh;
  }
}

async function loadSeeds() {
  const entries = await readdir(fixturesDir, { withFileTypes: true });
  const pdfs = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")).map((entry) => entry.name).sort();
  return Promise.all(pdfs.map(async (name) => ({ name, bytes: new Uint8Array(await readFile(path.join(fixturesDir, name))) })));
}

async function saveArtifact(index, seedName, bytes, reason) {
  if (bytes.byteLength > 1024 * 1024) return;
  await mkdir(artifactsDir, { recursive: true });
  const safeSeed = seedName.replace(/[^a-z0-9._-]+/gi, "_");
  const file = path.join(artifactsDir, `${String(index).padStart(5, "0")}-${reason}-${safeSeed}`);
  await writeFile(file, bytes);
}

// --- minimal mutation set (subset of pdf-fuzz.js) ---------------------------
function mutate(input, rng) {
  let bytes = new Uint8Array(input);
  const ops = 1 + Math.floor(rng() * 8);
  for (let i = 0; i < ops; i += 1) bytes = applyMutation(bytes, rng);
  return bytes;
}

function applyMutation(input, rng) {
  const op = Math.floor(rng() * 8);
  const bytes = new Uint8Array(input);
  if (!bytes.length) return bytes;
  if (op === 0) return bytes.slice(0, Math.floor(rng() * bytes.length));
  if (op === 1) return bytes.slice(Math.floor(rng() * bytes.length));
  if (op === 2) {
    const out = new Uint8Array(bytes);
    for (let k = 0; k < 16; k += 1) out[Math.floor(rng() * out.length)] ^= 1 << Math.floor(rng() * 8);
    return out;
  }
  if (op === 3) {
    const start = Math.floor(rng() * bytes.length);
    const len = Math.floor(rng() * 256);
    const insert = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) insert[i] = Math.floor(rng() * 256);
    const out = new Uint8Array(bytes.length + insert.length);
    out.set(bytes.slice(0, start), 0);
    out.set(insert, start);
    out.set(bytes.slice(start), start + insert.length);
    return out;
  }
  if (op === 4) {
    const source = Buffer.from(bytes).toString("latin1");
    const matches = Array.from(source.matchAll(/\b\d{1,8}\b/g)).slice(0, 256);
    if (!matches.length) return bytes;
    const m = matches[Math.floor(rng() * matches.length)];
    const replacement = String([0, 1, -1, 99999999, 2147483647, Math.floor(rng() * 1_000_000)][Math.floor(rng() * 6)]);
    return spliceReplace(bytes, m.index, m[0].length, Buffer.from(replacement, "latin1"));
  }
  if (op === 5) {
    const source = Buffer.from(bytes).toString("latin1");
    const m = /\/MediaBox\s*\[[^\]]{0,200}\]/.exec(source);
    if (!m) return bytes;
    const choices = ["/MediaBox [0 0 999999 999999]", "/MediaBox [-1 -1 1 1]", "/MediaBox []", "/MediaBox [0 0 0 0]"];
    return spliceReplace(bytes, m.index, m[0].length, Buffer.from(choices[Math.floor(rng() * choices.length)], "latin1"));
  }
  if (op === 6) {
    // Inflate a content stream operator string with absurd values.
    const source = Buffer.from(bytes).toString("latin1");
    const m = /stream\n([\s\S]{0,4096}?)endstream/.exec(source);
    if (!m) return bytes;
    const ops = ["1 0 0 1 999999 999999 cm\n", "999 Tz\n", "[(AAAA) -999999 (BBB)] TJ\n", "999999 999999 m\n"];
    const inject = ops[Math.floor(rng() * ops.length)].repeat(8);
    return spliceReplace(bytes, m.index + 7, 0, Buffer.from(inject, "latin1"));
  }
  return bytes;
}

function spliceReplace(bytes, start, length, replacement) {
  const end = Math.min(bytes.length, start + length);
  const output = new Uint8Array(bytes.length - (end - start) + replacement.length);
  output.set(bytes.slice(0, start), 0);
  output.set(replacement, start);
  output.set(bytes.slice(end), start + replacement.length);
  return output;
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function pick(items, rng) { return items[Math.floor(rng() * items.length)]; }

function mulberry32(seed) {
  return function next() {
    let v = (seed += 0x6d2b79f5);
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=", 2);
    parsed[k] = v ?? true;
  }
  return parsed;
}
