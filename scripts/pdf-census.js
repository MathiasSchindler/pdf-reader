#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPdfCrumb } from "../src/pdf-lite/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function pdfPaths(folder) {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const name = path.join(folder, entry.name);
    if (entry.isDirectory()) files.push(...await pdfPaths(name));
    else if (entry.isFile() && /\.pdf$/i.test(entry.name)) files.push(name);
  }
  return files.sort();
}

function featureStatus(feature) {
  if (feature === "operator:BX" || feature === "operator:EX") return "observed";
  if (["shading:paint", "transparency:soft-mask", "transparency:blend-mode", "transparency:group"].includes(feature)) return "partial";
  if (feature === "text:clip-mode" || feature.startsWith("operator:") ||
      feature.startsWith("shading:unsupported-type:") ||
      ["transparency:nonisolated-group", "transparency:knockout-group",
        "transparency:unsupported-soft-mask", "transparency:unsupported-blend-mode"].includes(feature) ||
      feature.startsWith("image:filter:") &&
        !["FlateDecode", "Fl", "DCTDecode", "DCT", "ASCIIHexDecode", "AHx", "ASCII85Decode", "A85", "RunLengthDecode", "RL"]
          .includes(feature.slice("image:filter:".length))) return "unsupported";
  if (feature === "font:embedded-fallback" || feature === "font:form-resource-uncollected") return "fallback";
  if (feature === "font:browser-install-unverified") return "unverified";
  return "observed";
}

export function summarizeCensus(documents) {
  const features = new Map();
  for (const document of documents) {
    const perDocument = new Set();
    for (const page of document.pageResults || []) {
      for (const [feature, count] of Object.entries(page.features || {})) {
        const entry = features.get(feature) || { feature, status: featureStatus(feature), documents: 0, pages: 0, occurrences: 0, examples: [] };
        entry.pages += 1;
        entry.occurrences += count;
        if (entry.examples.length < 5) entry.examples.push({ file: document.file, page: page.page });
        features.set(feature, entry);
        perDocument.add(feature);
      }
    }
    for (const feature of perDocument) features.get(feature).documents += 1;
  }
  return {
    files: documents.length,
    parsed: documents.filter((document) => !document.error).length,
    pages: documents.reduce((sum, document) => sum + (document.pages || 0), 0),
    scannedPages: documents.reduce((sum, document) => sum + (document.pageResults?.filter((page) => !page.error).length || 0), 0),
    pageErrors: documents.reduce((sum, document) => sum + (document.pageResults?.filter((page) => page.error || page.errors?.length).length || 0), 0),
    features: Array.from(features.values()).sort((a, b) => b.documents - a.documents || b.pages - a.pages || a.feature.localeCompare(b.feature)),
  };
}

export async function censusDirectory(folder) {
  const paths = await pdfPaths(folder);
  const documents = [];
  const hashes = new Map();
  for (const file of paths) {
    const name = path.relative(folder, file);
    const bytes = await readFile(file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (hashes.has(sha256)) {
      documents.push({ file: name, sha256, duplicateOf: hashes.get(sha256) });
      continue;
    }
    hashes.set(sha256, name);
    const result = { file: name, sha256, bytes: bytes.length, pageResults: [] };
    documents.push(result);
    try {
      const pdf = await loadPdfCrumb(`data:application/pdf;base64,${bytes.toString("base64")}`);
      result.pages = pdf.pages.length;
      result.version = pdf.audit().version;
      result.warnings = pdf.warnings.slice();
      for (let index = 0; index < pdf.pages.length; index += 1) {
        try {
          result.pageResults.push({ page: index + 1, ...await pdf.censusPage(index) });
        } catch (error) {
          result.pageResults.push({ page: index + 1, error: error.message });
        }
      }
    } catch (error) {
      result.error = error.message;
    }
  }
  const unique = documents.filter((document) => !document.duplicateOf);
  return {
    generatedAt: new Date().toISOString(),
    summary: { ...summarizeCensus(unique), duplicates: documents.length - unique.length },
    documents,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folder = path.resolve(process.argv[2] || path.join(root, "pdf-files"));
  const output = path.resolve(process.argv[3] || path.join(folder, "census.json"));
  try {
    const report = await censusDirectory(folder);
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    const { summary } = report;
    console.log(`Scanned ${summary.parsed}/${summary.files} unique PDFs, ${summary.scannedPages}/${summary.pages} pages (${summary.pageErrors} page errors); ${summary.duplicates} duplicate files. Report: ${output}`);
    console.log("Most widespread features (documents / pages / occurrences):");
    for (const row of summary.features.slice(0, 25)) {
      console.log(`${row.feature.padEnd(32)} ${String(row.documents).padStart(4)} / ${String(row.pages).padStart(5)} / ${String(row.occurrences).padStart(7)}  ${row.status}`);
    }
    for (const document of report.documents.filter((item) => item.error)) console.error(`${document.file}: ${document.error}`);
    if (summary.parsed !== summary.files) process.exitCode = 1;
  } catch (error) {
    console.error(`Census failed: ${error.stack || error}`);
    process.exitCode = 1;
  }
}
