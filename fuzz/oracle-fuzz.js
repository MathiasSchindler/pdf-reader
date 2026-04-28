#!/usr/bin/env node
// Cross-validation oracle. Feeds each mutated PDF to both pdf-crumb and
// PDF.js (parse stage). Flags inputs where the two disagree on accept/reject
// or on page count. Surfaces semantic divergences rather than crashes — these
// are useful both as bugs in our parser and as parser-confusion candidates we
// want to handle the same way as a reference implementation does.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(rootDir, "fixtures");
const artifactsDir = path.join(rootDir, "fuzz", "artifacts-oracle");

const args = parseArgs(process.argv.slice(2));
const seed = Number(args.seed || Date.now());
const rng = mulberry32(seed >>> 0);
const cases = Number(args.cases || 200);
const timeoutMs = Number(args.timeout || 6000);
const headed = Boolean(args.headed);
const verbose = Boolean(args.verbose);

const seeds = await loadSeeds();
if (!seeds.length) throw new Error("No fixture PDF seeds found.");

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const filePath = urlPath === "/"
      ? path.join(rootDir, "fuzz", "oracle-harness.html")
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
await page.goto(harnessUrl);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });

console.log(`pdf-crumb oracle: ${cases} cases, seed ${seed}, timeout ${timeoutMs}ms`);

let agree = 0;
let disagreeAccept = 0; // ours ok, theirs rejected (or vice versa)
let disagreePages = 0; // both ok, different page counts
let bothRejected = 0;
let timedOut = 0;
const findings = [];

for (let index = 0; index < cases; index += 1) {
  const seedFile = pick(seeds, rng);
  const bytes = mutate(seedFile.bytes, rng);
  const result = await runCase(bytes);

  if (result.status === "timeout") {
    timedOut += 1;
    await saveArtifact(index, seedFile.name, bytes, "timeout");
    await safeReload();
    continue;
  }

  const { ours, theirs } = result;
  if (ours.status === "rejected" && theirs.status === "rejected") {
    bothRejected += 1;
  } else if (ours.status !== theirs.status) {
    disagreeAccept += 1;
    findings.push({ index, seed: seedFile.name, kind: "accept-mismatch", ours: ours.status, theirs: theirs.status, oursMsg: ours.message, theirsMsg: theirs.message });
    await saveArtifact(index, seedFile.name, bytes, "accept-mismatch");
  } else if (ours.status === "ok" && theirs.status === "ok") {
    if (ours.pages !== theirs.pages) {
      disagreePages += 1;
      findings.push({ index, seed: seedFile.name, kind: "page-mismatch", ours: ours.pages, theirs: theirs.pages });
      await saveArtifact(index, seedFile.name, bytes, "page-mismatch");
    } else {
      agree += 1;
    }
  }

  if (verbose && findings.length && findings[findings.length - 1].index === index) {
    console.log("finding:", findings[findings.length - 1]);
  }

  if ((index + 1) % 25 === 0 || index + 1 === cases) {
    console.log(
      `${index + 1}/${cases} agree=${agree} bothRej=${bothRejected} ` +
        `acceptMismatch=${disagreeAccept} pageMismatch=${disagreePages} timeout=${timedOut}`
    );
  }
}

console.log(`done: agree=${agree} bothRejected=${bothRejected} acceptMismatch=${disagreeAccept} pageMismatch=${disagreePages} timeout=${timedOut}`);

if (findings.length) {
  console.log(`first ${Math.min(findings.length, 10)} findings:`);
  for (const f of findings.slice(0, 10)) {
    console.log(`  case ${f.index} from ${f.seed}: ${f.kind} ${JSON.stringify({ ours: f.ours, theirs: f.theirs, oursMsg: f.oursMsg, theirsMsg: f.theirsMsg }).slice(0, 200)}`);
  }
}

await browser.close();
server.close();

async function runCase(bytes) {
  const base64 = Buffer.from(bytes).toString("base64");
  try {
    const result = await Promise.race([
      page.evaluate(async (b64) => window.__oracleCase(b64), base64),
      new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), timeoutMs)),
    ]);
    if (result?.status === "timeout") return { status: "timeout" };
    return { status: "complete", ours: result.ours, theirs: result.theirs };
  } catch (error) {
    return { status: "complete", ours: { status: "rejected", message: String(error?.message || error) }, theirs: { status: "rejected", message: "harness-error" } };
  }
}

async function safeReload() {
  try {
    await page.goto(harnessUrl, { timeout: 5000 });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
  } catch {
    try { await page.close(); } catch {}
    page = await context.newPage();
    await page.goto(harnessUrl);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
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

function mutate(input, rng) {
  let bytes = new Uint8Array(input);
  const ops = 1 + Math.floor(rng() * 6);
  for (let i = 0; i < ops; i += 1) bytes = applyMutation(bytes, rng);
  return bytes;
}

function applyMutation(input, rng) {
  const op = Math.floor(rng() * 6);
  const bytes = new Uint8Array(input);
  if (!bytes.length) return bytes;
  if (op === 0) {
    const out = new Uint8Array(bytes);
    for (let k = 0; k < 12; k += 1) out[Math.floor(rng() * out.length)] ^= 1 << Math.floor(rng() * 8);
    return out;
  }
  if (op === 1) return bytes.slice(0, Math.floor(rng() * bytes.length));
  if (op === 2) {
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
  if (op === 3) {
    const source = Buffer.from(bytes).toString("latin1");
    const matches = Array.from(source.matchAll(/\b\d{1,8}\b/g)).slice(0, 256);
    if (!matches.length) return bytes;
    const m = matches[Math.floor(rng() * matches.length)];
    const replacement = String([0, 1, -1, 99999999, Math.floor(rng() * 1_000_000)][Math.floor(rng() * 5)]);
    return spliceReplace(bytes, m.index, m[0].length, Buffer.from(replacement, "latin1"));
  }
  if (op === 4) {
    const source = Buffer.from(bytes).toString("latin1");
    const m = /\bendobj\b/.exec(source);
    if (!m) return bytes;
    return spliceReplace(bytes, m.index, m[0].length, Buffer.from("", "latin1"));
  }
  if (op === 5) {
    const source = Buffer.from(bytes).toString("latin1");
    const m = /\/Length\s+(\d{1,8})/.exec(source);
    if (!m) return bytes;
    const numStart = m.index + m[0].indexOf(m[1]);
    return spliceReplace(bytes, numStart, m[1].length, Buffer.from(String(Math.floor(rng() * 9999999)), "latin1"));
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
