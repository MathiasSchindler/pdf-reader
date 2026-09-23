#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runs = Number(process.argv.find((arg) => arg.startsWith("--runs="))?.slice(7) || 5);
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error("--runs must be a positive integer");
}
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><canvas id=\"page\"></canvas>");
      return;
    }
    const filePath = path.resolve(rootDir, `.${pathname}`);
    if (!filePath.startsWith(`${rootDir}${path.sep}`)) {
      res.writeHead(403); res.end(); return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": filePath.endsWith(".js") ? "application/javascript" : "application/pdf" });
    res.end(body);
  } catch (error) {
    res.writeHead(404); res.end(error.message);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [name, modulePath, limits] of [
    ["source", "/src/pdf-lite/index.js", {}],
    ["viewer", "/dist/pdf-crumb.viewer.min.js", {}],
    ["viewer without caches", "/dist/pdf-crumb.viewer.min.js", { maxCachedContentBytes: 1, maxCachedImagePixels: 1 }],
  ]) {
    const samples = [];
    for (let run = 0; run < runs; run += 1) {
      const page = await browser.newPage();
      try {
        await page.goto(origin);
        samples.push(await page.evaluate(async ({ modulePath, limits }) => {
          const { loadPdfCrumb } = await import(modulePath);
          const canvas = document.getElementById("page");
          const start = performance.now();
          const pdf = await loadPdfCrumb("/pdf-files/PDF.pdf", { limits });
          const load = performance.now() - start;
          const render = async (index) => {
            const start = performance.now();
            await pdf.renderPage(index, canvas);
            return performance.now() - start;
          };
          const first = await render(0);
          const hashCanvas = () => {
            const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
            let hash = 2166136261;
            for (let index = 0; index < pixels.length; index += 4) {
              hash = Math.imul(hash ^ pixels[index], 16777619);
              hash = Math.imul(hash ^ pixels[index + 1], 16777619);
              hash = Math.imul(hash ^ pixels[index + 2], 16777619);
            }
            return (hash >>> 0).toString(16);
          };
          const hash = hashCanvas();
          const repeated = await render(0);
          const next = await render(1);
          let textCalls = 0;
          const fillText = CanvasRenderingContext2D.prototype.fillText;
          CanvasRenderingContext2D.prototype.fillText = function (...args) {
            textCalls += 1;
            return fillText.apply(this, args);
          };
          try {
            await render(0);
          } finally {
            CanvasRenderingContext2D.prototype.fillText = fillText;
          }
          const measure = document.createElement("canvas").getContext("2d");
          measure.font = "normal 400 20px Arial, Helvetica, sans-serif";
          const width = measure.measureText("A").width * 50;
          const content = Array.from({ length: 100 }, (_, index) =>
            `BT /F1 20 Tf 10 ${1100 - index * 9} Td (AAAAAAAAAAAA) Tj ET`).join("\n");
          const textUrl = (characterSpacing) => {
            const stream = characterSpacing ? `0.000001 Tc\n${content}` : content;
            const objects = [
              "<< /Type /Catalog /Pages 2 0 R >>",
              "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
              "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 1150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
              `<< /Type /Font /Subtype /Type1 /BaseFont /Arial /FirstChar 65 /Widths [${width}] >>`,
              `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
            ];
            return `data:application/pdf;base64,${btoa(`%PDF-1.4\n${objects.map((body, index) =>
              `${index + 1} 0 obj\n${body}\nendobj`).join("\n")}\n%%EOF`)}`;
          };
          const synthetic = await loadPdfCrumb(textUrl(false), { limits });
          await synthetic.renderPage(0, canvas);
          const textStart = performance.now();
          await synthetic.renderPage(0, canvas);
          const textRender = performance.now() - textStart;
          const textHash = hashCanvas();
          let syntheticCalls = 0;
          CanvasRenderingContext2D.prototype.fillText = function (...args) {
            syntheticCalls += 1;
            return fillText.apply(this, args);
          };
          try {
            await synthetic.renderPage(0, canvas);
          } finally {
            CanvasRenderingContext2D.prototype.fillText = fillText;
          }
          const unbatched = await loadPdfCrumb(textUrl(true), { limits });
          await unbatched.renderPage(0, canvas);
          const unbatchedStart = performance.now();
          await unbatched.renderPage(0, canvas);
          const unbatchedRender = performance.now() - unbatchedStart;
          const unbatchedHash = hashCanvas();
          return { load, first, repeated, next, textCalls, textRender, syntheticCalls,
            unbatchedRender, hash, textHash, unbatchedHash };
        }, { modulePath, limits }));
      } finally {
        await page.close();
      }
    }
    const median = (key) => samples.map((item) => item[key]).sort((a, b) => a - b)[Math.floor(runs / 2)].toFixed(1);
    console.log(`${name} (${runs} runs): load ${median("load")} ms, page 1 ${median("first")} ms, repeat ${median("repeated")} ms, page 2 ${median("next")} ms, page 1 text calls ${median("textCalls")}, compatible text ${median("textRender")} ms / ${median("syntheticCalls")} calls, unbatched ${median("unbatchedRender")} ms, hashes ${[...new Set(samples.map((sample) => `${sample.hash}/${sample.textHash}/${sample.unbatchedHash}`))].join(",")}`);
  }
} finally {
  await browser?.close();
  server.close();
}
