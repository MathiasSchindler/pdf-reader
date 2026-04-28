import { loadPdfLite } from "./index.js";

globalThis.PdfLite = Object.freeze({
  load: loadPdfLite,
  loadPdfLite,
});
