# PDF Reader

This directory is a standalone home for the small dependency-free PDF reader that started in `bt-drucksachen/experimental/pdf`.

The goal is to keep three things separate:

- `src/pdf-lite.js`: the experimental PDF parser and canvas renderer.
- `src/reader-app.js`: the browser reader UI that loads documents and renders pages.
- comparison experiments: PDF.js comparisons, Meltdown raster comparisons, and pixel-diff tooling. Those are intentionally not part of this runtime app.

## Run

Start a static server from this directory, then open:

```text
ruby -run -e httpd . -p 8787
http://localhost:8787/
```

By default, the reader loads `./samples.js`. The manifest includes one generated smoke-test PDF from `fixtures/` and references local PDFs below `pdf-files/` when that ignored corpus is present.

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
```

`index.html` is deliberately small. It only wires up the reader UI and loads the module app.

`src/reader-app.js` owns application behavior: manifest loading, document selection, scale changes, rendering pages to canvases, and showing renderer audit information.

`src/pdf-lite.js` is the renderer engine copied from the experiment. It should stay independent of the reader UI and should not know about Bundestag manifests, PDF.js, Meltdown, or quality comparison tools.

## What Is Not Included

The original experiment also contained comparison modes:

- built-in renderer vs PDF.js pixel heatmaps
- built-in renderer vs Meltdown page raster heatmaps
- cumulative Meltdown layer diagnostics

Those are useful, but they belong outside the reader app. Keeping them out makes this project easier to understand: it is a PDF reader using the `pdf-lite` engine, not a renderer benchmark suite.

If those experiments are needed again, put them in a separate `experiments/` directory or keep using `bt-drucksachen/experimental/pdf` as the comparison workbench.

## Current Renderer Scope

The renderer is still experimental. It can parse enough of the cached Bundestag PDFs to render useful pages, but it is not a general-purpose PDF implementation.

Currently useful capabilities include:

- direct PDF object parsing
- Flate-compressed object stream decoding via `DecompressionStream`
- page tree walking
- page content stream concatenation
- basic `ToUnicode` CMap reading
- a small subset of text and path operators
- cubic Bezier path rendering for vector-heavy pages
- basic graphics state alpha, dash, miter, and color-space color operands
- Form XObject interpretation
- JPEG image XObject rendering via browser image decoding
- simple 8-bit raw and Flate image XObject rendering for gray, RGB, ICC-like, and CMYK-like data, including grayscale soft masks
- common PDF base-font mapping to browser font families
- unsupported-operator reporting
- literal-string octal escape decoding for some documents without `ToUnicode` maps

Known gaps include:

- embedded font shaping and real font program interpretation
- JPX/JPEG 2000, indexed, predictor-heavy, masked, and complex image XObjects
- full external graphics state handling
- calibrated, ICC, indexed, separation, and pattern color spaces
- clipping behavior beyond accepted no-ops
- filters beyond `FlateDecode`

Treat the output as a readable diagnostic rendering, not an archival or conformance-grade PDF renderer.
