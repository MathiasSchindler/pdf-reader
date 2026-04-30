#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = [];

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(`<!doctype html><meta charset="utf-8"><canvas id="c"></canvas><script type="module">
        import { DEFAULT_SECURITY_LIMITS, loadPdfCrumb } from "/src/pdf-lite/index.js";
        window.__pdfSecurity = {
          DEFAULT_SECURITY_LIMITS,
          load: async (base64, options = {}) => {
            const url = ` + "`data:application/pdf;base64,${base64}`" + `;
            const pdf = await loadPdfCrumb(url, options);
            return pdf.audit();
          },
          render: async (base64, options = {}, renderOptions = {}) => {
            const url = ` + "`data:application/pdf;base64,${base64}`" + `;
            const pdf = await loadPdfCrumb(url, options);
            const canvas = document.getElementById("c");
            const result = await pdf.renderPage(0, canvas, renderOptions);
            return { audit: pdf.audit(), unsupported: Object.fromEntries(result.unsupportedOperators || []) };
          },
          renderRepeated: async (base64, options = {}, renderOptions = {}, count = 2) => {
            const url = ` + "`data:application/pdf;base64,${base64}`" + `;
            const pdf = await loadPdfCrumb(url, options);
            const canvas = document.getElementById("c");
            let result = null;
            for (let index = 0; index < count; index += 1) {
              result = await pdf.renderPage(0, canvas, renderOptions);
            }
            return { audit: pdf.audit(), unsupported: Object.fromEntries(result?.unsupportedOperators || []) };
          },
          loadWithAbortedSignal: async (base64) => {
            const controller = new AbortController();
            controller.abort(new Error("test abort"));
            const url = ` + "`data:application/pdf;base64,${base64}`" + `;
            await loadPdfCrumb(url, { signal: controller.signal });
          },
        };
        window.__ready = true;
      </script>`);
      return;
    }
    const filePath = path.join(rootDir, urlPath.replace(/^\//, ""));
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

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => window.__ready === true);

try {
  await run("reports active PDF content without executing it", async () => {
    const audit = await load(activeContentPdf());
    assert.equal(audit.pages, 1);
    assert.equal(audit.activeContent.OpenAction, 1);
    assert.equal(audit.activeContent.JavaScript, 1);
    assert.equal(audit.activeContent.JS, 1);
  });

  await run("rejects inputs above configured byte budget", async () => {
    await assertRejects(load(activeContentPdf(), { limits: { maxInputBytes: 64 } }), /Input PDF size/);
  });

  await run("aborts before parsing when a signal is already aborted", async () => {
    await assertRejects(page.evaluate((base64) => window.__pdfSecurity.loadWithAbortedSignal(base64), b64(activeContentPdf())), /test abort|aborted/i);
  });

  await run("does not allocate ImageData beyond the image pixel budget", async () => {
    const result = await render(hugeImagePdf(), { limits: { maxImageDimension: 1000, maxImagePixels: 1_000_000 } });
    assert.equal(result.unsupported["Do/ImageLimit"], 1);
  });

  await run("rejects content streams above the decoded stream budget", async () => {
    await assertRejects(render(compressedContentPdf("q\n".repeat(200)), { limits: { maxDecodedStreamBytes: 32 } }), /Decoded Flate stream size|Decoded stream size/);
  });

  await run("does not re-count cached decoded streams on repeated renders", async () => {
    const result = await renderRepeated(compressedImagePdf(), { limits: { maxDecodedDocumentBytes: 50 } }, {}, 2);
    assert.deepEqual(result.unsupported, {});
  });

  await run("rejects pages above the content operator budget", async () => {
    await assertRejects(render(contentPdf("q\n".repeat(20)), { limits: { maxContentOperators: 5 } }), /content operators/);
  });
} finally {
  await browser.close();
  server.close();
}

for (const item of tests) {
  console.log(`${item.ok ? "ok" : "not ok"} - ${item.name}${item.error ? `: ${item.error}` : ""}`);
}
if (tests.some((item) => !item.ok)) process.exitCode = 1;

async function run(name, fn) {
  try {
    await fn();
    tests.push({ name, ok: true });
  } catch (error) {
    tests.push({ name, ok: false, error: error.stack || error.message || String(error) });
  }
}

async function load(pdf, options = {}) {
  return page.evaluate(({ base64, options }) => window.__pdfSecurity.load(base64, options), { base64: b64(pdf), options });
}

async function render(pdf, options = {}, renderOptions = {}) {
  return page.evaluate(({ base64, options, renderOptions }) => window.__pdfSecurity.render(base64, options, renderOptions), { base64: b64(pdf), options, renderOptions });
}

async function renderRepeated(pdf, options = {}, renderOptions = {}, count = 2) {
  return page.evaluate(({ base64, options, renderOptions, count }) => window.__pdfSecurity.renderRepeated(base64, options, renderOptions, count), { base64: b64(pdf), options, renderOptions, count });
}

async function assertRejects(promise, pattern) {
  let thrown = null;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "expected promise to reject");
  assert.match(String(thrown.message || thrown), pattern);
}

function activeContentPdf() {
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert) >> >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>"],
  ]);
}

function contentPdf(content) {
  const stream = Buffer.from(content, "latin1");
  return pagePdf(stream, "");
}

function compressedContentPdf(content) {
  const stream = deflateSync(Buffer.from(content, "latin1"));
  return pagePdf(stream, "/Filter /FlateDecode ");
}

function hugeImagePdf() {
  const content = Buffer.from("q 1 0 0 1 0 0 cm /Im1 Do Q", "latin1");
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>"],
    [4, "<< /Type /XObject /Subtype /Image /Width 50000 /Height 50000 /BitsPerComponent 8 /ColorSpace /DeviceGray /Length 1 >>\nstream\n0\nendstream"],
    [5, `<< /Length ${content.length} >>\nstream\n${content.toString("latin1")}\nendstream`],
  ]);
}

function compressedImagePdf() {
  const content = Buffer.from("q 2 0 0 2 0 0 cm /Im1 Do Q", "latin1");
  const image = deflateSync(Buffer.from([
    255, 0, 0, 0, 255, 0,
    0, 0, 255, 255, 255, 0,
  ]));
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20 20] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>"],
    [4, `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode /Length ${image.length} >>\nstream\n${image.toString("latin1")}\nendstream`],
    [5, `<< /Length ${content.length} >>\nstream\n${content.toString("latin1")}\nendstream`],
  ]);
}

function pagePdf(stream, extraDictionary) {
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>"],
    [4, `<< ${extraDictionary}/Length ${stream.length} >>\nstream\n${stream.toString("latin1")}\nendstream`],
  ]);
}

function buildPdf(objects) {
  const body = objects.map(([id, value]) => `${id} 0 obj\n${value}\nendobj`).join("\n");
  return Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`, "latin1");
}

function b64(pdf) {
  return Buffer.from(pdf).toString("base64");
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}
