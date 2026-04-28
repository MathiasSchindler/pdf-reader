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
const caseCount = Number(args.cases || (mode === "smoke" ? 60 : mode === "epic" ? 5000 : 600));
const timeoutMs = Number(args.timeout || (mode === "smoke" ? 750 : mode === "epic" ? 1500 : 1200));
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

// Common PDF tokens used by the dictionary mutator. These are shapes the
// parser branches on; splicing them in raises the chance that a mutation
// lands in a meaningful state machine transition rather than dead bytes.
const PDF_DICTIONARY = [
  "/Type", "/Catalog", "/Pages", "/Page", "/Kids", "/Count",
  "/MediaBox", "/CropBox", "/BleedBox", "/Resources", "/Contents",
  "/Parent", "/Font", "/FontDescriptor", "/Encoding", "/F1", "/F2",
  "/Helvetica", "/Times-Roman", "/Courier", "/Symbol", "/ZapfDingbats",
  "/Filter", "/FlateDecode", "/ASCIIHexDecode", "/ASCII85Decode",
  "/LZWDecode", "/RunLengthDecode", "/CCITTFaxDecode", "/JBIG2Decode",
  "/DCTDecode", "/JPXDecode", "/Crypt", "/DecodeParms", "/Predictor",
  "/Columns", "/BitsPerComponent", "/Length", "/Length1", "/Length2",
  "/Linearized", "/ObjStm", "/XRef", "/Encrypt", "/Info", "/Size",
  "/Prev", "/Root", "/ID", "/W", "/Index", "/N", "/First",
  "/Subtype", "/Image", "/Form", "/Width", "/Height", "/ColorSpace",
  "/DeviceRGB", "/DeviceGray", "/DeviceCMYK", "/Indexed", "/CalRGB",
  "/Lab", "/Pattern", "/Shading", "/Annots", "/Annot", "/Link",
  "/A", "/URI", "/Dest", "/Outlines", "/Title", "/Author",
  "/Producer", "/Creator", "/CreationDate", "/ModDate",
  "stream\n", "\nendstream\n", "obj\n", "endobj\n", "xref\n",
  "trailer\n", "startxref\n", "%%EOF", "%PDF-1.4\n", "%PDF-1.7\n",
  "true", "false", "null", " R", "<<", ">>", "[", "]",
  "<<>>", "[]", "()", "<>",
];

const seeds = await loadSeeds();
if (!seeds.length) {
  throw new Error("No fixture PDF seeds found.");
}

let parsed = 0;
let rejected = 0;
let timedOut = 0;
const unexpected = [];

// Coverage-guided corpus. We track which V8 coverage edges (from the worker)
// have ever been seen and grow a corpus of inputs that contributed new edges,
// biasing future mutations toward them so the fuzzer drifts into unexplored
// branches instead of re-rolling random inputs forever.
const globalEdges = new Set();
const corpus = []; // [{ bytes, novelty, origin }]
const corpusCap = 512;
const corpusFloor = 384;

console.log(`pdf-crumb fuzz ${mode}: ${caseCount} cases, seed ${seed}, timeout ${timeoutMs}ms`);

// Baseline: run each clean fixture once to seed globalEdges so corpus growth
// only reflects coverage that mutated inputs unlocked.
for (const fixture of seeds) {
  const result = await runCase(fixture.bytes, Math.max(timeoutMs, 2000));
  for (const edge of result.edges || []) globalEdges.add(edge);
}
console.log(`baseline edges: ${globalEdges.size}`);

for (let index = 0; index < caseCount; index += 1) {
  const base = pickBase(rng);
  const bytes = mutate(base.bytes, rng, index);
  const result = await runCase(bytes, timeoutMs);
  const newEdges = recordCoverage(bytes, result.edges, base.origin);

  if (result.status === "parsed") {
    parsed += 1;
  } else if (result.status === "rejected") {
    rejected += 1;
  } else if (result.status === "timeout") {
    timedOut += 1;
    const minimized = await minimize(bytes, "timeout", timeoutMs);
    unexpected.push({ index, seed: base.origin, reason: "timeout", size: minimized.length });
    await saveArtifact(index, base.origin, minimized, "timeout");
  } else {
    const minimized = await minimize(bytes, result.status, timeoutMs);
    unexpected.push({ index, seed: base.origin, reason: result.message || result.status, size: minimized.length });
    await saveArtifact(index, base.origin, minimized, "unexpected");
  }

  if ((index + 1) % 50 === 0 || index + 1 === caseCount) {
    console.log(
      `${index + 1}/${caseCount} parsed=${parsed} rejected=${rejected} timeout=${timedOut} ` +
        `edges=${globalEdges.size} corpus=${corpus.length}` +
        (newEdges > 0 ? ` (+${newEdges} new)` : "")
    );
  }
}

console.log(`done: parsed=${parsed} rejected=${rejected} timeout=${timedOut} edges=${globalEdges.size} corpus=${corpus.length}`);

if (unexpected.length) {
  console.error("unexpected fuzz outcomes:");
  for (const item of unexpected.slice(0, 20)) {
    console.error(`case ${item.index} from ${item.seed}: ${item.reason} (minimized ${item.size}B)`);
  }
  process.exitCode = 1;
}

function pickBase(rng) {
  // 30% of the time draw fresh from fixtures so we don't get trapped in a
  // coverage local maximum; otherwise prefer corpus entries weighted by how
  // many new edges they unlocked.
  if (corpus.length === 0 || rng() < 0.3) {
    const fixture = pick(seeds, rng);
    return { bytes: fixture.bytes, origin: fixture.name };
  }
  const total = corpus.reduce((sum, item) => sum + item.novelty, 0);
  let target = rng() * total;
  for (const item of corpus) {
    target -= item.novelty;
    if (target <= 0) return { bytes: item.bytes, origin: item.origin };
  }
  const last = corpus[corpus.length - 1];
  return { bytes: last.bytes, origin: last.origin };
}

function recordCoverage(bytes, edges, origin) {
  if (!edges || !edges.length) return 0;
  let newCount = 0;
  for (const edge of edges) {
    if (!globalEdges.has(edge)) {
      globalEdges.add(edge);
      newCount += 1;
    }
  }
  if (newCount > 0) {
    corpus.push({ bytes, novelty: newCount, origin: `corpus<${origin}>` });
    if (corpus.length > corpusCap) {
      corpus.sort((a, b) => b.novelty - a.novelty);
      corpus.length = corpusFloor;
    }
  }
  return newCount;
}

async function minimize(bytes, reason, timeout) {
  // Delete-bisect minimizer: try removing chunks of progressively smaller size
  // and keep any reduction that still reproduces the same bad outcome. Bounded
  // to a small iteration budget so it never dominates fuzz time.
  let current = new Uint8Array(bytes);
  let chunkSize = Math.max(1, Math.floor(current.length / 4));
  const iterationLimit = 64;
  let iterations = 0;
  while (chunkSize >= 1 && iterations < iterationLimit && current.length > 16) {
    let progressed = false;
    for (let offset = 0; offset + chunkSize <= current.length && iterations < iterationLimit; offset += chunkSize) {
      iterations += 1;
      const candidate = new Uint8Array(current.length - chunkSize);
      candidate.set(current.subarray(0, offset), 0);
      candidate.set(current.subarray(offset + chunkSize), offset);
      const result = await runCase(candidate, timeout);
      if (matchesReason(result, reason)) {
        current = candidate;
        progressed = true;
        break;
      }
    }
    if (!progressed) {
      chunkSize = Math.floor(chunkSize / 2);
    }
  }
  return current;
}

function matchesReason(result, reason) {
  if (reason === "timeout") return result.status === "timeout";
  return result.status === reason;
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
  const operations = 1 + randomInt(rng, 12);
  for (let offset = 0; offset < operations; offset += 1) {
    bytes = applyMutation(bytes, rng, index + offset);
  }
  return bytes;
}

function applyMutation(input, rng, salt) {
  // Heavy bias toward structured PDF-aware mutations (operations 12+) over
  // pure random byte twiddling so we hit parser-relevant edge cases.
  const operation = randomInt(rng, 30);
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
  if (operation === 19) return swapDictDelimiters(bytes, rng);
  if (operation === 20) return corruptHeader(bytes, rng);
  if (operation === 21) return corruptStartxref(bytes, rng);
  if (operation === 22) return mutateName(bytes, rng);
  if (operation === 23) return injectHugeString(bytes, rng);
  if (operation === 24) return swapObjectIds(bytes, rng);
  if (operation === 25) return corruptKidsArray(bytes, rng);
  if (operation === 26) return injectIndirectChain(bytes, rng);
  if (operation === 27) return injectNullsInStream(bytes, rng);
  if (operation === 28) return spliceDictionaryToken(bytes, rng);
  return replaceWithDictionaryToken(bytes, rng);
}

function spliceDictionaryToken(bytes, rng) {
  // Insert a known PDF token at a random offset.
  const token = pick(PDF_DICTIONARY, rng);
  const offset = randomInt(rng, bytes.length);
  return spliceBytes(bytes, offset, Buffer.from(token, "latin1"));
}

function replaceWithDictionaryToken(bytes, rng) {
  // Replace an existing /Name occurrence (or a span if no name found) with a
  // dictionary token, biasing the parser into a different branch.
  const source = Buffer.from(bytes).toString("latin1");
  const matches = Array.from(source.matchAll(/\/[A-Za-z][A-Za-z0-9]{0,32}/g)).slice(0, 256);
  const replacement = pick(PDF_DICTIONARY, rng);
  if (!matches.length) {
    const offset = randomInt(rng, bytes.length);
    return spliceBytes(bytes, offset, Buffer.from(replacement, "latin1"));
  }
  const target = pick(matches, rng);
  return spliceReplace(bytes, target.index, target[0].length, Buffer.from(replacement, "latin1"));
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

function corruptHeader(bytes, rng) {
  // Replace the %PDF-x.y header with versions the parser shouldn't trust.
  const source = Buffer.from(bytes).toString("latin1");
  const match = /%PDF-\d\.\d/.exec(source);
  if (!match) return flipBits(bytes, rng);
  const replacement = pick([
    "%PDF-9.9",
    "%PDF-0.0",
    "%PDF-",
    "%!PS-Adobe-3.0",
    "%PDF-1.7\n%PDF-1.4",
    "",
  ], rng);
  return spliceReplace(bytes, match.index, match[0].length, Buffer.from(replacement, "latin1"));
}

function corruptStartxref(bytes, rng) {
  // Point startxref at offsets that don't exist or land mid-token.
  const source = Buffer.from(bytes).toString("latin1");
  const match = /startxref\s+(\d{1,12})/.exec(source);
  if (!match) return flipBits(bytes, rng);
  const replacement = String(pick([0, 1, bytes.length + 1024, 999999999, randomInt(rng, bytes.length)], rng));
  const numStart = match.index + match[0].indexOf(match[1]);
  return spliceReplace(bytes, numStart, match[1].length, Buffer.from(replacement, "latin1"));
}

function mutateName(bytes, rng) {
  // Inject hex-escapes and oversized name tokens into a /Name field.
  const source = Buffer.from(bytes).toString("latin1");
  const matches = Array.from(source.matchAll(/\/[A-Za-z][A-Za-z0-9]{0,32}/g)).slice(0, 256);
  if (!matches.length) return flipBits(bytes, rng);
  const target = pick(matches, rng);
  const replacement = pick([
    "/" + "A".repeat(2048),
    "/#41#41#41",
    "/" + "#" + Math.floor(rng() * 256).toString(16).padStart(2, "0").repeat(64),
    "/",
    "/##",
  ], rng);
  return spliceReplace(bytes, target.index, target[0].length, Buffer.from(replacement, "latin1"));
}

function injectHugeString(bytes, rng) {
  // Insert a multi-kilobyte literal or hex string to stress allocation paths.
  const size = 4096 + randomInt(rng, 32768);
  const kind = randomInt(rng, 3);
  let payload;
  if (kind === 0) payload = "(" + "A".repeat(size) + ")";
  else if (kind === 1) payload = "<" + "ab".repeat(size / 2) + ">";
  else payload = "(" + "\\(".repeat(size / 2) + ")"; // unbalanced escapes
  const offset = randomInt(rng, bytes.length);
  return spliceBytes(bytes, offset, Buffer.from(payload, "latin1"));
}

function swapObjectIds(bytes, rng) {
  // Rewrite an object header so two objects share an id, exercising
  // de-duplication / "last-wins" logic.
  const source = Buffer.from(bytes).toString("latin1");
  const headers = Array.from(source.matchAll(/\b(\d{1,6})\s+0\s+obj\b/g)).slice(0, 64);
  if (headers.length < 2) return flipBits(bytes, rng);
  const a = pick(headers, rng);
  const b = pick(headers, rng);
  if (a.index === b.index) return flipBits(bytes, rng);
  const replacement = `${b[1]} 0 obj`;
  return spliceReplace(bytes, a.index, a[0].length, Buffer.from(replacement, "latin1"));
}

function corruptKidsArray(bytes, rng) {
  // Stuff a /Kids array with bogus or repeated references.
  const source = Buffer.from(bytes).toString("latin1");
  const match = /\/Kids\s*\[[^\]]{0,512}\]/.exec(source);
  if (!match) return flipBits(bytes, rng);
  const refMatches = Array.from(source.matchAll(/\b(\d{1,6})\s+0\s+R\b/g)).slice(0, 32);
  if (!refMatches.length) return flipBits(bytes, rng);
  const count = 8 + randomInt(rng, 64);
  const refs = Array.from({ length: count }, () => pick(refMatches, rng)[0]).join(" ");
  const replacement = `/Kids [${refs}]`;
  return spliceReplace(bytes, match.index, match[0].length, Buffer.from(replacement, "latin1"));
}

function injectIndirectChain(bytes, rng) {
  // Append a chain of indirect objects whose values reference each other.
  const start = 5000 + randomInt(rng, 1000);
  const length = 8 + randomInt(rng, 32);
  const parts = [];
  for (let index = 0; index < length; index += 1) {
    const next = start + ((index + 1) % length);
    parts.push(`${start + index} 0 obj\n${next} 0 R\nendobj\n`);
  }
  return spliceBytes(bytes, bytes.length, Buffer.from("\n" + parts.join(""), "latin1"));
}

function injectNullsInStream(bytes, rng) {
  // Splice a block of NUL/0xFF bytes inside the first stream payload.
  const source = Buffer.from(bytes).toString("latin1");
  const start = source.indexOf("stream");
  const end = source.indexOf("endstream", start + 6);
  if (start < 0 || end < 0 || end <= start + 8) return flipBits(bytes, rng);
  const insertAt = start + 6 + randomInt(rng, Math.max(1, end - start - 6));
  const fillByte = pick([0x00, 0xff, 0x0a], rng);
  const payload = new Uint8Array(64 + randomInt(rng, 4096));
  payload.fill(fillByte);
  return spliceBytes(bytes, insertAt, payload);
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
