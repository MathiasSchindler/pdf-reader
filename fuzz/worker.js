import { parentPort, workerData } from "node:worker_threads";
import { Session } from "node:inspector/promises";
import { loadPdfCrumb } from "../src/pdf-lite/index.js";

// Per-worker coverage collection. Each fuzz case spawns a fresh worker so the
// coverage we report is exactly the code reached by parsing this one input.
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });

let payload;
try {
  const bytes = Buffer.from(workerData.bytes);
  const dataUrl = `data:application/pdf;base64,${bytes.toString("base64")}`;
  const pdf = await loadPdfCrumb(dataUrl);
  const audit = pdf.audit?.() || {};
  payload = {
    status: "parsed",
    pages: pdf.pages?.length || 0,
    objects: audit.objects,
    version: audit.version,
  };
} catch (error) {
  payload = {
    status: "rejected",
    name: error?.name || "Error",
    message: String(error?.message || error),
  };
}

const edges = [];
try {
  const { result } = await session.post("Profiler.takePreciseCoverage");
  for (const script of result) {
    const url = script.url || "";
    // Limit to the renderer's own source so the coverage signal isn't drowned
    // out by Node internals or the worker bootstrap.
    if (!url.includes("/src/pdf-lite/") && !url.endsWith("/src/pdf-lite.js")) continue;
    for (const fn of script.functions) {
      for (const range of fn.ranges) {
        if (range.count > 0) {
          edges.push(hashEdge(url, range.startOffset, range.endOffset));
        }
      }
    }
  }
} catch {
  // Coverage is best-effort. If anything goes wrong we still report status.
}

parentPort.postMessage({ ...payload, edges });

function hashEdge(url, start, end) {
  // Stable 32-bit hash so edges from different workers can be compared by id.
  let h = 5381;
  for (let i = 0; i < url.length; i += 1) {
    h = ((h << 5) + h + url.charCodeAt(i)) | 0;
  }
  h = ((h << 5) + h + start) | 0;
  h = ((h << 5) + h + end) | 0;
  return h >>> 0;
}
