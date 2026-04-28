#!/usr/bin/env node
import { Worker } from "node:worker_threads";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(rootDir, "fuzz", "worker.js");
const fixturesDir = path.join(rootDir, "fixtures");
const artifactsDir = path.join(rootDir, "fuzz", "artifacts");

const args = parseArgs(process.argv.slice(2));
const mode = args.mode || process.env.PDF_CRUMB_FUZZ_MODE || "smoke";
const seed = Number(args.seed || process.env.PDF_CRUMB_FUZZ_SEED || Date.now());
const rng = mulberry32(seed >>> 0);
const caseCount = Number(args.cases || (mode === "smoke" ? 60 : 600));
const timeoutMs = Number(args.timeout || (mode === "smoke" ? 750 : 1200));
const maxArtifactBytes = Number(args.maxArtifactBytes || 1024 * 1024);

if (args.replay) {
  const replayPath = path.resolve(rootDir, args.replay);
  const bytes = new Uint8Array(await readFile(replayPath));
  const result = await runCase(bytes, timeoutMs);
  console.log(JSON.stringify({ replay: path.relative(rootDir, replayPath), timeoutMs, ...result }, null, 2));
  if (result.status === "timeout" || result.status.endsWith?.("error") || result.status.startsWith?.("worker-")) {
    process.exitCode = 1;
  }
  process.exit();
}

const seeds = await loadSeeds();
if (!seeds.length) {
  throw new Error("No fixture PDF seeds found.");
}

let parsed = 0;
let rejected = 0;
let timedOut = 0;
const unexpected = [];

console.log(`pdf-crumb fuzz ${mode}: ${caseCount} cases, seed ${seed}, timeout ${timeoutMs}ms`);

for (let index = 0; index < caseCount; index += 1) {
  const seedFile = pick(seeds, rng);
  const bytes = mutate(seedFile.bytes, rng, index);
  const result = await runCase(bytes, timeoutMs);
  if (result.status === "parsed") {
    parsed += 1;
  } else if (result.status === "rejected") {
    rejected += 1;
  } else if (result.status === "timeout") {
    timedOut += 1;
    unexpected.push({ index, seed: seedFile.name, reason: "timeout" });
    await saveArtifact(index, seedFile.name, bytes, "timeout");
  } else {
    unexpected.push({ index, seed: seedFile.name, reason: result.message || result.status });
    await saveArtifact(index, seedFile.name, bytes, "unexpected");
  }

  if ((index + 1) % 50 === 0 || index + 1 === caseCount) {
    console.log(`${index + 1}/${caseCount} parsed=${parsed} rejected=${rejected} timeout=${timedOut}`);
  }
}

console.log(`done: parsed=${parsed} rejected=${rejected} timeout=${timedOut}`);

if (unexpected.length) {
  console.error("unexpected fuzz outcomes:");
  for (const item of unexpected.slice(0, 20)) {
    console.error(`case ${item.index} from ${item.seed}: ${item.reason}`);
  }
  process.exitCode = 1;
}

async function loadSeeds() {
  const entries = await readdir(fixturesDir, { withFileTypes: true });
  const pdfs = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(pdfs.map(async (name) => ({ name, bytes: new Uint8Array(await readFile(path.join(fixturesDir, name))) })));
}

function runCase(bytes, timeout) {
  return new Promise((resolve) => {
    const worker = new Worker(workerPath, { workerData: { bytes } });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve({ status: "timeout" });
    }, timeout);

    worker.once("message", (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(message);
    });

    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: "worker-error", message: error.message });
    });

    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? { status: "exited" } : { status: "worker-exit", message: `exit ${code}` });
    });
  });
}

async function saveArtifact(index, seedName, bytes, reason) {
  if (bytes.byteLength > maxArtifactBytes) return;
  await mkdir(artifactsDir, { recursive: true });
  const safeSeed = seedName.replace(/[^a-z0-9._-]+/gi, "_");
  const file = path.join(artifactsDir, `${String(index).padStart(5, "0")}-${reason}-${safeSeed}`);
  await writeFile(file, bytes);
}

function mutate(input, rng, index) {
  let bytes = new Uint8Array(input);
  const operations = 1 + randomInt(rng, 8);
  for (let offset = 0; offset < operations; offset += 1) {
    bytes = applyMutation(bytes, rng, index + offset);
  }
  return bytes;
}

function applyMutation(input, rng, salt) {
  // Bias toward structured PDF-aware mutations (operations 12-19) over pure
  // random byte twiddling so we hit parser-relevant edge cases more often.
  const operation = randomInt(rng, 20);
  const bytes = new Uint8Array(input);
  if (!bytes.length) return bytes;

  if (operation === 0) return randomBytes(rng, randomInt(rng, 2048));
  if (operation === 1) return bytes.slice(0, randomInt(rng, bytes.length));
  if (operation === 2) return bytes.slice(randomInt(rng, bytes.length));
  if (operation === 3) return spliceBytes(bytes, randomInt(rng, bytes.length), randomBytes(rng, randomInt(rng, 256)));
  if (operation === 4) return deleteRange(bytes, randomInt(rng, bytes.length), randomInt(rng, Math.min(512, bytes.length)));
  if (operation === 5) return duplicateRange(bytes, rng);
  if (operation === 6) return overwriteRange(bytes, rng);
  if (operation === 7) return replaceAsciiToken(bytes, rng, "stream", pick(["stream\n", "stream\r\n", "strm", "stream\nendstream\nstream"], rng));
  if (operation === 8) return replaceAsciiToken(bytes, rng, "endobj", pick(["endobj", "endstream", "", "endobj\n0 0 obj"], rng));
  if (operation === 9) return replaceNumber(bytes, rng);
  if (operation === 10) return appendTail(bytes, rng, salt);
  if (operation === 11) return flipBits(bytes, rng);
  if (operation === 12) return corruptLength(bytes, rng);
  if (operation === 13) return corruptMediaBox(bytes, rng);
  if (operation === 14) return corruptXref(bytes, rng);
  if (operation === 15) return inflateFilterChain(bytes, rng);
  if (operation === 16) return injectRecursiveRef(bytes, rng);
  if (operation === 17) return deepenNesting(bytes, rng);
  if (operation === 18) return duplicateObject(bytes, rng);
  return swapDictDelimiters(bytes, rng);
}

// --- Structured, PDF-aware mutators -----------------------------------------
// All of these operate on bytes of the user's own fixtures and feed the result
// back into the user's own renderer in an isolated worker. They are designed
// to surface parser-level robustness issues (hangs, unbounded allocations,
// pathological recursion) so they can be fixed.

function corruptLength(bytes, rng) {
  // Replace the integer in `/Length N` with a misleading value (huge,
  // negative-ish, or zero) to stress stream length handling.
  const source = Buffer.from(bytes).toString("latin1");
  const matches = Array.from(source.matchAll(/\/Length\s+(\d{1,9})/g));
  if (!matches.length) return flipBits(bytes, rng);
  const match = pick(matches, rng);
  const replacement = String(pick([0, 1, 9, 99999999, 2147483647, randomInt(rng, 1_000_000)], rng));
  const numStart = match.index + match[0].indexOf(match[1]);
  return spliceReplace(bytes, numStart, match[1].length, Buffer.from(replacement, "latin1"));
}

function corruptMediaBox(bytes, rng) {
  // Replace a /MediaBox array with an oversized or malformed variant.
  const source = Buffer.from(bytes).toString("latin1");
  const match = /\/MediaBox\s*\[[^\]]{0,200}\]/.exec(source);
  if (!match) return flipBits(bytes, rng);
  const replacement = pick([
    "/MediaBox [0 0 999999 999999]",
    "/MediaBox [-1 -1 1 1]",
    "/MediaBox [0 0 0 0]",
    "/MediaBox []",
    "/MediaBox [0 0 1e9 1e9]",
  ], rng);
  return spliceReplace(bytes, match.index, match[0].length, Buffer.from(replacement, "latin1"));
}

function corruptXref(bytes, rng) {
  // Scramble the offsets inside an xref table so lookups point into the wild.
  const source = Buffer.from(bytes).toString("latin1");
  const xrefIndex = source.lastIndexOf("xref");
  if (xrefIndex < 0) return flipBits(bytes, rng);
  const trailerIndex = source.indexOf("trailer", xrefIndex);
  const end = trailerIndex > xrefIndex ? trailerIndex : Math.min(source.length, xrefIndex + 4096);
  const region = source.slice(xrefIndex, end);
  const mutated = region.replace(/\b(\d{10})\b/g, () => String(randomInt(rng, 9_999_999_999)).padStart(10, "0"));
  return spliceReplace(bytes, xrefIndex, region.length, Buffer.from(mutated, "latin1"));
}

function inflateFilterChain(bytes, rng) {
  // Turn a single /Filter into a long chain to stress decode dispatch.
  const source = Buffer.from(bytes).toString("latin1");
  const match = /\/Filter\s*\/([A-Za-z0-9]+)/.exec(source);
  if (!match) return flipBits(bytes, rng);
  const count = 2 + randomInt(rng, 12);
  const chain = `/Filter [${Array.from({ length: count }, () => `/${match[1]}`).join(" ")}]`;
  return spliceReplace(bytes, match.index, match[0].length, Buffer.from(chain, "latin1"));
}

function injectRecursiveRef(bytes, rng) {
  // Rewrite an existing indirect reference so it points back at its own object
  // number, encouraging cycles in /Parent or /Kids traversal.
  const source = Buffer.from(bytes).toString("latin1");
  const objMatch = /\b(\d{1,6})\s+0\s+obj\b/.exec(source);
  const refMatches = Array.from(source.matchAll(/\b(\d{1,6})\s+0\s+R\b/g));
  if (!objMatch || !refMatches.length) return flipBits(bytes, rng);
  const target = pick(refMatches, rng);
  const replacement = `${objMatch[1]} 0 R`;
  return spliceReplace(bytes, target.index, target[0].length, Buffer.from(replacement, "latin1"));
}

function deepenNesting(bytes, rng) {
  // Insert a long run of dictionary openers without matching closers to make
  // sure the parser bounds recursion depth instead of blowing the stack.
  const depth = 32 + randomInt(rng, 96);
  const blob = "<<".repeat(depth) + " /A 1 ".repeat(depth);
  const offset = randomInt(rng, bytes.length);
  return spliceBytes(bytes, offset, Buffer.from(blob, "latin1"));
}

function duplicateObject(bytes, rng) {
  // Duplicate a full `N 0 obj ... endobj` block to create conflicting
  // definitions for the same object id.
  const source = Buffer.from(bytes).toString("latin1");
  const blocks = Array.from(source.matchAll(/\b(\d{1,6})\s+0\s+obj[\s\S]{1,4096}?endobj/g)).slice(0, 64);
  if (!blocks.length) return flipBits(bytes, rng);
  const block = pick(blocks, rng);
  return spliceBytes(bytes, block.index + block[0].length, Buffer.from(`\n${block[0]}\n`, "latin1"));
}

function swapDictDelimiters(bytes, rng) {
  // Drop or stutter dictionary/array delimiters to surface tokenizer loops.
  const replacements = [
    [/<</g, "<"],
    [/>>/g, ">"],
    [/<</g, "<<<<"],
    [/>>/g, ">>>>"],
    [/\[/g, "[["],
    [/\]/g, "]]"],
  ];
  const [pattern, replacement] = pick(replacements, rng);
  const source = Buffer.from(bytes).toString("latin1");
  const matches = Array.from(source.matchAll(pattern));
  if (!matches.length) return flipBits(bytes, rng);
  const target = pick(matches, rng);
  return spliceReplace(bytes, target.index, target[0].length, Buffer.from(replacement, "latin1"));
}

function spliceBytes(bytes, offset, inserted) {
  const output = new Uint8Array(bytes.length + inserted.length);
  output.set(bytes.slice(0, offset), 0);
  output.set(inserted, offset);
  output.set(bytes.slice(offset), offset + inserted.length);
  return output;
}

function deleteRange(bytes, start, length) {
  const end = Math.min(bytes.length, start + length);
  const output = new Uint8Array(bytes.length - (end - start));
  output.set(bytes.slice(0, start), 0);
  output.set(bytes.slice(end), start);
  return output;
}

function duplicateRange(bytes, rng) {
  const start = randomInt(rng, bytes.length);
  const length = randomInt(rng, Math.min(512, bytes.length - start));
  return spliceBytes(bytes, start, bytes.slice(start, start + length));
}

function overwriteRange(bytes, rng) {
  const output = new Uint8Array(bytes);
  const start = randomInt(rng, bytes.length);
  const length = randomInt(rng, Math.min(512, bytes.length - start));
  output.set(randomBytes(rng, length), start);
  return output;
}

function replaceAsciiToken(bytes, rng, token, replacement) {
  const source = Buffer.from(bytes).toString("latin1");
  const positions = [];
  let index = source.indexOf(token);
  while (index !== -1 && positions.length < 128) {
    positions.push(index);
    index = source.indexOf(token, index + token.length);
  }
  if (!positions.length) return flipBits(bytes, rng);
  const selected = pick(positions, rng);
  return spliceReplace(bytes, selected, token.length, Buffer.from(replacement, "latin1"));
}

function replaceNumber(bytes, rng) {
  const source = Buffer.from(bytes).toString("latin1");
  const matches = Array.from(source.matchAll(/\b\d{1,8}\b/g)).slice(0, 256);
  if (!matches.length) return flipBits(bytes, rng);
  const match = pick(matches, rng);
  const replacement = String(pick([0, 1, -1, 99999999, 2147483647, randomInt(rng, 1000000)], rng));
  return spliceReplace(bytes, match.index, match[0].length, Buffer.from(replacement, "latin1"));
}

function spliceReplace(bytes, start, length, replacement) {
  const end = Math.min(bytes.length, start + length);
  const output = new Uint8Array(bytes.length - (end - start) + replacement.length);
  output.set(bytes.slice(0, start), 0);
  output.set(replacement, start);
  output.set(bytes.slice(end), start + replacement.length);
  return output;
}

function appendTail(bytes, rng, salt) {
  const tail = Buffer.from(`\n${1000 + salt} 0 obj\n<< /Length ${randomInt(rng, 500)} >>\nstream\n`, "latin1");
  return spliceBytes(bytes, bytes.length, tail);
}

function flipBits(bytes, rng) {
  const output = new Uint8Array(bytes);
  const flips = 1 + randomInt(rng, 16);
  for (let index = 0; index < flips; index += 1) {
    const position = randomInt(rng, output.length);
    output[position] ^= 1 << randomInt(rng, 8);
  }
  return output;
}

function randomBytes(rng, length) {
  const output = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    output[index] = randomInt(rng, 256);
  }
  return output;
}

function pick(items, rng) {
  return items[randomInt(rng, items.length)];
}

function randomInt(rng, max) {
  return Math.floor(rng() * Math.max(1, max));
}

function mulberry32(seed) {
  return function next() {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=", 2);
    parsed[key] = value ?? argv[index + 1];
    if (value === undefined) index += 1;
  }
  return parsed;
}
