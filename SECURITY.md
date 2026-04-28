# Security Policy

pdf-crumb is an experimental browser PDF renderer that may be used with untrusted PDF files. The security goal is to render supported visual content while bounding parser and renderer resource use and ignoring active PDF features.

## Supported Defensive Boundary

The renderer does not execute PDF JavaScript, launch files, submit forms, navigate remote actions, or process embedded active content. Active-content markers such as `/OpenAction`, `/AA`, `/JavaScript`, `/Launch`, `/SubmitForm`, `/GoToR`, `/URI`, `/EmbeddedFile`, `/RichMedia`, and `/XFA` are reported through `pdf.audit().activeContent` when diagnostics are enabled, but they are not acted on.

Default security limits bound input size, decoded stream size, total decoded stream bytes, page count, page-tree depth, content operators, graphics stack depth, form XObject recursion, image dimensions, image pixels, embedded font bytes, CMap entries, and object stream expansion. Callers can tighten these limits:

```js
import { loadPdfCrumb } from "./dist/pdf-crumb.viewer.min.js";

const controller = new AbortController();
const pdf = await loadPdfCrumb(url, {
  signal: controller.signal,
  limits: {
    maxInputBytes: 32 * 1024 * 1024,
    maxDecodedStreamBytes: 16 * 1024 * 1024,
    maxImagePixels: 8_000_000,
  },
});
```

Pass an `AbortSignal` to cancel parse/fetch work. `renderPage` also accepts `signal` in its options for render-stage cancellation.

## Recommended Deployment

For untrusted third-party PDFs, run parsing and rendering in a dedicated Worker when possible. A worker boundary allows the host application to terminate stuck work and keeps heavy parsing off the UI thread. The in-process limits are still required; the worker is an additional containment layer, not a replacement.

Use the `viewer` or `text` distribution profiles for production embedding. The full profile includes diagnostics intended for development and comparison workflows.

## Reporting Issues

Please report crashes, hangs, unbounded memory growth, uncaught exceptions, or cases where active PDF content is executed or followed. Include the command or browser workflow, the PDF or minimized fuzz artifact if shareable, the seed if fuzz-generated, and the observed result.

Generated fuzz artifacts belong in ignored local directories. Minimized artifacts that should become permanent regression coverage can be copied into `fixtures/regression/` and checked with:

```text
npm run fuzz:regression
npm run test:security
```
