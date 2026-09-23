#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><canvas id="page"></canvas><script type="module">
        import { loadPdfCrumb } from "/src/pdf-lite/index.js";
        window.renderPdf = async (base64, limits) => {
          const pdf = await loadPdfCrumb("data:application/pdf;base64," + base64, { limits });
          const canvas = document.getElementById("page");
          await pdf.renderPage(0, canvas);
          const context = canvas.getContext("2d");
          const pixel = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data);
          return { pages: pdf.pages.length, width: canvas.width,
            center: pixel(10, 10), edge: pixel(5, 5), bottom: pixel(10, 30) };
        };
        window.renderMetrics = async (base64, limits) => {
          const pdf = await loadPdfCrumb("data:application/pdf;base64," + base64, { limits });
          const canvas = document.getElementById("page");
          const originalBitmap = createImageBitmap;
          const originalFillText = CanvasRenderingContext2D.prototype.fillText;
          let bitmapCalls = 0;
          let textCalls = 0;
          globalThis.createImageBitmap = (...args) => {
            bitmapCalls += 1;
            return originalBitmap(...args);
          };
          CanvasRenderingContext2D.prototype.fillText = function (...args) {
            textCalls += 1;
            return originalFillText.apply(this, args);
          };
          try {
            await pdf.renderPage(0, canvas);
            const first = { bitmapCalls, textCalls, cachedTokens: pdf.contentTokenCache.size,
              cachedImages: pdf.imageCache.size };
            await pdf.renderPage(0, canvas);
            return { first, bitmapCalls, textCalls, cachedTokens: pdf.contentTokenCache.size,
              cachedImages: pdf.imageCache.size };
          } finally {
            globalThis.createImageBitmap = originalBitmap;
            CanvasRenderingContext2D.prototype.fillText = originalFillText;
          }
        };
        window.renderThenAbort = async (base64) => {
          const pdf = await loadPdfCrumb("data:application/pdf;base64," + base64);
          const canvas = document.getElementById("page");
          await pdf.renderPage(0, canvas);
          const controller = new AbortController();
          controller.abort(new Error("render cancelled"));
          await pdf.renderPage(0, canvas, { signal: controller.signal });
        };
      </script>`);
      return;
    }
    const filePath = path.resolve(rootDir, `.${pathname}`);
    if (!filePath.startsWith(`${rootDir}${path.sep}`)) {
      res.writeHead(403); res.end(); return;
    }
    const body = await readFile(filePath);
    const contentType = filePath.endsWith(".html") ? "text/html" :
      filePath.endsWith(".js") || filePath.endsWith(".mjs") ? "application/javascript" :
        filePath.endsWith(".css") ? "text/css" : "application/pdf";
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
  } catch (error) {
    res.writeHead(404); res.end(error.message);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.waitForFunction(() => typeof window.renderPdf === "function");

  const tests = [
    ["keeps object delimiters inside a content stream", async () => {
      const result = await render(page, pagePdf("0 0 20 20 re f\n% endobj endstream\n"));
      assert.equal(result.pages, 1);
      assert.deepEqual(result.center, [0, 0, 0, 255]);
    }],
    ["paints fill and stroke on the same path", async () => {
      for (const operator of ["B", "B*", "b", "b*"]) {
        const result = await render(page, pagePdf(`5 5 10 10 re 1 0 0 rg 0 0 0 RG 2 w ${operator}`));
        assert.deepEqual(result.center, [255, 0, 0, 255], operator);
        assert.deepEqual(result.edge, [0, 0, 0, 255], operator);
      }
    }],
    ["rejects canvas allocations above the pixel budget", async () => {
      assert.equal((await render(page, pagePdf(""), { maxPagePixels: 400 })).width, 20);
      await assert.rejects(
        render(page, pagePdf(""), { maxPagePixels: 399 }),
        /Page canvas pixels/
      );
      await assert.rejects(render(page, pagePdf("", [0, 0, 5000, 5000])), /Page canvas pixels/);
    }],
    ["respects row padding in packed indexed images", async () => {
      const result = await render(page, indexedImagePdf());
      assert.deepEqual(result.center, [255, 255, 255, 255]);
      assert.deepEqual(result.bottom, [255, 255, 255, 255]);
    }],
    ["reuses parsed page content and decoded image bitmaps within budget", async () => {
      const pdf = indexedImagePdf();
      const cached = await metrics(page, pdf);
      assert.equal(cached.first.bitmapCalls, 1);
      assert.equal(cached.bitmapCalls, 1);
      assert.equal(cached.cachedImages, 1);
      assert.equal(cached.cachedTokens, 1);
      const uncached = await metrics(page, pdf, { maxCachedContentBytes: 1, maxCachedImagePixels: 1 });
      assert.equal(uncached.bitmapCalls, 2);
      assert.equal(uncached.cachedImages, 0);
      assert.equal(uncached.cachedTokens, 0);
    }],
    ["evicts decoded images when the cache pixel budget fills", async () => {
      const result = await metrics(page, twoImagePdf(), { maxCachedImagePixels: 2 });
      assert.equal(result.first.bitmapCalls, 2);
      assert.equal(result.bitmapCalls, 4);
      assert.equal(result.cachedImages, 1);
    }],
    ["caches form tokens but still checks aborts on repeated renders", async () => {
      const pdf = formPdf();
      const result = await metrics(page, pdf);
      assert.equal(result.cachedTokens, 2);
      await assert.rejects(
        page.evaluate((base64) => window.renderThenAbort(base64), pdf.toString("base64")),
        /render cancelled/
      );
    }],
    ["batches glyphs only when font widths match browser advances", async () => {
      const browserWidth = await page.evaluate(() => {
        const context = document.createElement("canvas").getContext("2d");
        context.font = "normal 400 20px Arial, Helvetica, sans-serif";
        return context.measureText("A").width * 50;
      });
      const batched = await metrics(page, textPdf(browserWidth));
      assert.equal(batched.first.textCalls, 1);
      assert.equal(batched.textCalls, 2);
      const separate = await metrics(page, textPdf(browserWidth + 20));
      assert.equal(separate.first.textCalls, 12);
      const digitWidths = await page.evaluate(() => {
        const context = document.createElement("canvas").getContext("2d");
        context.font = "normal 400 20px Arial, Helvetica, sans-serif";
        return Array.from({ length: 10 }, (_, index) => context.measureText(String(index)).width * 50);
      });
      const digits = await metrics(page, textPdf(digitWidths.join(" "), "202620262026", 48));
      assert.equal(digits.first.textCalls, 1);
    }],
    ["reuses the selected PDF across reader controls and invalidates on document change", async () => {
      const dev = await browser.newPage();
      let requests = 0;
      dev.on("request", (request) => {
        if (request.url().endsWith("/fixtures/pdf-lite-smoke.pdf")) requests += 1;
      });
      const rendered = () => dev.waitForFunction(() => document.getElementById("status").textContent.startsWith("Rendered "));
      try {
        await dev.goto(`${origin}/dev/index.html`);
        await rendered();
        assert.equal(requests, 1);
        await dev.locator("#scale-input").evaluate((input) => {
          input.value = "1.1";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await dev.waitForFunction(() => document.getElementById("status").textContent.includes("Rendered ") &&
          document.querySelector("#page-stack canvas")?.style.width !== "0px");
        assert.equal(requests, 1);
        await dev.locator("#view-mode-select").selectOption("pdfjs");
        await rendered();
        const withPdfJs = requests;
        await dev.locator("#scale-input").evaluate((input) => {
          input.value = "1.2";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await dev.waitForFunction(() => document.getElementById("status").textContent.includes("PDF.js mode") &&
          document.getElementById("status").textContent.startsWith("Rendered "));
        assert.equal(requests, withPdfJs);
        await dev.locator("#document-select").selectOption("pdf-lite-rotation");
        await dev.waitForFunction(() => document.getElementById("status").textContent.includes("rotation fixture") &&
          document.getElementById("status").textContent.startsWith("Rendered "));
        await dev.locator("#document-select").selectOption("pdf-lite-smoke");
        await rendered();
        assert.equal(requests, withPdfJs + 2);
      } finally {
        await dev.close();
      }
    }],
    ["does not replace an uploaded PDF when an older load finishes", async () => {
      let releaseSample;
      let sampleRequested;
      const requested = new Promise((resolve) => { sampleRequested = resolve; });
      const demo = await browser.newPage();
      await demo.route("**/pdf-files/PDF.pdf", (route) => {
        releaseSample = () => route.fulfill({
          status: 200,
          contentType: "application/pdf",
          body: pagePdf("", [0, 0, 20, 20], 2),
        });
        sampleRequested();
      });
      try {
        await demo.goto(`${origin}/dist/demo/index.html`);
        await requested;
        await demo.locator("#file-input").setInputFiles({
          name: "chosen.pdf",
          mimeType: "application/pdf",
          buffer: pagePdf("0 0 20 20 re f"),
        });
        await demo.getByText("1 / 1", { exact: true }).waitFor();
        await releaseSample();
        await demo.waitForLoadState("networkidle");
        assert.equal(await demo.locator("#status").textContent(), "1 / 1");
        assert.equal(await demo.locator("#next-button").isDisabled(), true);
      } finally {
        await demo.close();
      }
    }],
  ];

  for (const [name, test] of tests) {
    await test();
    console.log(`ok - ${name}`);
  }
} finally {
  await browser?.close();
  server.close();
}

function render(page, pdf, limits) {
  return page.evaluate(({ base64, limits }) => window.renderPdf(base64, limits), {
    base64: pdf.toString("base64"),
    limits,
  });
}

function metrics(page, pdf, limits) {
  return page.evaluate(({ base64, limits }) => window.renderMetrics(base64, limits), {
    base64: pdf.toString("base64"),
    limits,
  });
}

function textPdf(width, text = "AAAAAAAAAAAA", firstChar = 65) {
  const content = `BT /F1 20 Tf 1 3 Td (${text}) Tj ET`;
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 30] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"],
    [4, `<< /Type /Font /Subtype /Type1 /BaseFont /Arial /FirstChar ${firstChar} /Widths [${width}] >>`],
    [5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`],
  ]);
}

function pagePdf(content, mediaBox = [0, 0, 20, 20], count = 1) {
  const stream = Buffer.from(content, "latin1");
  const kids = Array.from({ length: count }, (_, index) => `${index + 5} 0 R`).join(" ");
  const pages = Array.from({ length: count }, (_, index) => [
    index + 5,
    `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(" ")}] /Resources << >> /Contents 4 0 R >>`,
  ]);
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`],
    [4, `<< /Length ${stream.length} >>\nstream\n${stream.toString("latin1")}\nendstream`],
    ...pages,
  ]);
}

function indexedImagePdf() {
  const content = "q 20 0 0 40 0 0 cm /Im1 Do Q";
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20 40] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>"],
    [4, "<< /Type /XObject /Subtype /Image /Width 1 /Height 2 /BitsPerComponent 1 /ColorSpace [/Indexed /DeviceRGB 1 <000000FFFFFF>] /Length 2 >>\nstream\n\x80\x80\nendstream"],
    [5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`],
  ]);
}

function twoImagePdf() {
  const image = "<< /Type /XObject /Subtype /Image /Width 1 /Height 2 /BitsPerComponent 1 /ColorSpace [/Indexed /DeviceRGB 1 <000000FFFFFF>] /Length 2 >>\nstream\n\x80\x80\nendstream";
  const content = "q 10 0 0 40 0 0 cm /Im1 Do Q q 10 0 0 40 10 0 cm /Im2 Do Q";
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20 40] /Resources << /XObject << /Im1 4 0 R /Im2 6 0 R >> >> /Contents 5 0 R >>"],
    [4, image],
    [5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`],
    [6, image],
  ]);
}

function formPdf() {
  const content = "/Fm1 Do";
  const form = "0 0 20 20 re f";
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20 20] /Resources << /XObject << /Fm1 4 0 R >> >> /Contents 5 0 R >>"],
    [4, `<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length ${form.length} >>\nstream\n${form}\nendstream`],
    [5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`],
  ]);
}

function buildPdf(objects) {
  const body = objects.map(([id, value]) => `${id} 0 obj\n${value}\nendobj`).join("\n");
  return Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`, "latin1");
}
