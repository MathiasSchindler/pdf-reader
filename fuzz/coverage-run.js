// In-process coverage harness for c8. Runs the parser directly (no worker
// threads) over fixtures plus a quick batch of mutated inputs so c8 can
// produce a coverage report for src/pdf-lite/.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPdfCrumb } from "../src/pdf-lite/index.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(rootDir, "fixtures");
const cases = Number(process.env.COVERAGE_CASES || 400);
const seed = Number(process.env.COVERAGE_SEED || 20260428);
const rng = mulberry32(seed >>> 0);

const entries = await readdir(fixturesDir, { withFileTypes: true });
const fixtures = await Promise.all(
  entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map(async (entry) => ({ name: entry.name, bytes: new Uint8Array(await readFile(path.join(fixturesDir, entry.name))) })),
);

let parsed = 0;
let rejected = 0;
for (const fixture of fixtures) {
  try {
    await loadPdfCrumb(toDataUrl(fixture.bytes));
    parsed += 1;
  } catch {
    rejected += 1;
  }
}

for (let index = 0; index < cases; index += 1) {
  const seed = fixtures[Math.floor(rng() * fixtures.length)];
  const bytes = mutate(seed.bytes, rng);
  try {
    await Promise.race([
      loadPdfCrumb(toDataUrl(bytes)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
    ]);
    parsed += 1;
  } catch {
    rejected += 1;
  }
}

console.log(`coverage harness: parsed=${parsed} rejected=${rejected} (fixtures=${fixtures.length} mutated=${cases})`);

function toDataUrl(bytes) {
  return `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`;
}

function mutate(input, rng) {
  let bytes = new Uint8Array(input);
  const ops = 1 + Math.floor(rng() * 6);
  for (let i = 0; i < ops; i += 1) bytes = flipOrSplice(bytes, rng);
  return bytes;
}

function flipOrSplice(bytes, rng) {
  const choice = Math.floor(rng() * 4);
  const out = new Uint8Array(bytes);
  if (choice === 0) {
    for (let i = 0; i < 8; i += 1) {
      const pos = Math.floor(rng() * out.length);
      out[pos] ^= 1 << Math.floor(rng() * 8);
    }
    return out;
  }
  if (choice === 1) return out.slice(0, Math.floor(rng() * out.length));
  if (choice === 2) {
    const start = Math.floor(rng() * out.length);
    const len = Math.floor(rng() * 256);
    const insert = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) insert[i] = Math.floor(rng() * 256);
    const merged = new Uint8Array(out.length + insert.length);
    merged.set(out.slice(0, start), 0);
    merged.set(insert, start);
    merged.set(out.slice(start), start + insert.length);
    return merged;
  }
  return out.slice(Math.floor(rng() * out.length));
}

function mulberry32(seed) {
  return function next() {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
