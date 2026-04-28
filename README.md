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
  dist/demo/index.html       minimal embeddable demo
  pdf-files/PDF.pdf          freely licensed public sample PDF
  samples.js                 local development manifest
  styles.css                 development reader styles
  fixtures/                  commit-safe fixture PDFs
  src/
    reader-app.js            development reader behavior
    pdf-lite.js              compatibility re-export
    pdf-lite/
      index.js               public source entry
      engine.js              parser and canvas renderer implementation
      global.js              script-tag bundle entry
  scripts/build.js           distribution profile build script
```

The renderer source should stay independent of the development reader UI. It should not know about sample manifests, PDF.js, Meltdown, or quality-comparison tools.

## Development Reader

The development reader loads `samples.js` by default. The manifest includes generated fixture PDFs from `fixtures/`, the public `pdf-files/PDF.pdf` Wikipedia sample, and references local PDFs below `pdf-files/` when that ignored corpus is present.

The `Pages` control accepts `all`, a single page such as `3`, a range such as `1-5`, or a comma-separated list such as `1,3,7-9`. The `View` control switches between pdf-crumb, PDF.js, and Difference. The difference view renders the same selected pages through both engines, compares pixels, and paints matching pixels black. Pixels where pdf-crumb is brighter are red; pixels where PDF.js is brighter are green.

PDF.js is only a development comparator in this project. It is not a fallback renderer for pdf-crumb, and production behavior should not silently switch to PDF.js when pdf-crumb lacks a feature. The vendored files in `vendor/pdfjs/` retain the Mozilla Foundation copyright and Apache-2.0 license notices; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The manifest and PDF base path can be overridden from the development reader URL:

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
- JPEG image XObject rendering through browser image decoding
- simple raw image XObject rendering for gray, RGB, ICC-like, CMYK-like, and Indexed data

Known gaps include:

- full PDF font shaping and all font program formats
- JPX/JPEG 2000 and complex masked image XObjects
- full external graphics state handling
- text clipping modes
- calibrated, ICC, indexed, separation, and pattern color spaces beyond the currently implemented subset
- advanced clipping interactions and transparency groups
- less common stream filters beyond Flate, ASCIIHex, ASCII85, and RunLength

Treat the output as an experimental rendering, not archival or legally reliable PDF reproduction.
