#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
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
    ["paints CMYK fill and stroke and updates device color spaces", async () => {
      const content = [
        "0 1 1 0 k 0 0 20 20 re f",
        "0 0 0 1 K 2 w 3 3 14 14 re S",
        "1 0 1 0 k 20 0 20 20 re f",
        "1 1 0 0 k 40 0 20 20 re f",
        "0 0 0 1 k 60 0 20 20 re f",
        "0 0 0 0 k 80 0 20 20 re f",
        "1 1 0 0 k 1 0 0 rg 0 1 0 sc 0 20 20 20 re f",
        "0 1 1 0 k 0 g 0.5 sc 20 20 20 20 re f",
        "0 g q 0 0 0 1 k Q 0.5 sc 40 20 20 20 re f",
        "0 1 1 0 K 0 G 0.5 SC 2 w 65 24 10 10 re S",
      ].join("\n");
      const result = await page.evaluate(async (base64) => {
        const url = `data:application/pdf;base64,${base64}`;
        const { loadPdfCrumb } = await import("/src/pdf-lite/index.js");
        const { loadPdfJsDocument, renderPdfJsPage } = await import("/src/comparison.js");
        const pdf = await loadPdfCrumb(url);
        const reference = await loadPdfJsDocument(url);
        try {
          const actual = document.createElement("canvas");
          const expected = document.createElement("canvas");
          await pdf.renderPage(0, actual);
          await renderPdfJsPage(reference, 0, expected, 1);
          const points = [[10, 30], [3, 30], [30, 30], [50, 30], [70, 30], [90, 30],
            [10, 10], [30, 10], [50, 10], [65, 10]];
          const sample = (canvas) => {
            const context = canvas.getContext("2d");
            return points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data));
          };
          return {
            actual: sample(actual),
            expected: sample(expected),
            unsupported: Array.from((await pdf.renderPage(0, actual)).unsupportedOperators.keys()),
            features: (await pdf.censusPage(0)).features,
          };
        } finally {
          await reference.destroy();
        }
      }, pagePdf(content, [0, 0, 100, 40]).toString("base64"));
      assert.deepEqual(result.actual, [
        [255, 0, 0, 255], [0, 0, 0, 255], [0, 255, 0, 255],
        [0, 0, 255, 255], [0, 0, 0, 255], [255, 255, 255, 255],
        [0, 255, 0, 255], [128, 128, 128, 255], [128, 128, 128, 255],
        [128, 128, 128, 255],
      ]);
      for (const index of [5, 6, 7, 8, 9]) assert.deepEqual(result.actual[index], result.expected[index]);
      assert.ok(result.expected[0][0] > result.expected[0][1] && result.expected[0][0] > result.expected[0][2]);
      assert.ok(result.expected[2][1] > result.expected[2][0] && result.expected[2][1] > result.expected[2][2]);
      assert.ok(result.expected[3][2] > result.expected[3][0] && result.expected[3][2] > result.expected[3][1]);
      for (const index of [1, 4]) assert.ok(Math.max(...result.expected[index].slice(0, 3)) < 100);
      assert.deepEqual(result.unsupported, []);
      assert.equal(result.features["color:DeviceCMYK-fill"], 8);
      assert.equal(result.features["color:DeviceCMYK-stroke"], 2);
      assert.equal(result.features["operator:k"], undefined);
      assert.equal(result.features["operator:K"], undefined);
    }],
    ["composites isolated Forms with blend modes and luminosity soft masks", async () => {
      for (const variant of ["blend", "mask", "alpha", "shading"]) {
        const result = await page.evaluate(async (base64) => {
          const url = `data:application/pdf;base64,${base64}`;
          const { loadPdfCrumb } = await import("/src/pdf-lite/index.js");
          const { loadPdfJsDocument, renderPdfJsPage, paintDifferenceCanvas } = await import("/src/comparison.js");
          const pdf = await loadPdfCrumb(url);
          const reference = await loadPdfJsDocument(url);
          try {
            const left = document.createElement("canvas");
            const right = document.createElement("canvas");
            const output = await pdf.renderPage(0, left);
            await renderPdfJsPage(reference, 0, right, 1);
            const sample = (canvas) => [[10, 10], [30, 10]]
              .map(([x, y]) => Array.from(canvas.getContext("2d").getImageData(x, y, 1, 1).data));
            const diff = paintDifferenceCanvas(document.createElement("canvas"), left, right);
            return {
              actual: sample(left), expected: sample(right),
              strong: diff.substantialPixels / diff.totalPixels,
              unsupported: [...output.unsupportedOperators],
            };
          } finally {
            await reference.destroy();
          }
        }, transparencyPdf(variant).toString("base64"));
        assert.deepEqual(result.unsupported, [], JSON.stringify({ variant, result }));
        if (variant === "blend") {
          assert.deepEqual(result.actual, [[0, 0, 0, 255], [0, 0, 0, 255]]);
        } else if (variant === "alpha") {
          assert.deepEqual(result.actual, [[255, 0, 0, 255], [255, 0, 0, 255]]);
        } else {
          assert.deepEqual(result.actual[1], [0, 0, 255, 255]);
          if (variant === "mask") assert.deepEqual(result.actual[0], [255, 0, 0, 255]);
        }
        assert.ok(result.strong < 0.08, JSON.stringify({ variant, result }));
      }
      await assert.rejects(page.evaluate(async (base64) => {
        const { loadPdfCrumb } = await import("/src/pdf-lite/index.js");
        const pdf = await loadPdfCrumb(`data:application/pdf;base64,${base64}`, {
          limits: { maxTransparencyPixels: 100 },
        });
        await pdf.renderPage(0, document.createElement("canvas"));
      }, transparencyPdf("mask").toString("base64")), /Transparency layer pixels/);
      await assert.rejects(page.evaluate(async (base64) => {
        const { loadPdfCrumb } = await import("/src/pdf-lite/index.js");
        const pdf = await loadPdfCrumb(`data:application/pdf;base64,${base64}`, {
          limits: { maxActiveTransparencyPixels: 1500 },
        });
        await pdf.renderPage(0, document.createElement("canvas"));
      }, transparencyPdf("mask").toString("base64")), /Active transparency pixels/);
      const unsupported = await page.evaluate(async (base64) => {
        const { loadPdfCrumb } = await import("/src/pdf-lite/index.js");
        const pdf = await loadPdfCrumb(`data:application/pdf;base64,${base64}`);
        const canvas = document.createElement("canvas");
        const output = await pdf.renderPage(0, canvas);
        return {
          operators: [...output.unsupportedOperators.keys()],
          pixel: Array.from(canvas.getContext("2d").getImageData(10, 10, 1, 1).data),
        };
      }, transparencyPdf("nonisolated-shading").toString("base64"));
      assert.ok(unsupported.operators.includes("Do/TransparencyNonIsolated"));
      assert.ok(unsupported.operators.includes("sh/NonIsolatedSoftMask"));
      assert.deepEqual(unsupported.pixel, [0, 0, 255, 255]);
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
    ["renders padded grayscale images with their Decode polarity", async () => {
      for (const invert of [false, true]) {
        const result = await page.evaluate(async (base64) => {
          const url = `data:application/pdf;base64,${base64}`;
          const { loadPdfCrumb } = await import("/src/pdf-lite/index.js");
          const { loadPdfJsDocument, renderPdfJsPage } = await import("/src/comparison.js");
          const pdf = await loadPdfCrumb(url);
          const reference = await loadPdfJsDocument(url);
          try {
            const first = document.createElement("canvas");
            const second = document.createElement("canvas");
            await pdf.renderPage(0, first);
            await renderPdfJsPage(reference, 0, second, 1);
            const sample = (canvas) => {
              const context = canvas.getContext("2d");
              return [[5, 5], [15, 5], [5, 15], [15, 15]]
                .map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data));
            };
            return { actual: sample(first), expected: sample(second) };
          } finally {
            await reference.destroy();
          }
        }, grayscaleImagePdf(invert).toString("base64"));
        const black = [0, 0, 0, 255];
        const white = [255, 255, 255, 255];
        assert.deepEqual(result.actual, invert
          ? [white, black, black, white]
          : [black, white, white, black]);
        assert.deepEqual(result.actual, result.expected);
      }
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
    ["renders embedded CID CFF glyphs with their PDF widths", async () => {
      for (const format of [0, 1, 2]) {
        const result = await page.evaluate(async (base64) => {
          const url = `data:application/pdf;base64,${base64}`;
          const { loadPdfCrumb } = await import("/src/pdf-lite/index.js");
          const { loadPdfJsDocument, paintDifferenceCanvas, renderPdfJsPage } = await import("/src/comparison.js");
          const lite = await loadPdfCrumb(url);
          const reference = await loadPdfJsDocument(url);
          try {
            const left = document.createElement("canvas");
            const right = document.createElement("canvas");
            await lite.renderPage(0, left);
            await renderPdfJsPage(reference, 0, right, 1);
            const { changedPixels, substantialPixels, totalPixels } =
              paintDifferenceCanvas(document.createElement("canvas"), left, right);
            const pixel = (canvas, x) => Array.from(canvas.getContext("2d").getImageData(x, 40, 1, 1).data);
            return {
              font: lite.audit().fonts[0], warnings: lite.warnings, changedPixels, substantialPixels,
              totalPixels, litePixel: pixel(left, 18), referencePixel: pixel(right, 18),
              secondLitePixel: pixel(left, 38), secondReferencePixel: pixel(right, 38),
            };
          } finally {
            await reference.destroy();
          }
        }, cidCffPdf("Identity-H", format).toString("base64"));
        assert.equal(result.font.embeddedFontFormat, "CIDFontType0C");
        assert.equal(result.font.embeddedFontLoaded, true, result.font.embeddedFontError);
        assert.deepEqual(result.warnings, []);
        assert.deepEqual(result.litePixel, [0, 0, 0, 255]);
        assert.deepEqual(result.referencePixel, [0, 0, 0, 255]);
        assert.deepEqual(result.secondLitePixel, [0, 0, 0, 255]);
        assert.deepEqual(result.secondReferencePixel, [0, 0, 0, 255]);
        assert.ok(result.substantialPixels / result.totalPixels < 0.05, JSON.stringify(result));
      }
    }],
    ["loads fonts declared only in nested Form resources", async () => {
      const result = await page.evaluate(async (base64) => {
        const url = `data:application/pdf;base64,${base64}`;
        const { loadPdfCrumb } = await import("/src/pdf-lite/index.js");
        const { loadPdfJsDocument, renderPdfJsPage, paintDifferenceCanvas } = await import("/src/comparison.js");
        const pdf = await loadPdfCrumb(url);
        const reference = await loadPdfJsDocument(url);
        try {
          const left = document.createElement("canvas");
          const right = document.createElement("canvas");
          await pdf.renderPage(0, left);
          await renderPdfJsPage(reference, 0, right, 1);
          const difference = paintDifferenceCanvas(document.createElement("canvas"), left, right);
          const census = await pdf.censusPage(0);
          return {
            fonts: pdf.audit().fonts, warnings: pdf.warnings,
            changedFraction: difference.substantialPixels / difference.totalPixels,
            formFontMissing: census.features["font:form-resource-uncollected"] || 0,
          };
        } finally {
          await reference.destroy();
        }
      }, cidCffPdf("Identity-H", 0, "rectangle", true).toString("base64"));
      assert.equal(result.fonts.length, 1);
      assert.equal(result.fonts[0].embeddedFontLoaded, true, result.fonts[0].embeddedFontError);
      assert.equal(result.formFontMissing, 0);
      assert.deepEqual(result.warnings, []);
      assert.ok(result.changedFraction < 0.05, JSON.stringify(result));
    }],
    ["installs embedded TrueType subsets without OS/2 for simple and CID text", async () => {
      for (const cid of [false, true]) {
        const result = await page.evaluate(async (base64) => {
          const { loadPdfCrumb } = await import("/src/pdf-lite/index.js");
          const pdf = await loadPdfCrumb(`data:application/pdf;base64,${base64}`);
          const canvas = document.createElement("canvas");
          await pdf.renderPage(0, canvas);
          const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
          let ink = 0;
          for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 128) ink += 1;
          return {
            font: pdf.audit().fonts[0],
            warnings: pdf.warnings,
            ink,
            pixel: Array.from(canvas.getContext("2d").getImageData(18, 40, 1, 1).data),
          };
        }, subsetTrueTypePdf(cid).toString("base64"));
        assert.equal(result.font.embeddedFontLoaded, true, JSON.stringify(result));
        assert.deepEqual(result.warnings, []);
        assert.deepEqual(result.pixel, [0, 0, 0, 255], JSON.stringify({ cid, result }));
      }
    }],
    ["reports CID CFF fonts that cannot be installed", async () => {
      for (const encoding of ["UnsupportedEncoding", "Identity-V"]) {
        const result = await page.evaluate(async (base64) => {
          const { loadPdfCrumb } = await import("/src/pdf-lite/index.js");
          const pdf = await loadPdfCrumb(`data:application/pdf;base64,${base64}`);
          return { font: pdf.audit().fonts[0], warnings: pdf.warnings };
        }, cidCffPdf(encoding).toString("base64"));
        assert.equal(result.font.embeddedFontLoaded, false);
        assert.match(result.font.embeddedFontError, new RegExp(`Unsupported CID CFF encoding ${encoding}`));
        assert.match(result.warnings.join("\n"), /Font F1 .*Unsupported CID CFF encoding/);
      }
    }],
    ["keeps embedded font families distinct between documents", async () => {
      const result = await page.evaluate(async ([firstBytes, secondBytes]) => {
        const { loadPdfCrumb } = await import("/src/pdf-lite/index.js");
        const first = await loadPdfCrumb(`data:application/pdf;base64,${firstBytes}`);
        const second = await loadPdfCrumb(`data:application/pdf;base64,${secondBytes}`);
        const render = async (pdf) => {
          const canvas = document.createElement("canvas");
          await pdf.renderPage(0, canvas);
          return Array.from(canvas.getContext("2d").getImageData(12, 37, 1, 1).data);
        };
        return {
          firstFamily: [...first.fonts.values()][0].embeddedFontFamily,
          secondFamily: [...second.fonts.values()][0].embeddedFontFamily,
          firstPixel: await render(first),
          secondPixel: await render(second),
        };
      }, [cidCffPdf().toString("base64"), cidCffPdf("Identity-H", 0, "triangle").toString("base64")]);
      assert.notEqual(result.firstFamily, result.secondFamily);
      assert.deepEqual(result.firstPixel, [0, 0, 0, 255]);
      assert.deepEqual(result.secondPixel, [255, 255, 255, 255]);
    }],
    ["decrypts Standard R2 streams and strings before rendering", async () => {
      const result = await page.evaluate(async (base64) => {
        const url = `data:application/pdf;base64,${base64}`;
        const { loadPdfCrumb } = await import("/src/pdf-lite/index.js");
        const { loadPdfJsDocument, renderPdfJsPage, paintDifferenceCanvas } = await import("/src/comparison.js");
        const pdf = await loadPdfCrumb(url);
        const reference = await loadPdfJsDocument(url);
        try {
          const first = document.createElement("canvas");
          const second = document.createElement("canvas");
          await pdf.renderPage(0, first);
          await renderPdfJsPage(reference, 0, second, 1);
          const difference = paintDifferenceCanvas(document.createElement("canvas"), first, second);
          const pixel = (canvas) => Array.from(canvas.getContext("2d").getImageData(10, 10, 1, 1).data);
          return {
            pages: pdf.pages.length, title: pdf.objects.get(7).value.Title.hex,
            subject: pdf.objects.get(7).value.Subject.string,
            firstPixel: pixel(first), secondPixel: pixel(second),
            changedPixels: difference.changedPixels,
          };
        } finally {
          await reference.destroy();
        }
      }, standardR2Pdf().toString("base64"));
      assert.equal(result.pages, 1);
      assert.equal(Buffer.from(result.title, "hex").toString("latin1"), "Private title");
      assert.equal(result.subject, "Private subject");
      assert.deepEqual(result.firstPixel, [0, 0, 0, 255]);
      assert.deepEqual(result.secondPixel, [0, 0, 0, 255]);
      assert.ok(result.changedPixels < 80, JSON.stringify(result));
    }],
    ["rejects wrong passwords and unsupported encryption instead of rendering blank pages", async () => {
      const secured = standardR2Pdf({ password: "reader" }).toString("base64");
      const unsupported = standardR2Pdf({ revision: 3 }).toString("base64");
      await assert.rejects(page.evaluate(async (base64) => {
        const { loadPdfCrumb } = await import("/src/pdf-lite/index.js");
        await loadPdfCrumb(`data:application/pdf;base64,${base64}`);
      }, secured), /valid password is required/);
      await assert.rejects(page.evaluate(async (base64) => {
        const { loadPdfCrumb } = await import("/src/pdf-lite/index.js");
        await loadPdfCrumb(`data:application/pdf;base64,${base64}`);
      }, unsupported), /Unsupported PDF encryption/);
      const pageCounts = await page.evaluate(async (base64) => {
        const { loadPdfCrumb } = await import("/src/pdf-lite/index.js");
        const url = `data:application/pdf;base64,${base64}`;
        const user = await loadPdfCrumb(url, { password: "reader" });
        const owner = await loadPdfCrumb(url, { password: "owner" });
        return [user.pages.length, owner.pages.length, user.password, owner.password];
      }, secured);
      assert.deepEqual(pageCounts, [1, 1, null, null]);
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
    ["compares local paths and marks shareable page coordinates", async () => {
      const compare = await browser.newPage();
      let pdfRequests = 0;
      let externalRequests = 0;
      compare.on("request", (request) => {
        if (request.url().endsWith("/fixtures/pdf-lite-smoke.pdf")) pdfRequests += 1;
        if (request.url().startsWith("https://example.com/")) externalRequests += 1;
      });
      try {
        await compare.goto(`${origin}/compare/index.html?pdf=../fixtures/pdf-lite-smoke.pdf&page=1&scale=1.25&font=stable`);
        await compare.waitForFunction(() => document.getElementById("status").textContent.startsWith("Rendered page 1"));
        assert.equal(await compare.locator("#scale").inputValue(), "1.25");
        assert.equal(await compare.locator("#font-mode").inputValue(), "stable");
        assert.equal(await compare.locator("#lite-pane canvas").count(), 1);
        assert.equal(await compare.locator("#pdfjs-pane canvas").count(), 1);
        assert.equal(await compare.locator("#difference-pane canvas").count(), 1);
        assert.match(await compare.locator("#report-output").inputValue(), /Strong differences \(>20\/255\): \d+ \/ \d+/);
        const loadedRequests = pdfRequests;
        await compare.locator("#lite-pane canvas").click({ position: { x: 8, y: 8 } });
        assert.equal(await compare.locator(".compare-marker").count(), 3);
        assert.match(await compare.locator("#report-output").inputValue(), /Marked location: \d+ × \d+ on pdf-crumb canvas/);
        await compare.locator("#scale").selectOption("1.5");
        await compare.waitForFunction(() => document.getElementById("report-output").value.includes("Scale: 1.5") &&
          document.getElementById("status").textContent.startsWith("Rendered page"));
        assert.equal(pdfRequests, loadedRequests);
        assert.equal(new URL(compare.url()).searchParams.get("scale"), "1.5");
        await compare.locator("#source-path").fill("https://example.com/private.pdf");
        await compare.locator("#source-form button").click();
        await compare.waitForFunction(() => document.getElementById("status").textContent.includes("Enter a PDF path on this server"));
        assert.equal(externalRequests, 0);
      } finally {
        await compare.close();
      }
    }],
    ["counts strong pixel differences separately from cosmetic differences", async () => {
      const result = await page.evaluate(async () => {
        const { paintDifferenceCanvas } = await import("/src/comparison.js");
        const left = document.createElement("canvas");
        const right = document.createElement("canvas");
        left.width = right.width = 2;
        left.height = right.height = 1;
        left.getContext("2d").fillStyle = "#ffffff";
        left.getContext("2d").fillRect(0, 0, 2, 1);
        const context = right.getContext("2d");
        context.fillStyle = "#eeeeee";
        context.fillRect(0, 0, 1, 1);
        context.fillStyle = "#dddddd";
        context.fillRect(1, 0, 1, 1);
        const { changedPixels, substantialPixels, totalPixels, redPixels, greenPixels } =
          paintDifferenceCanvas(document.createElement("canvas"), left, right);
        return { changedPixels, substantialPixels, totalPixels, redPixels, greenPixels };
      });
      assert.deepEqual(result, { changedPixels: 2, substantialPixels: 1, totalPixels: 2, redPixels: 2, greenPixels: 0 });
    }],
    ["compares an upload, navigates pages and copies a report without a blob URL", async () => {
      const compare = await browser.newPage();
      try {
        await compare.goto(`${origin}/compare/index.html?pdf=../fixtures/pdf-lite-smoke.pdf`);
        await compare.waitForFunction(() => document.getElementById("status").textContent.startsWith("Rendered page"));
        await compare.locator("#file-input").setInputFiles({
          name: "sample-upload.pdf",
          mimeType: "application/pdf",
          buffer: pagePdf("0 0 10 10 re f", [0, 0, 20, 20], 2),
        });
        await compare.waitForFunction(() => document.getElementById("status").textContent.startsWith("Rendered page 1 of 2"));
        await compare.locator("#next-page").click();
        await compare.waitForFunction(() => document.getElementById("status").textContent.startsWith("Rendered page 2 of 2"));
        const report = await compare.locator("#report-output").inputValue();
        assert.match(report, /PDF: sample-upload\.pdf/);
        assert.match(report, /Page: 2 \/ pdf-crumb 2, PDF\.js 2/);
        assert.match(report, /Local upload \(re-upload required; no shareable URL\)/);
        assert.doesNotMatch(report, /blob:/);
        await compare.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
        await compare.locator("#copy-report").click();
        assert.equal((await compare.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"), report);
        assert.equal(new URL(compare.url()).search, "");
        await compare.locator("#source-path").fill("../fixtures/pdf-lite-smoke.pdf");
        await compare.locator("#source-form button").click();
        await compare.waitForFunction(() => document.getElementById("status").textContent.startsWith("Rendered page 1 of 1"));
      } finally {
        await compare.close();
      }
    }],
    ["reports load failures instead of presenting an empty successful comparison", async () => {
      const compare = await browser.newPage();
      try {
        await compare.goto(`${origin}/compare/index.html?pdf=../pdf-files/missing.pdf`);
        await compare.waitForFunction(() => document.getElementById("status").textContent.includes("Neither renderer could open"));
        const report = await compare.locator("#report-output").inputValue();
        assert.match(report, /lite error: Could not fetch/);
        assert.match(report, /pdfjs error:/);
        assert.equal(await compare.locator("#difference-pane canvas").count(), 0);
      } finally {
        await compare.close();
      }
    }],
    ["rejects comparison canvases beyond the page pixel budget", async () => {
      const compare = await browser.newPage();
      try {
        await compare.goto(`${origin}/compare/index.html`);
        await compare.locator("#file-input").setInputFiles({
          name: "oversized.pdf",
          mimeType: "application/pdf",
          buffer: pagePdf("", [0, 0, 2100, 2100]),
        });
        await compare.waitForFunction(() => document.getElementById("status").textContent.includes("Comparison incomplete"));
        const report = await compare.locator("#report-output").inputValue();
        assert.match(report, /lite error: PDF limit exceeded: Page canvas pixels/);
        assert.match(report, /pdfjs error: Comparison page exceeds 4000000 pixels/);
        assert.equal(await compare.locator("#lite-pane canvas, #pdfjs-pane canvas").count(), 0);
      } finally {
        await compare.close();
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

function transparencyPdf(variant) {
  const background = "0 0 1 rg 0 0 40 20 re f";
  const pageContent = `${background} q /${variant === "blend" ? "Multiply" : "Mask"} gs /Fm Do Q`;
  const formContent = ["shading", "nonisolated-shading"].includes(variant) ? "/Sh sh" : "1 0 0 rg 0 0 40 20 re f";
  const maskContent = "1 g 0 0 20 20 re f 0 g 20 0 20 20 re f";
  const samples = Buffer.from([255, 0, 0, 0, 0, 255]);
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 40 20] /Resources << /XObject << /Fm 5 0 R >> /ExtGState << /Mask 6 0 R /Multiply 8 0 R >> >> /Contents 4 0 R >>"],
    [4, `<< /Length ${pageContent.length} >>\nstream\n${pageContent}\nendstream`],
    [5, `<< /Type /XObject /Subtype /Form /BBox [0 0 40 20] /Group << /S /Transparency ${variant === "nonisolated-shading" ? "" : "/I true"} /CS /DeviceRGB >> /Resources << /Shading << /Sh 9 0 R >> >> /Length ${formContent.length} >>\nstream\n${formContent}\nendstream`],
    [6, `<< /Type /ExtGState /SMask << /S /${variant === "alpha" ? "Alpha" : "Luminosity"} /G 7 0 R /BC [0 0 0] >> >>`],
    [7, `<< /Type /XObject /Subtype /Form /BBox [0 0 40 20] /Group << /S /Transparency /I true /CS /DeviceRGB >> /Length ${maskContent.length} >>\nstream\n${maskContent}\nendstream`],
    [8, "<< /Type /ExtGState /BM /Multiply >>"],
    [9, "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 40 0] /Function 10 0 R /Extend [true true] >>"],
    [10, "<< /FunctionType 3 /Domain [0 1] /Functions [11 0 R] /Bounds [] /Encode [0 1] >>"],
    [11, `<< /FunctionType 0 /Domain [0 1] /Range [0 1 0 1 0 1] /Size [2] /BitsPerSample 8 /Decode [0 1 0 1 0 1] /Encode [0 1] /Length ${samples.length} >>\nstream\n${samples.toString("latin1")}\nendstream`],
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

function grayscaleImagePdf(invert) {
  const content = "q 30 0 0 20 0 0 cm /Im1 Do Q";
  const decode = invert ? "/Decode [1 0] " : "";
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 30 20] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>"],
    [4, `<< /Type /XObject /Subtype /Image /Width 3 /Height 2 /BitsPerComponent 1 /ColorSpace /DeviceGray ${decode}/Length 2 >>\nstream\n\x40\xA0\nendstream`],
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

function cidCffPdf(encoding = "Identity-H", charsetFormat = 0, shape = "rectangle", nestedForm = false) {
  const cff = cidCffFont(charsetFormat, shape);
  const text = "BT /F1 30 Tf 1 0 0 1 10 10 Tm <00410041> Tj ET";
  const pageContent = nestedForm ? "/Outer Do" : text;
  const toUnicode = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfchar\n<0041> <0041>\nendbfchar\nendcmap\nend\nend";
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 80 60] /Resources << ${nestedForm ? "/XObject << /Outer 10 0 R >>" : "/Font << /F1 4 0 R >>"} >> /Contents 5 0 R >>`],
    [4, `<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticCID /Encoding /${encoding} /DescendantFonts [6 0 R] /ToUnicode 8 0 R >>`],
    [5, `<< /Length ${pageContent.length} >>\nstream\n${pageContent}\nendstream`],
    [6, "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /SyntheticCID /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 300 /W [65 [600]] >>"],
    [7, "<< /Type /FontDescriptor /FontName /SyntheticCID /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile3 9 0 R >>"],
    [8, `<< /Length ${toUnicode.length} >>\nstream\n${toUnicode}\nendstream`],
    [9, `<< /Length ${cff.length} /Subtype /CIDFontType0C >>\nstream\n${cff.toString("latin1")}\nendstream`],
    ...(nestedForm ? [
      [10, "<< /Type /XObject /Subtype /Form /BBox [0 0 80 60] /Resources << /XObject << /Inner 11 0 R >> >> /Length 9 >>\nstream\n/Inner Do\nendstream"],
      [11, `<< /Type /XObject /Subtype /Form /BBox [0 0 80 60] /Resources << /Font << /F1 4 0 R >> >> /Length ${text.length} >>\nstream\n${text}\nendstream`],
    ] : []),
  ]);
}

function subsetTrueTypePdf(cid) {
  const font = syntheticTrueTypeSubset();
  const text = `BT /F1 30 Tf 1 0 0 1 10 10 Tm ${cid ? "<0001>" : "(A)"} Tj ET`;
  const cmap = "/CIDInit /ProcSet findresource begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfchar\n<0001> <0041>\nendbfchar\nendcmap\nend";
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 80 60] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"],
    [4, cid
      ? "<< /Type /Font /Subtype /Type0 /BaseFont /SubsetTT /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 8 0 R >>"
      : "<< /Type /Font /Subtype /TrueType /BaseFont /SubsetTT /FirstChar 65 /LastChar 65 /Widths [600] /FontDescriptor 7 0 R >>"],
    [5, `<< /Length ${text.length} >>\nstream\n${text}\nendstream`],
    [6, "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SubsetTT /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 600 /CIDToGIDMap /Identity >>"],
    [7, "<< /Type /FontDescriptor /FontName /SubsetTT /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 9 0 R >>"],
    [8, `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`],
    [9, `<< /Length ${font.length} >>\nstream\n${font.toString("latin1")}\nendstream`],
  ]);
}

function syntheticTrueTypeSubset() {
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  head.writeUInt16BE(1000, 18);
  head.writeInt16BE(600, 40);
  head.writeInt16BE(600, 42);
  head.writeInt16BE(1, 50);
  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000);
  hhea.writeInt16BE(800, 4);
  hhea.writeInt16BE(-200, 6);
  hhea.writeUInt16BE(600, 10);
  hhea.writeInt16BE(600, 16);
  hhea.writeUInt16BE(2, 34);
  const hmtx = Buffer.alloc(8);
  hmtx.writeUInt16BE(600, 0);
  hmtx.writeUInt16BE(600, 4);
  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000);
  maxp.writeUInt16BE(2, 4);
  maxp.writeUInt16BE(4, 6);
  maxp.writeUInt16BE(1, 8);
  const glyph = Buffer.alloc(34);
  glyph.writeInt16BE(1, 0);
  glyph.writeInt16BE(600, 6);
  glyph.writeInt16BE(600, 8);
  glyph.writeUInt16BE(3, 10);
  glyph.fill(1, 14, 18);
  for (const [index, value] of [0, 600, 0, -600, 0, 0, 600, 0].entries()) {
    glyph.writeInt16BE(value, 18 + index * 2);
  }
  const loca = Buffer.alloc(12);
  loca.writeUInt32BE(34, 8);
  const cmap = Buffer.alloc(274);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(1, 4);
  cmap.writeUInt32BE(12, 8);
  cmap.writeUInt16BE(0, 12);
  cmap.writeUInt16BE(262, 14);
  cmap[18 + 65] = 1;
  const tables = new Map([["cmap", cmap], ["glyf", glyph], ["head", head], ["hhea", hhea],
    ["hmtx", hmtx], ["loca", loca], ["maxp", maxp]]);
  const entries = Array.from(tables).sort(([a], [b]) => a.localeCompare(b));
  const output = Buffer.alloc(12 + entries.length * 16 + entries.reduce((sum, [, bytes]) => sum + Math.ceil(bytes.length / 4) * 4, 0));
  output.writeUInt32BE(0x00010000);
  output.writeUInt16BE(entries.length, 4);
  let offset = 12 + entries.length * 16;
  entries.forEach(([tag, bytes], index) => {
    const record = 12 + index * 16;
    output.write(tag, record, 4, "latin1");
    output.writeUInt32BE(offset, record + 8);
    output.writeUInt32BE(bytes.length, record + 12);
    bytes.copy(output, offset);
    offset += Math.ceil(bytes.length / 4) * 4;
  });
  return output;
}

function cidCffFont(charsetFormat, shape) {
  const number = (value) => [28, (value >> 8) & 255, value & 255];
  const rectangle = [
    ...number(0), ...number(0), 21,
    ...number(600), ...number(0), ...number(0), ...number(600),
    ...number(-600), ...number(0), ...number(0), ...number(-600), 5, 14,
  ];
  const triangle = [
    ...number(0), ...number(0), 21,
    ...number(600), ...number(0), ...number(-300), ...number(600),
    ...number(-300), ...number(-600), 5, 14,
  ];
  const header = Buffer.from([1, 0, 4, 4]);
  const name = cffIndex([Buffer.from("SyntheticCID")]);
  const strings = cffIndex([Buffer.from("Adobe"), Buffer.from("Identity")]);
  const globalSubrs = Buffer.from([0, 0]);
  const charset = Buffer.from(charsetFormat === 0 ? [0, 0, 65] :
    charsetFormat === 1 ? [1, 0, 65, 0] : [2, 0, 65, 0, 0]);
  const fdSelect = Buffer.from([0, 0, 0]);
  const fdArray = cffIndex([Buffer.from([...number(0), ...number(0), 18])]);
  const charStrings = cffIndex([Buffer.from([14]), Buffer.from(shape === "triangle" ? triangle : rectangle)]);
  const topLength = 11 + 5 + 6 + 6 + 7 + 7;
  const topSize = cffIndex([Buffer.alloc(topLength)]).length;
  let offset = header.length + name.length + topSize + strings.length + globalSubrs.length;
  const charsetOffset = offset; offset += charset.length;
  const fdSelectOffset = offset; offset += fdSelect.length;
  const fdArrayOffset = offset; offset += fdArray.length;
  const charStringsOffset = offset;
  const long = (value) => [29, (value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  const top = Buffer.from([
    ...number(391), ...number(392), ...number(0), 12, 30,
    ...number(66), 12, 34,
    ...long(charsetOffset), 15,
    ...long(charStringsOffset), 17,
    ...long(fdArrayOffset), 12, 36,
    ...long(fdSelectOffset), 12, 37,
  ]);
  assert.equal(top.length, topLength);
  return Buffer.concat([header, name, cffIndex([top]), strings, globalSubrs, charset, fdSelect, fdArray, charStrings]);
}

function cffIndex(entries) {
  const offsets = [1];
  for (const entry of entries) offsets.push(offsets.at(-1) + entry.length);
  assert.ok(offsets.at(-1) < 256);
  return Buffer.concat([Buffer.from([0, entries.length, 1, ...offsets]), ...entries]);
}

function standardR2Pdf({ password = "", revision = 2 } = {}) {
  const padding = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
  const padded = (text) => Buffer.concat([Buffer.from(text, "latin1"), padding]).subarray(0, 32);
  const hash = (data) => createHash("md5").update(data).digest();
  const owner = testRc4(hash(padded("owner")).subarray(0, 5), padded(password));
  const id = Buffer.from("112233445566778899aabbccddeeff00", "hex");
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const key = hash(Buffer.concat([padded(password), owner, permissions, id])).subarray(0, 5);
  const user = testRc4(key, padding);
  const objectKey = (id) => hash(Buffer.concat([key, Buffer.from([id & 255, id >> 8 & 255, id >> 16 & 255, 0, 0])])).subarray(0, 10);
  const text = "q 20 0 0 20 0 0 cm /Im0 Do Q";
  const image = deflateSync(Buffer.from([0, 0, 0]));
  const encryptedText = testRc4(objectKey(4), Buffer.from(text, "latin1"));
  const encryptedImage = testRc4(objectKey(5), image);
  const encryptedTitle = testRc4(objectKey(7), Buffer.from("Private title", "latin1"));
  const encryptedSubject = testRc4(objectKey(7), Buffer.from("Private subject", "latin1"));
  const subjectLiteral = Array.from(encryptedSubject, (byte) => `\\${byte.toString(8).padStart(3, "0")}`).join("");
  return buildPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20 20] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>"],
    [4, `<< /Length ${encryptedText.length} >>\nstream\n${encryptedText.toString("latin1")}\nendstream`],
    [5, `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode /Length ${encryptedImage.length} >>\nstream\n${encryptedImage.toString("latin1")}\nendstream`],
    [6, `<< /Filter /Standard /V ${revision === 2 ? 1 : 2} /R ${revision} /O <${owner.toString("hex")}> /U <${user.toString("hex")}> /P -4 >>`],
    [7, `<< /Title <${encryptedTitle.toString("hex")}> /Subject (${subjectLiteral}) >>`],
  ], `/Encrypt 6 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>] /Info 7 0 R`);
}

function testRc4(key, input) {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + state[i] + key[i % key.length]) % 256;
    [state[i], state[j]] = [state[j], state[i]];
  }
  let i = 0;
  j = 0;
  return Buffer.from(Uint8Array.from(input, (byte) => {
    i = (i + 1) % 256;
    j = (j + state[i]) % 256;
    [state[i], state[j]] = [state[j], state[i]];
    return byte ^ state[(state[i] + state[j]) % 256];
  }));
}

function buildPdf(objects, trailerEntries = "") {
  let source = "%PDF-1.4\n";
  const offsets = new Map();
  for (const [id, value] of objects) {
    offsets.set(id, source.length);
    source += `${id} 0 obj\n${value}\nendobj\n`;
  }
  const xrefOffset = source.length;
  const size = Math.max(...offsets.keys()) + 1;
  source += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id += 1) {
    source += offsets.has(id) ? `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n` : "0000000000 00000 f \n";
  }
  source += `trailer\n<< /Size ${size} /Root 1 0 R ${trailerEntries} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source, "latin1");
}
