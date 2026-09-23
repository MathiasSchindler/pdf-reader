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
      </script>`);
      return;
    }
    const filePath = path.resolve(rootDir, `.${pathname}`);
    if (!filePath.startsWith(`${rootDir}${path.sep}`)) {
      res.writeHead(403); res.end(); return;
    }
    const body = await readFile(filePath);
    const contentType = filePath.endsWith(".html") ? "text/html" : "application/javascript";
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

function buildPdf(objects) {
  const body = objects.map(([id, value]) => `${id} 0 obj\n${value}\nendobj`).join("\n");
  return Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`, "latin1");
}
