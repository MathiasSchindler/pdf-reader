import { loadPdfCrumb, loadPdfLite } from "./index.js";

globalThis.PdfCrumb = Object.freeze({
  load: loadPdfCrumb,
  loadPdfCrumb,
  loadPdfLite,
});

globalThis.PdfLite ||= globalThis.PdfCrumb;
