#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPdfCrumb } from "../src/pdf-lite/index.js";
import { censusDirectory, summarizeCensus } from "./pdf-census.js";

const pdfBytes = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 20 20] /Resources << /XObject << /Fm 6 0 R /Im 7 0 R >> /ExtGState << /G 8 0 R >> /Font << /F 9 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 20 20] /Contents 10 0 R >> endobj
5 0 obj << >> stream
/Fm Do /Fm Do /Im Do /G gs /F 10 Tf
endstream endobj
6 0 obj << /Type /XObject /Subtype /Form /Group << /S /Transparency >> /BBox [0 0 20 20] /Resources << /XObject << /Inner 11 0 R >> >> >> stream
/Inner Do
endstream endobj
7 0 obj << /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /FlateDecode >> stream
x
endstream endobj
8 0 obj << /Type /ExtGState /SMask << /S /Luminosity >> /BM /Multiply /ca 0.5 >> endobj
9 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
10 0 obj << >> stream

endstream endobj
11 0 obj << /Type /XObject /Subtype /Form /BBox [0 0 20 20] >> stream
/S sh
endstream endobj
trailer << /Root 1 0 R >>
%%EOF
`, "latin1");

const pdf = await loadPdfCrumb(`data:application/pdf;base64,${pdfBytes.toString("base64")}`);
const first = await pdf.censusPage(0);
assert.equal(first.features["form:xobject"], 4);
assert.equal(first.features["shading:paint"], 2);
assert.equal(first.features["transparency:group"], 2);
assert.equal(first.features["transparency:soft-mask"], 1);
assert.equal(first.features["transparency:blend-mode"], 1);
assert.equal(first.features["image:bits:1"], 1);
assert.equal(first.features["image:filter:FlateDecode"], 1);
assert.equal(first.features["font:Type1"], 1);
assert.deepEqual(first.errors, []);
const second = await pdf.censusPage(1);
assert.deepEqual(second.features, {});
assert.rejects(pdf.censusPage(2), /Page 3 not found/);

const summary = summarizeCensus([
  { file: "first.pdf", pageResults: [{ page: 1, ...first }, { page: 2, ...second }] },
  { file: "second.pdf", pageResults: [{ page: 3, ...first }] },
]);
assert.equal(summary.features.find((row) => row.feature === "shading:paint").documents, 2);
assert.equal(summary.features.find((row) => row.feature === "shading:paint").pages, 2);
assert.equal(summary.features.find((row) => row.feature === "shading:paint").occurrences, 4);
assert.equal(summary.features.find((row) => row.feature === "shading:paint").status, "unsupported");
assert.deepEqual(summary.features.find((row) => row.feature === "shading:paint").examples, [
  { file: "first.pdf", page: 1 }, { file: "second.pdf", page: 3 },
]);
assert.equal(summarizeCensus([{ pageResults: [{ page: 1, features: { "image:filter:CCITTFaxDecode": 1 } }] }])
  .features[0].status, "unsupported");
assert.equal(summarizeCensus([{ pageResults: [{ page: 1, features: { "operator:BX": 1 } }] }])
  .features[0].status, "observed");

const folder = await mkdtemp(path.join(os.tmpdir(), "pdf-census-"));
try {
  await writeFile(path.join(folder, "a.pdf"), pdfBytes);
  await writeFile(path.join(folder, "b.PDF"), pdfBytes);
  await writeFile(path.join(folder, "bad.pdf"), "not a PDF");
  const report = await censusDirectory(folder);
  assert.equal(report.summary.files, 2);
  assert.equal(report.summary.duplicates, 1);
  assert.equal(report.summary.parsed, 1);
  assert.equal(report.summary.scannedPages, 2);
  assert.equal(report.documents.find((row) => row.file === "b.PDF").duplicateOf, "a.pdf");
  assert.match(report.documents.find((row) => row.file === "bad.pdf").error, /Invalid PDF/);
} finally {
  await rm(folder, { recursive: true, force: true });
}
console.log("Census synthetic tests passed.");
