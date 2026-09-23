let pdfjsModulePromise = null;

export async function loadPdfJsDocument(url) {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import("../vendor/pdfjs/pdf.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;
      return pdfjs;
    });
  }
  const pdfjs = await pdfjsModulePromise;
  return pdfjs.getDocument(url).promise;
}

export async function renderPdfJsPage(pdfjsDocument, index, canvas, scale, maxPixels = Infinity) {
  const page = await pdfjsDocument.getPage(index + 1);
  const viewport = page.getViewport({ scale });
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.floor(viewport.width * pixelRatio);
  const height = Math.floor(viewport.height * pixelRatio);
  if (width * height > maxPixels) {
    throw new Error(`Comparison page exceeds ${maxPixels} pixels. Reduce the scale.`);
  }
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  const context = canvas.getContext("2d");
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  await page.render({ canvasContext: context, viewport }).promise;
}

export function paintDifferenceCanvas(targetCanvas, firstCanvas, secondCanvas) {
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
  let substantial = 0;
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
      if (magnitude > 20) substantial += 1;
      changed += 1;
      totalDelta += magnitude;
      maxDelta = Math.max(maxDelta, magnitude);
    }
    output.data[index + 3] = 255;
  }
  targetCanvas.getContext("2d").putImageData(output, 0, 0);
  return {
    changedPixels: changed,
    substantialPixels: substantial,
    totalPixels: width * height,
    redPixels,
    greenPixels,
    meanDelta: changed ? totalDelta / changed : 0,
    maxDelta,
  };
}

export function formatDifference(difference) {
  const changedPercent = difference.totalPixels ? (difference.changedPixels / difference.totalPixels) * 100 : 0;
  return `${changedPercent.toFixed(2)}% changed, red ${difference.redPixels}, green ${difference.greenPixels}, mean ${difference.meanDelta.toFixed(1)}, max ${difference.maxDelta}`;
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
