import { parentPort, workerData } from "node:worker_threads";
import { loadPdfCrumb } from "../src/pdf-lite/index.js";

try {
  const bytes = Buffer.from(workerData.bytes);
  const dataUrl = `data:application/pdf;base64,${bytes.toString("base64")}`;
  const pdf = await loadPdfCrumb(dataUrl);
  const audit = pdf.audit?.() || {};
  parentPort.postMessage({
    status: "parsed",
    pages: pdf.pages?.length || 0,
    objects: audit.objects,
    version: audit.version,
  });
} catch (error) {
  parentPort.postMessage({
    status: "rejected",
    name: error?.name || "Error",
    message: String(error?.message || error),
  });
}
