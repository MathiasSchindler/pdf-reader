import { DEFAULT_SECURITY_LIMITS, loadPdfCrumb, loadPdfLite } from "./index.js";

globalThis.PdfCrumb = Object.freeze({
  load: loadPdfCrumb,
  loadPdfCrumb,
  loadPdfLite,
  DEFAULT_SECURITY_LIMITS,
});

globalThis.PdfLite ||= globalThis.PdfCrumb;
