import { loadPdfCrumb } from "./pdf-lite/index.js";
import { formatDifference, loadPdfJsDocument, paintDifferenceCanvas, renderPdfJsPage } from "./comparison.js";

const MAX_COMPARE_PIXELS = 4_000_000;
const sourceForm = document.getElementById("source-form");
const sourcePath = document.getElementById("source-path");
const fileInput = document.getElementById("file-input");
const pageNumber = document.getElementById("page-number");
const pageTotal = document.getElementById("page-total");
const previousButton = document.getElementById("previous-page");
const nextButton = document.getElementById("next-page");
const scaleInput = document.getElementById("scale");
const fontModeInput = document.getElementById("font-mode");
const status = document.getElementById("status");
const reportOutput = document.getElementById("report-output");
const copyButton = document.getElementById("copy-report");
const panes = {
  lite: document.getElementById("lite-pane"),
  pdfjs: document.getElementById("pdfjs-pane"),
  difference: document.getElementById("difference-pane"),
};

let current = null;
let uploadedUrl = null;
let loadToken = 0;
let renderToken = 0;
let renderController = null;
let comparison = null;
let markedPoint = null;

sourceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  openPath();
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  if (uploadedUrl) URL.revokeObjectURL(uploadedUrl);
  uploadedUrl = url;
  sourcePath.value = "";
  pageNumber.value = "1";
  openDocument({ url, label: file.name, path: null });
});
previousButton.addEventListener("click", () => showPage(Number(pageNumber.value) - 1));
nextButton.addEventListener("click", () => showPage(Number(pageNumber.value) + 1));
pageNumber.addEventListener("change", () => showPage(Number(pageNumber.value)));
scaleInput.addEventListener("change", () => showPage(Number(pageNumber.value)));
fontModeInput.addEventListener("change", () => showPage(Number(pageNumber.value)));
copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(reportOutput.value);
    setStatus("Report copied. No PDF data was copied.");
  } catch (error) {
    setStatus(`Could not copy the report: ${error.message}. Select the report text to copy it manually.`, true);
  }
});
for (const pane of Object.values(panes)) {
  pane.addEventListener("click", (event) => {
    if (!(event.target instanceof HTMLCanvasElement)) return;
    const rect = event.target.getBoundingClientRect();
    markedPoint = {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
    updateMarkers();
    updateReport();
  });
}

const params = new URLSearchParams(location.search);
sourcePath.value = params.get("pdf") || "../pdf-files/PDF.pdf";
if (params.has("page")) pageNumber.value = params.get("page");
if (params.has("scale")) scaleInput.value = params.get("scale");
if (params.has("font")) fontModeInput.value = params.get("font");
openPath(true);

function openPath(initial = false) {
  const path = sourcePath.value.trim();
  try {
    const url = new URL(path, location.href);
    if (!path || url.origin !== location.origin || !["http:", "https:"].includes(url.protocol)) {
      throw new Error("Enter a PDF path on this server, or upload a local file.");
    }
    if (uploadedUrl) {
      URL.revokeObjectURL(uploadedUrl);
      uploadedUrl = null;
    }
    if (!initial) pageNumber.value = "1";
    openDocument({ url: url.href, label: decodeURIComponent(url.pathname.split("/").at(-1)), path });
  } catch (error) {
    setStatus(`Could not open path: ${error.message}`, true);
  }
}

async function openDocument(source) {
  const token = ++loadToken;
  ++renderToken;
  renderController?.abort();
  if (current?.pdfjs) {
    current.pdfjs.destroy().catch((error) => console.error("Could not close PDF.js document:", error));
  }
  current = null;
  comparison = null;
  markedPoint = null;
  copyButton.disabled = true;
  for (const pane of Object.values(panes)) pane.replaceChildren();
  document.getElementById("lite-caption").textContent = "";
  document.getElementById("pdfjs-caption").textContent = "";
  document.getElementById("difference-caption").textContent = "Difference map unavailable.";
  pageTotal.textContent = "of 0";
  previousButton.disabled = true;
  nextButton.disabled = true;
  setStatus(`Loading ${source.label} in both renderers...`);

  const [lite, pdfjs] = await Promise.allSettled([
    loadPdfCrumb(source.url, { limits: { maxPagePixels: MAX_COMPARE_PIXELS } }),
    loadPdfJsDocument(source.url),
  ]);
  if (token !== loadToken) {
    if (pdfjs.status === "fulfilled") {
      await pdfjs.value.destroy().catch((error) => console.error("Could not close PDF.js document:", error));
    }
    return;
  }
  current = {
    ...source,
    lite: lite.status === "fulfilled" ? lite.value : null,
    pdfjs: pdfjs.status === "fulfilled" ? pdfjs.value : null,
    loadErrors: {
      lite: lite.status === "rejected" ? String(lite.reason?.message || lite.reason) : null,
      pdfjs: pdfjs.status === "rejected" ? String(pdfjs.reason?.message || pdfjs.reason) : null,
    },
  };
  const pages = Math.max(current.lite?.pages.length || 0, current.pdfjs?.numPages || 0);
  pageTotal.textContent = `of ${pages}`;
  pageNumber.max = String(pages);
  copyButton.disabled = false;
  if (!pages) {
    showErrors(current.loadErrors);
    updateReport();
    setStatus("Neither renderer could open this PDF. See the report for errors.", true);
    return;
  }
  await showPage(Number(pageNumber.value));
}

async function showPage(number) {
  if (!current) return;
  const pages = Math.max(current.lite?.pages.length || 0, current.pdfjs?.numPages || 0);
  if (!Number.isInteger(number) || number < 1 || number > pages) {
    setStatus(`Page must be between 1 and ${pages}.`, true);
    return;
  }
  const scale = Number(scaleInput.value);
  if (!Number.isFinite(scale) || scale <= 0) {
    setStatus("Select a valid scale.", true);
    return;
  }
  if (!["stable", "embedded"].includes(fontModeInput.value)) {
    setStatus("Select a valid font mode.", true);
    return;
  }
  pageNumber.value = String(number);
  previousButton.disabled = number === 1;
  nextButton.disabled = number === pages;
  if (current.path) {
    const url = new URL(location.href);
    url.searchParams.set("pdf", current.path);
    url.searchParams.set("page", String(number));
    url.searchParams.set("scale", scaleInput.value);
    url.searchParams.set("font", fontModeInput.value);
    history.replaceState(null, "", url);
  } else {
    history.replaceState(null, "", location.pathname);
  }
  const token = ++renderToken;
  renderController?.abort();
  const controller = new AbortController();
  renderController = controller;
  comparison = null;
  markedPoint = null;
  setStatus(`Rendering page ${number} of ${pages}...`);
  for (const pane of Object.values(panes)) pane.replaceChildren();

  const errors = { ...current.loadErrors };
  let liteCanvas = null;
  let pdfjsCanvas = null;
  let operators = new Map();
  if (current.lite) {
    try {
      if (number > current.lite.pages.length) throw new Error("Page is not in the pdf-crumb page tree.");
      liteCanvas = document.createElement("canvas");
      const result = await current.lite.renderPage(number - 1, liteCanvas, {
        scale, fontMode: fontModeInput.value, signal: controller.signal,
      });
      operators = result.unsupportedOperators;
    } catch (error) {
      errors.lite = String(error.message || error);
      liteCanvas = null;
    }
  }
  if (token !== renderToken) return;
  if (current.pdfjs) {
    try {
      if (number > current.pdfjs.numPages) throw new Error("Page is not in the PDF.js page tree.");
      pdfjsCanvas = document.createElement("canvas");
      await renderPdfJsPage(current.pdfjs, number - 1, pdfjsCanvas, scale, MAX_COMPARE_PIXELS);
    } catch (error) {
      errors.pdfjs = String(error.message || error);
      pdfjsCanvas = null;
    }
  }
  if (token !== renderToken) return;
  showCanvas(panes.lite, liteCanvas, errors.lite);
  showCanvas(panes.pdfjs, pdfjsCanvas, errors.pdfjs);

  let difference = null;
  if (liteCanvas && pdfjsCanvas) {
    try {
      if (liteCanvas.width !== pdfjsCanvas.width || liteCanvas.height !== pdfjsCanvas.height) {
        throw new Error("Canvas dimensions differ; a pixel-aligned difference map is unavailable.");
      }
      const width = Math.max(liteCanvas.width, pdfjsCanvas.width);
      const height = Math.max(liteCanvas.height, pdfjsCanvas.height);
      if (width * height > MAX_COMPARE_PIXELS) {
        throw new Error(`Difference map exceeds ${MAX_COMPARE_PIXELS} pixels. Reduce the scale.`);
      }
      const canvas = document.createElement("canvas");
      difference = paintDifferenceCanvas(canvas, liteCanvas, pdfjsCanvas);
      showCanvas(panes.difference, canvas);
    } catch (error) {
      errors.difference = String(error.message || error);
      showCanvas(panes.difference, null, errors.difference);
    }
  } else {
    showCanvas(panes.difference, null, "Both pages must render to show a difference map.");
  }
  comparison = { page: number, scale, liteCanvas, pdfjsCanvas, difference, operators, errors };
  document.getElementById("lite-caption").textContent = liteCanvas ? `${liteCanvas.width} × ${liteCanvas.height} pixels` : "Not rendered";
  document.getElementById("pdfjs-caption").textContent = pdfjsCanvas ? `${pdfjsCanvas.width} × ${pdfjsCanvas.height} pixels` : "Not rendered";
  document.getElementById("difference-caption").textContent = difference
    ? `${formatDifference(difference)} · ${(100 * difference.substantialPixels / difference.totalPixels).toFixed(2)}% differ strongly (>20). Red: pdf-crumb brighter; green: PDF.js brighter.`
    : "Difference map unavailable.";
  updateReport();
  setStatus(difference
    ? `Rendered page ${number} of ${pages}. Click any canvas to mark a discrepancy.`
    : `Comparison incomplete for page ${number}. See panel and report errors.`, !difference);
}

function showCanvas(pane, canvas, error) {
  if (!canvas) {
    const message = document.createElement("p");
    message.className = "compare-panel-error";
    message.textContent = error || "No page available.";
    pane.replaceChildren(message);
    return;
  }
  const stage = document.createElement("div");
  stage.className = "compare-stage";
  stage.appendChild(canvas);
  pane.replaceChildren(stage);
}

function showErrors(errors) {
  showCanvas(panes.lite, null, errors.lite);
  showCanvas(panes.pdfjs, null, errors.pdfjs);
  showCanvas(panes.difference, null, "Both pages must render to compare.");
}

function updateMarkers() {
  for (const stage of document.querySelectorAll(".compare-stage")) {
    stage.querySelector(".compare-marker")?.remove();
    if (!markedPoint) continue;
    const marker = document.createElement("span");
    marker.className = "compare-marker";
    marker.style.left = `${markedPoint.x * 100}%`;
    marker.style.top = `${markedPoint.y * 100}%`;
    stage.appendChild(marker);
  }
}

function updateReport() {
  if (!current) {
    reportOutput.value = "";
    return;
  }
  const result = comparison;
  const difference = result?.difference;
  const lines = [
    `PDF: ${current.label}`,
    `Source: ${current.path || "Local upload (re-upload required; no shareable URL)"}`,
    `Page: ${result?.page || pageNumber.value} / pdf-crumb ${current.lite?.pages.length ?? "failed"}, PDF.js ${current.pdfjs?.numPages ?? "failed"}`,
    `Scale: ${result?.scale || scaleInput.value}; font mode: ${fontModeInput.value}`,
    `Canvas: pdf-crumb ${canvasSize(result?.liteCanvas)}, PDF.js ${canvasSize(result?.pdfjsCanvas)}`,
  ];
  if (difference) {
    lines.push(`Pixel difference: ${formatDifference(difference)}`);
    lines.push(`Strong differences (>20/255): ${difference.substantialPixels} / ${difference.totalPixels} (${(100 * difference.substantialPixels / difference.totalPixels).toFixed(2)}%)`);
  }
  const markedCanvas = result?.liteCanvas || result?.pdfjsCanvas;
  if (markedPoint && markedCanvas) {
    lines.push(`Marked location: ${Math.round(markedPoint.x * markedCanvas.width)} × ${Math.round(markedPoint.y * markedCanvas.height)} on ${result.liteCanvas ? "pdf-crumb" : "PDF.js"} canvas (${(markedPoint.x * 100).toFixed(1)}%, ${(markedPoint.y * 100).toFixed(1)}% from top left)`);
  }
  lines.push(`Unsupported operators: ${result?.operators.size ? [...result.operators].map(([name, count]) => `${name} (${count})`).join(", ") : "none reported"}`);
  const warnings = current.lite?.warnings || [];
  lines.push(`Warnings: ${warnings.length ? warnings.slice(0, 10).join(" | ") : "none"}`);
  if (warnings.length > 10) lines.push(`Additional warnings: ${warnings.length - 10}`);
  for (const [engine, error] of Object.entries(result?.errors || current.loadErrors)) {
    if (error) lines.push(`${engine} error: ${error}`);
  }
  reportOutput.value = lines.join("\n");
}

function canvasSize(canvas) {
  return canvas ? `${canvas.width} × ${canvas.height}` : "unavailable";
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}
