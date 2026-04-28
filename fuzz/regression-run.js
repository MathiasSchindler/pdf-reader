#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(rootDir, "fuzz", "worker.js");
const corpusDir = path.join(rootDir, "fixtures", "regression");
const args = parseArgs(process.argv.slice(2));
const timeoutMs = Number(args.timeout || 1500);

const artifacts = await loadArtifacts();
if (!artifacts.length) {
  console.log("regression fuzz: no artifacts in fixtures/regression");
  process.exit(0);
}

let passed = 0;
const failed = [];
for (const artifact of artifacts) {
  const result = await runCase(artifact.bytes, timeoutMs);
  if (result.status === "parsed" || result.status === "rejected") {
    passed += 1;
  } else {
    failed.push({ name: artifact.name, result });
  }
}

console.log(`regression fuzz: passed=${passed} failed=${failed.length} timeout=${timeoutMs}ms`);
for (const item of failed.slice(0, 20)) {
  console.error(`${item.name}: ${item.result.status} ${item.result.message || ""}`.trim());
}
if (failed.length) process.exitCode = 1;

async function loadArtifacts() {
  let entries;
  try {
    entries = await readdir(corpusDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = entries.filter((entry) => entry.isFile() && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
  return Promise.all(files.map(async (name) => ({ name, bytes: new Uint8Array(await readFile(path.join(corpusDir, name))) })));
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

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=", 2);
    parsed[key] = value ?? true;
  }
  return parsed;
}
