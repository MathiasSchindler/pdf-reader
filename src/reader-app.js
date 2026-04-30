import { loadPdfLite } from "./pdf-lite/index.js";

const defaultManifestPath = new URL("../samples.js", import.meta.url).href;
const defaultPdfBasePath = new URL("../pdf-files", import.meta.url).href;

const documentSelect = document.getElementById("document-select");
const uploadInput = document.getElementById("upload-input");
const scaleInput = document.getElementById("scale-input");
const pageRangeInput = document.getElementById("page-range-input");
const viewModeSelect = document.getElementById("view-mode-select");
const fontModeSelect = document.getElementById("font-mode-select");
const renderButton = document.getElementById("render-button");
const statusView = document.getElementById("status");
const documentOutput = document.getElementById("document-output");
const auditOutput = document.getElementById("audit-output");
const operatorOutput = document.getElementById("operator-output");
const differenceOutput = document.getElementById("difference-output");
const pageStack = document.getElementById("page-stack");

let documents = [];
let renderToken = 0;
let pdfjsModulePromise = null;
let uploadedDocumentUrl = null;

init();

async function init() {
  try {
    documents = await loadDocuments();
    renderDocumentOptions();
    const fromHash = location.hash.replace(/^#/, "");
    if (documents.some((document) => document.id === fromHash)) {
      documentSelect.value = fromHash;
    }
    renderButton.addEventListener("click", renderSelectedDocument);
    documentSelect.addEventListener("change", () => {
      location.hash = documentSelect.value;
      renderSelectedDocument();
    });
    uploadInput.addEventListener("change", () => {
      const file = uploadInput.files?.[0];
      if (file) {
        addUploadedDocument(file);
      }
    });
    scaleInput.addEventListener("input", renderSelectedDocument);
    pageRangeInput.addEventListener("change", renderSelectedDocument);
    pageRangeInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        renderSelectedDocument();
      }
    });
    viewModeSelect.addEventListener("change", renderSelectedDocument);
    fontModeSelect.addEventListener("change", renderSelectedDocument);
    window.addEventListener("hashchange", renderDocumentFromHash);
    await renderSelectedDocument();
  } catch (error) {
    setStatus(error.stack || error.message, true);
  }
}

class UserInputError extends Error {
  constructor(message) {
    super(message);
    this.userInput = true;
  }
}

async function loadDocuments() {
  const params = new URLSearchParams(location.search);
  const manifestPath = params.get("manifest") || defaultManifestPath;
  const pdfBasePath = params.get("base") || defaultPdfBasePath;
  const response = await fetch(manifestPath, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load manifest ${manifestPath}: ${response.status}`);
  }
  const source = await response.text();
  const manifest = Function(`${source}; return typeof BT_DRUCKSACHEN !== "undefined" ? BT_DRUCKSACHEN : [];`)();
  return manifest.map((document) => ({
    ...document,
    pdfUrl: document.pdfUrl ? resolveUrl(document.pdfUrl, manifestPath) : joinUrlPath(pdfBasePath, document.pdfPath),
  }));
}

function renderDocumentOptions() {
  documentSelect.innerHTML = documents.map((document) => `
    <option value="${escapeHtml(document.id)}">${escapeHtml(documentLabel(document))}</option>
  `).join("");
}

function addUploadedDocument(file) {
  if (uploadedDocumentUrl) {
    URL.revokeObjectURL(uploadedDocumentUrl);
  }
  uploadedDocumentUrl = URL.createObjectURL(file);
  const document = {
    id: `upload-${Date.now()}`,
    number: "upload",
    type: "local file",
    title: file.name,
    pdfUrl: uploadedDocumentUrl,
    fileSize: file.size,
    uploaded: true,
  };
  documents = [document, ...documents.filter((candidate) => !candidate.uploaded)];
  renderDocumentOptions();
  documentSelect.value = document.id;
  location.hash = document.id;
  renderSelectedDocument();
}

function renderDocumentFromHash() {
  const fromHash = location.hash.replace(/^#/, "");
  if (fromHash && documents.some((document) => document.id === fromHash)) {
    documentSelect.value = fromHash;
    renderSelectedDocument();
  }
}

function parsePageRange(value, pageCount) {
  const source = String(value || "").trim().toLowerCase();
  if (!source || source === "all" || source === "*") {
    return Array.from({ length: pageCount }, (_, index) => index);
  }
  const pages = new Set();
  for (const part of source.split(",")) {
    const token = part.trim();
    if (!token) {
      continue;
    }
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    const single = token.match(/^\d+$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      validatePageBounds(start, end, pageCount);
      for (let page = start; page <= end; page += 1) {
        pages.add(page - 1);
      }
    } else if (single) {
      const page = Number(token);
      validatePageBounds(page, page, pageCount);
      pages.add(page - 1);
    } else {
      throw new UserInputError(`Invalid page range "${value}". Use values like all, 1, 1-3, or 1,3,7-9.`);
    }
  }
  if (!pages.size) {
    throw new UserInputError("Page range did not include any pages.");
  }
  return Array.from(pages).sort((left, right) => left - right);
}

function validatePageBounds(start, end, pageCount) {
  if (start < 1 || end < 1 || start > pageCount || end > pageCount || start > end) {
    throw new UserInputError(`Page range must be between 1 and ${pageCount}, with ranges in ascending order.`);
  }
}

function formatPageSelection(pageIndexes, pageCount) {
  if (pageIndexes.length === pageCount) {
    return `${pageCount} pages`;
  }
  return `${pageIndexes.length} of ${pageCount} pages (${compactPageList(pageIndexes)})`;
}

function compactPageList(pageIndexes) {
  const ranges = [];
  for (let offset = 0; offset < pageIndexes.length;) {
    const start = pageIndexes[offset] + 1;
    let end = start;
    offset += 1;
    while (offset < pageIndexes.length && pageIndexes[offset] + 1 === end + 1) {
      end = pageIndexes[offset] + 1;
      offset += 1;
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  return ranges.join(",");
}

async function renderSelectedDocument() {
  const selectedDocument = documents.find((candidate) => candidate.id === documentSelect.value) || documents[0];
  if (!selectedDocument) {
    setStatus("No documents available", true);
    return;
  }
  const token = ++renderToken;
  const scale = Number(scaleInput.value) || 1;
  const viewMode = viewModeSelect.value || "lite";
  const fontMode = fontModeSelect.value || "stable";
  setStatus(`Loading ${selectedDocument.number || selectedDocument.id}`);
  pageStack.innerHTML = "";
  auditOutput.textContent = "";
  operatorOutput.textContent = "";
  differenceOutput.textContent = "";
  documentOutput.textContent = formatObject(documentSummary(selectedDocument));
  try {
    const pdf = await loadPdfLite(selectedDocument.pdfUrl);
    if (token !== renderToken) {
      return;
    }
    const summary = pdf.audit();
    auditOutput.textContent = formatObject(summary);
    const pageIndexes = parsePageRange(pageRangeInput.value, pdf.pages.length);
    const pageSelection = formatPageSelection(pageIndexes, pdf.pages.length);
    const pdfjsDocument = viewMode === "lite" ? null : await loadPdfJsDocument(selectedDocument.pdfUrl);
    if (token !== renderToken) {
      await pdfjsDocument?.destroy();
      return;
    }
    setStatus(`Parsed ${documentLabel(selectedDocument)}: ${summary.pages} pages, ${summary.objects} objects. Rendering ${pageSelection} in ${viewModeLabel(viewMode)} mode with ${fontModeLabel(fontMode)} fonts.`);
    const unsupported = new Map();
    const differences = [];
    for (const index of pageIndexes) {
      if (token !== renderToken) {
        await pdfjsDocument?.destroy();
        return;
      }
      const frame = document.createElement("article");
      frame.className = "page-frame";
      const label = document.createElement("div");
      label.className = "page-label";
      label.textContent = `Page ${index + 1}`;
      const canvas = document.createElement("canvas");
      frame.append(label, canvas);
      pageStack.appendChild(frame);
      const result = await renderPageForMode({ pdf, pdfjsDocument, index, canvas, scale, viewMode, fontMode });
      for (const [operator, count] of result.unsupportedOperators) {
        unsupported.set(operator, (unsupported.get(operator) || 0) + count);
      }
      if (result.difference) {
        differences.push({ page: index + 1, ...result.difference });
        label.textContent = `Page ${index + 1} · ${formatDifference(result.difference)}`;
      }
    }
    await pdfjsDocument?.destroy();
    operatorOutput.textContent = formatUnsupported(unsupported);
    differenceOutput.textContent = formatDifferences(differences);
    setStatus(`Rendered ${documentLabel(selectedDocument)}: ${pageSelection} in ${viewModeLabel(viewMode)} mode with ${fontModeLabel(fontMode)} fonts`);
  } catch (error) {
    if (token === renderToken) {
      setStatus(error.userInput ? error.message : error.stack || error.message, true);
    }
  }
}

async function renderPageForMode({ pdf, pdfjsDocument, index, canvas, scale, viewMode, fontMode }) {
  if (viewMode === "pdfjs") {
    await renderPdfJsPage(pdfjsDocument, index, canvas, scale);
    return { unsupportedOperators: new Map() };
  }
  if (viewMode === "diff") {
    return renderDifferencePage(pdf, pdfjsDocument, index, canvas, scale, fontMode);
  }
  return pdf.renderPage(index, canvas, { scale, fontMode });
}

async function renderDifferencePage(pdf, pdfjsDocument, index, canvas, scale, fontMode) {
  const liteCanvas = document.createElement("canvas");
  const result = await pdf.renderPage(index, liteCanvas, { scale, fontMode });
  const pdfjsCanvas = document.createElement("canvas");
  await renderPdfJsPage(pdfjsDocument, index, pdfjsCanvas, scale);
  const difference = paintDifferenceCanvas(canvas, liteCanvas, pdfjsCanvas);
  return { unsupportedOperators: result.unsupportedOperators, difference };
}

async function renderPdfJsPage(pdfjsDocument, index, canvas, scale) {
  const page = await pdfjsDocument.getPage(index + 1);
  const viewport = page.getViewport({ scale });
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * pixelRatio);
  canvas.height = Math.floor(viewport.height * pixelRatio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  const context = canvas.getContext("2d");
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  await page.render({ canvasContext: context, viewport }).promise;
}

function paintDifferenceCanvas(targetCanvas, firstCanvas, secondCanvas) {
  const width = Math.max(firstCanvas.width, secondCanvas.width);
  const height = Math.max(firstCanvas.height, secondCanvas.height);
  targetCanvas.width = width;
  targetCanvas.height = height;
  targetCanvas.style.width = firstCanvas.style.width || `${width}px`;
  targetCanvas.style.height = firstCanvas.style.height || `${height}px`;
  const first = normalizedImageData(firstCanvas, width, height);
  const second = normalizedImageData(secondCanvas, width, height);
  const output = new ImageData(width, height);
  let changed = 0;
  let redPixels = 0;
  let greenPixels = 0;
  let totalDelta = 0;
  let maxDelta = 0;
  for (let index = 0; index < output.data.length; index += 4) {
    const redDelta = first.data[index] - second.data[index];
    const greenDelta = first.data[index + 1] - second.data[index + 1];
    const blueDelta = first.data[index + 2] - second.data[index + 2];
    const magnitude = Math.max(Math.abs(redDelta), Math.abs(greenDelta), Math.abs(blueDelta));
    if (magnitude > 2) {
      const signedDelta = relativeLuminance(first.data, index) - relativeLuminance(second.data, index);
      const intensity = Math.min(255, Math.max(32, magnitude * 4));
      if (signedDelta >= 0) {
        output.data[index] = intensity;
        redPixels += 1;
      } else {
        output.data[index + 1] = intensity;
        greenPixels += 1;
      }
      changed += 1;
      totalDelta += magnitude;
      maxDelta = Math.max(maxDelta, magnitude);
    }
    output.data[index + 3] = 255;
  }
  targetCanvas.getContext("2d").putImageData(output, 0, 0);
  return {
    changedPixels: changed,
    totalPixels: width * height,
    redPixels,
    greenPixels,
    meanDelta: changed ? totalDelta / changed : 0,
    maxDelta,
  };
}

function relativeLuminance(data, index) {
  return data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
}

function normalizedImageData(canvas, width, height) {
  if (canvas.width === width && canvas.height === height) {
    return canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height);
  }
  const normalized = document.createElement("canvas");
  normalized.width = width;
  normalized.height = height;
  normalized.getContext("2d").drawImage(canvas, 0, 0, width, height);
  return normalized.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height);
}

async function loadPdfJsDocument(url) {
  const pdfjs = await loadPdfJsModule();
  return pdfjs.getDocument(url).promise;
}

async function loadPdfJsModule() {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import("../vendor/pdfjs/pdf.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;
      return pdfjs;
    });
  }
  return pdfjsModulePromise;
}

function viewModeLabel(mode) {
  return ({ lite: "pdf-crumb", pdfjs: "PDF.js", diff: "difference" })[mode] || mode;
}

function fontModeLabel(mode) {
  return ({ stable: "stable", embedded: "embedded outline" })[mode] || mode;
}

function formatDifference(difference) {
  const changedPercent = difference.totalPixels ? (difference.changedPixels / difference.totalPixels) * 100 : 0;
  return `${changedPercent.toFixed(2)}% changed, red ${difference.redPixels}, green ${difference.greenPixels}, mean ${difference.meanDelta.toFixed(1)}, max ${difference.maxDelta}`;
}

function formatDifferences(differences) {
  if (!differences.length) {
    return "Not rendered in difference mode.";
  }
  const totals = differences.reduce((sum, difference) => ({
    changedPixels: sum.changedPixels + difference.changedPixels,
    totalPixels: sum.totalPixels + difference.totalPixels,
    redPixels: sum.redPixels + difference.redPixels,
    greenPixels: sum.greenPixels + difference.greenPixels,
    weightedDelta: sum.weightedDelta + difference.meanDelta * difference.changedPixels,
    maxDelta: Math.max(sum.maxDelta, difference.maxDelta),
  }), { changedPixels: 0, totalPixels: 0, redPixels: 0, greenPixels: 0, weightedDelta: 0, maxDelta: 0 });
  const aggregate = {
    ...totals,
    meanDelta: totals.changedPixels ? totals.weightedDelta / totals.changedPixels : 0,
  };
  return [
    `All pages: ${formatDifference(aggregate)}`,
    ...differences.map((difference) => `Page ${difference.page}: ${formatDifference(difference)}`),
  ].join("\n");
}

function documentLabel(document) {
  return [document.number, document.type, document.title].filter(Boolean).join(" · ") || document.id || "Untitled PDF";
}

function documentSummary(document) {
  return {
    id: document.id,
    number: document.number,
    type: document.type,
    title: document.title,
    pdfUrl: document.pdfUrl,
    fileSize: document.fileSize,
  };
}

function formatUnsupported(operators) {
  if (!operators.size) {
    return "None seen in interpreted content streams.";
  }
  return Array.from(operators)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([operator, count]) => `${operator}: ${count}`)
    .join("\n");
}

function joinUrlPath(base, path) {
  return `${String(base || "").replace(/\/$/, "")}/${String(path || "").replace(/^\//, "")}`;
}

function resolveUrl(path, base) {
  try {
    return new URL(path, base).href;
  } catch {
    return path;
  }
}

function setStatus(message, isError = false) {
  statusView.textContent = message;
  statusView.classList.toggle("error", isError);
}

function formatObject(value) {
  return JSON.stringify(value, null, 2);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
