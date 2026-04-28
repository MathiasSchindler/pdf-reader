# PDF Reader

This directory is a standalone home for the small dependency-free PDF reader that started in `bt-drucksachen/experimental/pdf`.

The goal is to keep three things separate:

- `src/pdf-lite/`: the experimental PDF parser and canvas renderer source modules.
- `src/reader-app.js`: the browser reader UI that loads documents and renders pages, including an optional PDF.js comparison view when `vendor/pdfjs/` is present.
- comparison experiments beyond PDF.js pixel diffs: Meltdown raster comparisons and cumulative layer diagnostics. Those are intentionally not part of this runtime app.

## Run

Start a static server from this directory, then open:

```text
ruby -run -e httpd . -p 8787
http://localhost:8787/
```

Install the development dependency once before building distribution files:

```text
npm install
```

By default, the reader loads `./samples.js`. The manifest includes one generated smoke-test PDF from `fixtures/` and references local PDFs below `pdf-files/` when that ignored corpus is present.

The `Pages` control accepts `all`, a single page such as `3`, a range such as `1-5`, or a comma-separated list such as `1,3,7-9`. The `View` control switches between `pdf-lite`, PDF.js, and `Difference`. The difference view renders the same selected pages through both engines, compares pixels, and paints matching pixels black. Pixels where `pdf-lite` is brighter are red; pixels where PDF.js is brighter are green. The inspector reports changed-pixel totals, red/green counts, mean delta, and max delta. This mode requires the ignored local `vendor/pdfjs/` files.

PDF.js is only a development comparator in this project. It is not a fallback renderer for `pdf-lite`, and production behavior should not silently switch to PDF.js when `pdf-lite` lacks a feature.

The manifest and PDF base path can be overridden from the URL:

```text
http://localhost:8787/?manifest=../bt-drucksachen/manifest.js&base=../bt-drucksachen
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

Entries can also provide `pdfUrl` directly. This is used by the generated fixture so the app has one commit-safe PDF even though `pdf-files/` is ignored.

## Repository Hygiene

The repository intentionally ignores:

- `vendor/`, because PDF.js is third-party comparison material.
- `pdf-files/`, because the local PDF corpus may contain copyrighted documents.

Keep generated or self-authored fixtures in `fixtures/` when they are safe to commit.

## Project Shape

```text
pdf-reader/
  index.html
  samples.js
  styles.css
  fixtures/
    pdf-lite-smoke.pdf
  src/
    reader-app.js
    pdf-lite.js
    pdf-lite/
      index.js
      engine.js
      global.js
  dist/
    pdf-lite.min.js
    pdf-lite.global.min.js
```

`index.html` is deliberately small. It only wires up the reader UI and loads the module app.

`src/reader-app.js` owns application behavior: manifest loading, document selection, page-range parsing, scale changes, rendering pages to canvases, diagnostic PDF.js comparison rendering, and showing renderer audit information.

`src/pdf-lite/index.js` is the public development entry point for the renderer. `src/pdf-lite/engine.js` contains the parser and canvas renderer implementation. `src/pdf-lite/global.js` is only an entry point for the script-tag distribution build. The top-level `src/pdf-lite.js` file is a compatibility re-export for older imports.

The renderer source should stay independent of the reader UI and should not know about Bundestag manifests, PDF.js, Meltdown, or quality comparison tools.

## Distribution Builds

The source is developed as modules, but each distributable renderer profile is one minified JavaScript file. Build all supported distribution files with:

```text
npm run build
```

`npm run size` runs the same build and prints raw, gzip, and brotli sizes.

The build uses feature flags and a Terser minification pass after bundling. Current profiles are:

```text
profile  purpose
full     development/comparison build with audit data and experimental embedded outline mode
viewer   default third-party viewer build; stable rendering, images, embedded browser fonts, no diagnostics
text     smallest build for text/vector-only PDFs; image XObjects disabled
```

For each profile, the build writes an ESM bundle and a global script bundle:

- `dist/pdf-lite.min.js`: full ESM bundle.
- `dist/pdf-lite.global.min.js`: full script-tag bundle.
- `dist/pdf-lite.viewer.min.js`: viewer ESM bundle.
- `dist/pdf-lite.viewer.global.min.js`: viewer script-tag bundle.
- `dist/pdf-lite.text.min.js`: text/vector-only ESM bundle.
- `dist/pdf-lite.text.global.min.js`: text/vector-only script-tag bundle.

Current bundle sizes after minification are approximately:

```text
file                                raw      gzip     brotli
dist/pdf-lite.min.js                55.9 KB  17.8 KB  15.8 KB
dist/pdf-lite.viewer.min.js         50.9 KB  16.4 KB  14.6 KB
dist/pdf-lite.text.min.js           45.6 KB  14.8 KB  13.1 KB
```

Use `dist/pdf-lite.viewer.min.js` as the normal single-file renderer for third-party pages that can load JavaScript modules:


```html
<canvas id="page"></canvas>
<script type="module">
  import { loadPdfLite } from "./dist/pdf-lite.viewer.min.js";

  const pdf = await loadPdfLite("./example.pdf");
  await pdf.renderPage(0, document.getElementById("page"), { scale: 1.5 });
</script>
```

Use `dist/pdf-lite.viewer.global.min.js` when the host page wants a plain script tag:

```html
<canvas id="page"></canvas>
<script src="./dist/pdf-lite.viewer.global.min.js"></script>
<script>
  (async () => {
    const pdf = await PdfLite.load("./example.pdf");
    await pdf.renderPage(0, document.getElementById("page"), { scale: 1.5 });
  })();
</script>
```

Use the `full` profile for local development pages that need `audit()` output or the `fontMode: "embedded"` experimental outline renderer. Use the `text` profile only when the host application knows its PDFs do not need image XObjects.

The UI, sample manifest, PDF.js comparator, and difference view are not bundled into any distribution file. The bundles contain the renderer API only.

### Distribution Demo

`dist/demo/index.html` is a minimal embeddable-example page. It imports `../pdf-lite.viewer.min.js`, opens `dist/demo/sample.pdf` by default, and also accepts a PDF through the file picker or by dropping a file onto the page.

The demo uses the `viewer` profile because it is the smallest profile that is still appropriate for general PDF display: it omits diagnostics and experimental outline debugging, but keeps image rendering enabled for user-supplied PDFs. The `text` profile is smaller, but it intentionally disables image XObjects.

Run the static server and open:

```text
http://localhost:8787/dist/demo/
```

## What Is Not Included

The original experiment also contained comparison modes beyond the built-in PDF.js difference view:

- built-in renderer vs Meltdown page raster heatmaps
- cumulative Meltdown layer diagnostics

Those are useful, but they belong outside the reader app. Keeping them out makes this project easier to understand: it is a PDF reader using the `pdf-lite` engine with one lightweight PDF.js diagnostic mode, not a renderer benchmark suite.

If those experiments are needed again, put them in a separate `experiments/` directory or keep using `bt-drucksachen/experimental/pdf` as the comparison workbench.

## Current Renderer Scope

The renderer is still experimental. It can parse enough of the cached Bundestag PDFs to render useful pages, but it is not a general-purpose PDF implementation.

Currently useful capabilities include:

- direct PDF object parsing
- Flate, ASCIIHex, ASCII85, and RunLength stream decoding
- page tree walking with inherited MediaBox/CropBox/Rotate handling
- page content stream concatenation
- basic `ToUnicode` CMap reading
- PDF font width-table handling for simple fonts and Type0/CID descendant fonts, including `Widths`, `W`, `DW`, and variable-width CMap codes
- a small subset of text and path operators, including fill/stroke/invisible text rendering modes and scaled or rotated text matrices
- cubic Bezier path rendering for vector-heavy pages
- compound path fills for outlined/vectorized glyphs with multiple subpaths and counters
- basic graphics state alpha, dash, miter, and color-space color operands
- basic clipping paths and even-odd fills
- Form XObject interpretation
- JPEG image XObject rendering via browser image decoding
- simple raw image XObject rendering for gray, RGB, ICC-like, CMYK-like, and Indexed data, including Decode arrays, TIFF/PNG predictors, and grayscale soft masks
- common PDF base-font and named-family mapping to browser font stacks, including serif/sans/mono families used by the sample corpus
- unsupported-operator reporting
- literal-string octal escape decoding for some documents without `ToUnicode` maps

Known gaps include:

- embedded font loading, shaping, and real font program interpretation; documents such as the Claude Mythos system card can still differ from renderers that use the embedded fonts exactly
- PDFs that convert text to vector outlines instead of normal text operators, such as `fundamentacao.pdf`, render through the path machinery rather than the font machinery; layout can be recognizable while glyph shapes look odd or unselectable
- JPX/JPEG 2000, masked, and complex image XObjects
- full external graphics state handling
- text clipping modes
- calibrated, ICC, indexed, separation, and pattern color spaces
- advanced clipping interactions and transparency groups
- less common stream filters beyond Flate, ASCIIHex, ASCII85, and RunLength

Treat the output as a readable diagnostic rendering, not an archival or conformance-grade PDF renderer.
