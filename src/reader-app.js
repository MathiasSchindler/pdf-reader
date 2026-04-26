import { loadPdfLite } from "./pdf-lite.js";

const defaultManifestPath = "./samples.js";
const defaultPdfBasePath = "./pdf-files";

const documentSelect = document.getElementById("document-select");
const scaleInput = document.getElementById("scale-input");
const renderButton = document.getElementById("render-button");
const statusView = document.getElementById("status");
const documentOutput = document.getElementById("document-output");
const auditOutput = document.getElementById("audit-output");
const operatorOutput = document.getElementById("operator-output");
const pageStack = document.getElementById("page-stack");

let documents = [];
let renderToken = 0;

init();

async function init() {
  try {
    documents = await loadDocuments();
    documentSelect.innerHTML = documents.map((document) => `
      <option value="${escapeHtml(document.id)}">${escapeHtml(documentLabel(document))}</option>
    `).join("");
    const fromHash = location.hash.replace(/^#/, "");
    if (documents.some((document) => document.id === fromHash)) {
      documentSelect.value = fromHash;
    }
    renderButton.addEventListener("click", renderSelectedDocument);
    documentSelect.addEventListener("change", () => {
      location.hash = documentSelect.value;
      renderSelectedDocument();
    });
    scaleInput.addEventListener("input", renderSelectedDocument);
    window.addEventListener("hashchange", renderDocumentFromHash);
    await renderSelectedDocument();
  } catch (error) {
    setStatus(error.stack || error.message, true);
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
    pdfUrl: document.pdfUrl || joinUrlPath(pdfBasePath, document.pdfPath),
  }));
}

function renderDocumentFromHash() {
  const fromHash = location.hash.replace(/^#/, "");
  if (fromHash && documents.some((document) => document.id === fromHash)) {
    documentSelect.value = fromHash;
    renderSelectedDocument();
  }
}

async function renderSelectedDocument() {
  const selectedDocument = documents.find((candidate) => candidate.id === documentSelect.value) || documents[0];
  if (!selectedDocument) {
    setStatus("No documents available", true);
    return;
  }
  const token = ++renderToken;
  const scale = Number(scaleInput.value) || 1;
  setStatus(`Loading ${selectedDocument.number || selectedDocument.id}`);
  pageStack.innerHTML = "";
  auditOutput.textContent = "";
  operatorOutput.textContent = "";
  documentOutput.textContent = formatObject(documentSummary(selectedDocument));
  try {
    const pdf = await loadPdfLite(selectedDocument.pdfUrl);
    if (token !== renderToken) {
      return;
    }
    const summary = pdf.audit();
    auditOutput.textContent = formatObject(summary);
    setStatus(`Parsed ${documentLabel(selectedDocument)}: ${summary.pages} pages, ${summary.objects} objects. Rendering pages.`);
    const unsupported = new Map();
    for (let index = 0; index < pdf.pages.length; index += 1) {
      if (token !== renderToken) {
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
      const result = await pdf.renderPage(index, canvas, { scale });
      for (const [operator, count] of result.unsupportedOperators) {
        unsupported.set(operator, (unsupported.get(operator) || 0) + count);
      }
    }
    operatorOutput.textContent = formatUnsupported(unsupported);
    setStatus(`Rendered ${documentLabel(selectedDocument)}: ${summary.pages} pages`);
  } catch (error) {
    if (token === renderToken) {
      setStatus(error.stack || error.message, true);
    }
  }
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
