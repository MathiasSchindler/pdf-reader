# pdf-crumb.js

pdf-crumb.js is a small dependency-free PDF renderer experiment for the browser. It parses PDF objects and page content streams directly, then renders pages to canvas.

The project is not a conformance-grade PDF implementation. It is useful as a compact renderer, a learning code base, and a development playground for understanding the pieces involved in PDF display.

## License And Provenance

This project is released under CC0-1.0. See [LICENSE](LICENSE).

The code base was written with substantial LLM assistance, mostly GPT-5.5, with human direction, testing, and review throughout. See [NOTICE.md](NOTICE.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Try It

Start a static server from this directory:

```text
ruby -run -e httpd . -p 8787
```

Open the project page:

```text
http://localhost:8787/
```

Useful local pages:

- `http://localhost:8787/`: project page with a live pdf-crumb.js render of `pdf-files/PDF.pdf`.
- `http://localhost:8787/dist/demo/`: minimal distribution demo using the viewer bundle, the same sample PDF, file upload, and drag/drop.
- `http://localhost:8787/dev/`: development reader with sample selection, PDF.js comparison mode, difference view, renderer audit, and font-mode controls.
- `http://localhost:8787/compare/`: side-by-side page for investigating a local PDF in both renderers and copying a page-specific discrepancy report.

## Install And Build

Install development dependencies once:

```text
npm install
```

Build all distribution profiles:

```text
npm run build
```

`npm run size` runs the same build and prints raw, gzip, and brotli sizes.

The build uses esbuild plus Terser. The source stays modular enough for development, while each distribution profile is emitted as one minified JavaScript file.

Run the browser renderer regression tests with `npm run test:regression`. They cover stream parsing, path painting, canvas allocation limits, indexed image rows, synthetic embedded CID fonts, reader load races, and the comparison page. The default canvas budget is 16 million pixels (`maxPagePixels`); it can be adjusted with `loadPdfCrumb(url, { limits: { maxPagePixels: ... } })`.

Isolated transparency Form XObjects, browser-supported blend modes, and alpha/luminosity soft masks on Form and image XObjects use bounded off-screen canvases. Axial (`ShadingType 2`) shadings with extended endpoints support exponential, stitched, and one-input 8/16-bit sampled color functions in device color spaces. A transparency layer is limited to four million pixels and concurrent layers to twelve million pixels; adjust `maxTransparencyPixels` and `maxActiveTransparencyPixels` in `limits` if necessary. Non-isolated or knockout groups and soft masks on directly painted paths/text are not fully supported and are reported as such. Shading inside a masked, non-isolated group is skipped with an explicit diagnostic rather than darkening the page incorrectly.

The development reader reuses the loaded pdf-crumb and PDF.js documents while the selected URL stays the same. The renderer caches parsed page/form content (up to 16 MiB estimated per document) and decoded image bitmaps (up to 4 million pixels per document); override these budgets with `maxCachedContentBytes` and `maxCachedImagePixels` in `limits`. Repeated glyphs and numeric runs are batched only when their browser advances match the PDF widths, so fonts with different fallback metrics retain individual glyph painting.

Embedded CID-keyed CFF fonts (`CIDFontType0C`) with Identity-H encoding and a usable ToUnicode map are installed as browser fonts with the PDF's CID widths. Embedded TrueType subsets missing browser-required tables are wrapped with a Unicode cmap and installed when their glyph mappings can be established; simple TrueType fonts can also use their embedded outlines directly. Fonts in nested Form XObject resources are discovered as well as page-level fonts. Vertical writing, unsupported CID encodings or glyph maps, invalid embedded data, and embedded Type 1 programs can still use a browser fallback; inspect `pdf.warnings` (and the development reader's font audit) rather than assuming fallback text is faithful. The `Embedded outlines` control does not enable additional CID font support.

Standard PDF encryption revision 2 (`V=1`, 40-bit RC4) is decrypted before parsing page streams and object strings. Empty-password documents open normally; for a document with a user or owner password, pass `{ password: "..." }` to `loadPdfCrumb`. Other encryption revisions and incorrect passwords produce an explicit load error instead of a blank page. The comparison page does not ask for passwords, so it can open encrypted documents only when the empty password is valid. Packed 1-, 2-, and 4-bit grayscale images (including barcodes) are supported with row padding and `/Decode` polarity.

Run `npm run bench:render -- --runs=5` to benchmark load, first and repeated renders, and compatible-font text against the included `pdf-files/PDF.pdf` and a generated text fixture. The browser benchmark reports median times, text draw calls, and pixel hashes.

Run `npm run census` to scan `pdf-files/` locally without rendering pages. It writes an ignored `pdf-files/census.json` report with per-page feature counts, parse failures, warnings, exact SHA-256 duplicates, and a ranking by distinct PDFs and affected pages with example locations. Pass a directory and output filename with `npm run census -- <directory> <output.json>`; keep reports for private collections outside tracked paths. The scanner follows invoked Form XObjects and counts selected font, image, shading, and transparency uses, but does not inspect inline-image data or prove that observed features render faithfully. `unsupported` and `fallback` labels indicate known gaps; `partial` flags supported subsets with remaining limitations, `unverified` marks browser font installations that cannot be checked by the Node-based scanner, and `observed` is not a claim of faithful support. Use `npm run test:census` for synthetic scanner regressions.

## Distribution Files

The public bundle names use `pdf-crumb`:

```text
dist/pdf-crumb.min.js                    full ESM bundle
dist/pdf-crumb.global.min.js             full script-tag bundle
dist/pdf-crumb.viewer.min.js             viewer ESM bundle
dist/pdf-crumb.viewer.global.min.js      viewer script-tag bundle
dist/pdf-crumb.text.min.js               text/vector-only ESM bundle
dist/pdf-crumb.text.global.min.js        text/vector-only script-tag bundle
```

Profiles:

```text
full     development/comparison build with audit data and experimental embedded outline mode
viewer   default third-party viewer build; stable rendering, images, embedded browser fonts, no diagnostics
text     smallest build for text/vector-only PDFs; image XObjects disabled
```

Use `dist/pdf-crumb.viewer.min.js` as the normal single-file renderer for third-party pages that can load JavaScript modules:

```html
<canvas id="page"></canvas>
<script type="module">
  import { loadPdfCrumb } from "./dist/pdf-crumb.viewer.min.js";

  const pdf = await loadPdfCrumb("./example.pdf");
  await pdf.renderPage(0, document.getElementById("page"), { scale: 1.5 });
</script>
```

Use `dist/pdf-crumb.viewer.global.min.js` when the host page wants a plain script tag:

```html
<canvas id="page"></canvas>
<script src="./dist/pdf-crumb.viewer.global.min.js"></script>
<script>
  (async () => {
    const pdf = await PdfCrumb.load("./example.pdf");
    await pdf.renderPage(0, document.getElementById("page"), { scale: 1.5 });
  })();
</script>
```

The old `loadPdfLite` ESM export remains as a compatibility alias. The global build exposes `PdfCrumb`; `PdfLite` is kept as a compatibility alias when no existing `PdfLite` global is present.

The root UI, sample manifest, PDF.js comparator, and difference view are not bundled into any distribution file. The bundles contain the renderer API only.

## Project Shape

```text
pdf-reader/
  index.html                 project page
  dev/index.html             development reader UI
  compare/index.html         side-by-side comparison UI
  dist/demo/index.html       minimal embeddable demo
  pdf-files/PDF.pdf          freely licensed public sample PDF
  samples.js                 local development manifest
  styles.css                 development reader styles
  fixtures/                  commit-safe fixture PDFs
  src/
    reader-app.js            development reader behavior
    compare-app.js           comparison page behavior
    comparison.js            shared PDF.js and pixel-difference helpers
    pdf-lite.js              compatibility re-export
    pdf-lite/
      index.js               public source entry
      engine.js              parser and canvas renderer implementation
      global.js              script-tag bundle entry
  scripts/build.js           distribution profile build script
```

The renderer source should stay independent of the development reader UI. It should not know about sample manifests, PDF.js, Meltdown, or quality-comparison tools.

## Development Reader

The development reader loads `samples.js` by default. The default manifest includes only generated fixture PDFs from `fixtures/` and the public `pdf-files/PDF.pdf` Wikipedia sample, so a fresh checkout does not list private or copyright-sensitive local corpus files.

The `Pages` control accepts `all`, a single page such as `3`, a range such as `1-5`, or a comma-separated list such as `1,3,7-9`. The `View` control switches between pdf-crumb, PDF.js, and Difference. The difference view renders the same selected pages through both engines, compares pixels, and paints matching pixels black. Pixels where pdf-crumb is brighter are red; pixels where PDF.js is brighter are green.

PDF.js is only a development comparator in this project. It is not a fallback renderer for pdf-crumb, and production behavior should not silently switch to PDF.js when pdf-crumb lacks a feature. The vendored files in `vendor/pdfjs/` retain the Mozilla Foundation copyright and Apache-2.0 license notices; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Side-by-side comparison

Open `http://localhost:8787/compare/` from a static server started at the project root. Enter a PDF path served by that same server (for example `../pdf-files/PDF.pdf`), or select a PDF from your computer. A path, page, scale, and font mode can be bookmarked as `http://localhost:8787/compare/?pdf=../pdf-files/PDF.pdf&page=3&scale=1.5&font=stable`. Uploads are accessed through a temporary browser blob URL; they are not uploaded to a service, added to the sample manifest, or included in the shareable URL. If you send someone an uploaded-PDF report, they will need their own copy of that PDF.

The page renders pdf-crumb and PDF.js simultaneously, with a red/green difference map. Click a location in either canvas or the difference map to mark the same relative position in all three views. Use **Copy report** to share the PDF name, page, scale, marked coordinates, error messages, and renderer warnings without sharing the PDF bytes. A same-origin path in the report is useful for a local discussion but is not accessible to another person unless they serve that PDF at the same path.

The pixel report counts differences above **2/255** in any colour channel and separately counts strong differences above **20/255**; it is a diagnostic, not a quality score. Font antialiasing and dimensions may cause many cosmetic differences. The stronger count and the marked location help distinguish those from missing or seriously misrendered content. If the rendered canvas dimensions differ, the map cannot align the pages and the report says so. To avoid excessive memory use, this comparison page limits each canvas to four million pixels; reduce the scale for large pages.

Use a separate local manifest for private test corpora. The manifest and PDF base path can be overridden from the development reader URL:

```text
http://localhost:8787/dev/?manifest=../bt-drucksachen/manifest.js&base=../bt-drucksachen
```

The manifest is expected to define `BT_DRUCKSACHEN`, with entries containing at least:

```js
{
  id: "21-5219",
  number: "21/5219",
  title: "...",
  type: "...",
  pdfPath: "pdfs/21-5219.pdf"
}
```

Entries can also provide `pdfUrl` directly.

## Defensive Fuzzing

This repository includes a local fuzzing harness for defensive robustness testing of pdf-crumb against malformed or adversarial PDF inputs. The harness mutates the project's own fixture PDFs, feeds the mutated bytes to the parser and renderer, and reports crashes, hangs, uncaught browser exceptions, and semantic disagreements with PDF.js. It is intended to harden this reader against untrusted third-party PDF content; it does not generate exploits or target other software or systems.

Run the fast parser smoke test:

```text
npm run fuzz:smoke -- --seed=20260428
```

Run broader parser, browser-render, and PDF.js oracle fuzzing:

```text
npm run fuzz -- --seed=20260428
npm run fuzz:render -- --cases=300 --seed=20260428
npm run fuzz:oracle -- --cases=300 --seed=20260428
```

Useful options:

```text
--cases=N       number of generated inputs
--seed=N        deterministic random seed for reproduction
--timeout=MS    per-case timeout budget
--replay=PATH   parser-stage replay of a saved artifact
```

Unexpected parser outcomes are saved under `fuzz/artifacts/`, browser-render findings under `fuzz/artifacts-render/`, and oracle mismatches under `fuzz/artifacts-oracle/`. These paths are ignored by git because fuzz artifacts are generated inputs and may be numerous. A finding should be treated as a local robustness bug until investigated: timeouts usually point to missing bounds, page errors to uncaught renderer faults, and oracle mismatches to parser behavior that should be compared against the reference implementation before changing accept/reject policy.

Minimized artifacts that should become permanent coverage can be copied into `fixtures/regression/` and replayed with:

```text
npm run fuzz:regression
```

Deterministic browser security checks cover active-content auditing, input limits, abort handling, decoded stream limits, image allocation limits, and content-operator limits:

```text
npm run test:security
```

The public loader accepts optional `limits` and `signal` settings. See [SECURITY.md](SECURITY.md) for the security boundary, default defensive posture, and deployment recommendations for untrusted PDFs.

## Repository Hygiene

The repository intentionally ignores:

- most of `vendor/`, while allowing `vendor/pdfjs/` so a fresh checkout can run the development PDF.js comparison view with its original license notices intact.
- most of `pdf-files/`, because the local PDF corpus may contain copyrighted documents. `pdf-files/PDF.pdf` is allowed as the public freely licensed sample.
- `node_modules/`, because dependencies are restored through `npm install`.

Keep generated or self-authored fixtures in `fixtures/` when they are safe to commit.

## Current Renderer Scope

Currently useful capabilities include:

- direct PDF object parsing
- Flate, ASCIIHex, ASCII85, and RunLength stream decoding
- page tree walking with inherited MediaBox/CropBox/Rotate handling
- page content stream concatenation
- basic `ToUnicode` CMap reading
- PDF font width-table handling for simple fonts and Type0/CID descendant fonts
- browser-loaded wrapped Type1C/CFF embedded fonts in stable mode when accepted by `FontFace`
- direct outline rendering for safe simple TrueType subsets
- experimental CFF/Type2 outline diagnostics in the full development build
- a subset of text, path, clipping, form XObject, color, graphics-state, and image XObject rendering
- isolated transparency Forms, common Canvas blend modes, Form/image soft masks, and extended axial gradients in supported device color spaces
- `k` and `K` DeviceCMYK fill/stroke operators, using the same approximate CMYK-to-RGB conversion as `sc` and `SC`
- JPEG image XObject rendering through browser image decoding
- simple raw image XObject rendering for gray, RGB, ICC-like, CMYK-like, and Indexed data

Known gaps include:

- full PDF font shaping and all font program formats
- JPX/JPEG 2000 and complex masked image XObjects
- full external graphics state handling
- text clipping modes
- calibrated, ICC, indexed, separation, and pattern color spaces beyond the currently implemented subset
- color-managed CMYK conversion; supported CMYK painting can differ noticeably from PDF.js hues
- advanced clipping interactions
- non-isolated/knockout group compositing, direct path/text soft masking, and radial/mesh shadings
- less common stream filters beyond Flate, ASCIIHex, ASCII85, and RunLength

Treat the output as an experimental rendering, not archival or legally reliable PDF reproduction.
