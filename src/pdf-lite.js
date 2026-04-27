const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const WIN_ANSI = new Map([
  [0x80, "€"], [0x82, "‚"], [0x83, "ƒ"], [0x84, "„"], [0x85, "…"], [0x86, "†"], [0x87, "‡"],
  [0x88, "ˆ"], [0x89, "‰"], [0x8a, "Š"], [0x8b, "‹"], [0x8c, "Œ"], [0x8e, "Ž"], [0x91, "‘"],
  [0x92, "’"], [0x93, "“"], [0x94, "”"], [0x95, "•"], [0x96, "–"], [0x97, "—"], [0x98, "˜"],
  [0x99, "™"], [0x9a, "š"], [0x9b, "›"], [0x9c, "œ"], [0x9e, "ž"], [0x9f, "Ÿ"]
]);

export async function loadPdfLite(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const pdf = new PdfLiteDocument(bytes, url);
  await pdf.parse();
  return pdf;
}

class PdfLiteDocument {
  constructor(bytes, url) {
    this.bytes = bytes;
    this.url = url;
    this.source = bytesToBinaryString(bytes);
    this.objects = new Map();
    this.directObjects = 0;
    this.objectStreams = 0;
    this.decodedObjectStreams = 0;
    this.filters = new Map();
    this.fonts = new Map();
    this.pages = [];
    this.warnings = [];
  }

  async parse() {
    this.readDirectObjects();
    await this.readObjectStreams();
    this.collectPages();
    await this.collectFonts();
  }

  audit() {
    return {
      url: this.url,
      version: this.source.match(/%PDF-([^\r\n]+)/)?.[1] || "unknown",
      objects: this.objects.size,
      directObjects: this.directObjects,
      objectStreams: this.objectStreams,
      decodedObjectStreams: this.decodedObjectStreams,
      pages: this.pages.length,
      filters: Object.fromEntries(Array.from(this.filters).sort()),
      fonts: Array.from(this.fonts.values()).map((font) => ({
        name: font.resourceName,
        subtype: font.subtype,
        baseFont: font.baseFont,
        hasToUnicode: Boolean(font.toUnicode),
        cmapEntries: font.toUnicode?.size || 0,
      })),
      warnings: this.warnings,
    };
  }

  async renderPage(index, canvas, options = {}) {
    const page = this.pages[index];
    if (!page) {
      throw new Error(`Page ${index + 1} not found`);
    }
    const scale = options.scale || 1;
    const mediaBox = page.mediaBox || [0, 0, 595, 842];
    const pageBox = page.cropBox || mediaBox;
    const boxWidth = Math.abs(pageBox[2] - pageBox[0]);
    const boxHeight = Math.abs(pageBox[3] - pageBox[1]);
    const rotation = normalizeRotation(page.rotate);
    const width = rotation === 90 || rotation === 270 ? boxHeight : boxWidth;
    const height = rotation === 90 || rotation === 270 ? boxWidth : boxHeight;
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * scale * pixelRatio);
    canvas.height = Math.floor(height * scale * pixelRatio);
    canvas.style.width = `${Math.floor(width * scale)}px`;
    canvas.style.height = `${Math.floor(height * scale)}px`;
    const context = canvas.getContext("2d");
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width * scale, height * scale);
    const renderer = new ContentRenderer(this, page, context, { scale, width, height, boxWidth, boxHeight, rotation, originX: pageBox[0], originY: pageBox[1] });
    const streams = await this.getPageContentStreams(page);
    await renderer.interpret(streams.map((stream) => bytesToBinaryString(stream)).join("\n"));
    return { unsupportedOperators: renderer.unsupportedOperators };
  }

  readDirectObjects() {
    const objectPattern = /(\d+)\s+(\d+)\s+obj\b/g;
    let match;
    while ((match = objectPattern.exec(this.source))) {
      const id = Number(match[1]);
      const generation = Number(match[2]);
      const start = match.index + match[0].length;
      const end = this.source.indexOf("endobj", start);
      if (end < 0) {
        continue;
      }
      const raw = this.source.slice(start, end).trim();
      const parsed = parsePdfObject(raw);
      const stream = extractStream(this.source, this.bytes, start, end, parsed.value);
      this.objects.set(id, { id, generation, value: parsed.value, stream });
      this.directObjects += 1;
      recordFilter(this.filters, parsed.value);
      objectPattern.lastIndex = end + 6;
    }
  }

  async readObjectStreams() {
    const streams = Array.from(this.objects.values()).filter((object) => object.value?.Type === "ObjStm" && object.stream);
    this.objectStreams = streams.length;
    for (const object of streams) {
      try {
        const decoded = await this.decodeStream(object.stream.bytes, object.value);
        const headerLength = Number(resolvePrimitive(this, object.value.First)) || 0;
        const objectCount = Number(resolvePrimitive(this, object.value.N)) || 0;
        const decodedText = bytesToBinaryString(decoded);
        const header = decodedText.slice(0, headerLength).trim().split(/\s+/).map(Number);
        const body = decodedText.slice(headerLength);
        for (let index = 0; index < objectCount; index += 1) {
          const objectId = header[index * 2];
          const offset = header[index * 2 + 1];
          if (!Number.isFinite(objectId) || !Number.isFinite(offset)) {
            continue;
          }
          const parser = new PdfValueParser(body, offset);
          const value = parser.parseValue();
          if (!this.objects.has(objectId)) {
            this.objects.set(objectId, { id: objectId, generation: 0, value, stream: null, compressedIn: object.id });
            recordFilter(this.filters, value);
          }
        }
        this.decodedObjectStreams += 1;
      } catch (error) {
        this.warnings.push(`Could not decode object stream ${object.id}: ${error.message}`);
      }
    }
  }

  collectPages() {
    const catalog = Array.from(this.objects.values()).find((object) => object.value?.Type === "Catalog")?.value;
    const pagesRoot = this.resolve(catalog?.Pages);
    this.pages = [];
    this.walkPages(pagesRoot, {});
  }

  walkPages(node, inherited) {
    if (!node) {
      return;
    }
    const nextInherited = {
      resources: this.resolve(node.Resources) || inherited.resources,
      mediaBox: numericArray(this.resolve(node.MediaBox)) || inherited.mediaBox,
      cropBox: numericArray(this.resolve(node.CropBox)) || inherited.cropBox,
      rotate: normalizeRotation(this.resolve(node.Rotate) ?? inherited.rotate ?? 0),
    };
    if (node.Type === "Page") {
      this.pages.push({
        object: node,
        resources: nextInherited.resources,
        mediaBox: nextInherited.mediaBox || [0, 0, 595, 842],
        cropBox: nextInherited.cropBox,
        rotate: nextInherited.rotate,
        contents: node.Contents,
      });
      return;
    }
    const kids = this.resolve(node.Kids) || [];
    for (const kid of kids) {
      this.walkPages(this.resolve(kid), nextInherited);
    }
  }

  async collectFonts() {
    for (const page of this.pages) {
      const fonts = this.resolve(page.resources?.Font) || {};
      for (const [resourceName, fontRef] of Object.entries(fonts)) {
        const objectId = fontRef?.ref || `${resourceName}:${Object.keys(this.fonts).length}`;
        if (this.fonts.has(objectId)) {
          continue;
        }
        const font = this.resolve(fontRef) || {};
        const toUnicodeRef = font.ToUnicode;
        let toUnicode = null;
        if (toUnicodeRef?.ref) {
          const cmapObject = this.objects.get(toUnicodeRef.ref);
          if (cmapObject?.stream) {
            try {
              const cmapBytes = await this.decodeStream(cmapObject.stream.bytes, cmapObject.value);
              toUnicode = parseToUnicodeCMap(bytesToBinaryString(cmapBytes));
            } catch (error) {
              this.warnings.push(`Could not decode ToUnicode map for ${resourceName}: ${error.message}`);
            }
          }
        }
        this.fonts.set(objectId, {
          objectId,
          resourceName,
          subtype: font.Subtype || "unknown",
          baseFont: font.BaseFont || "unknown",
          toUnicode,
        });
      }
    }
  }

  async getPageContentStreams(page) {
    const contents = page.contents;
    const resolvedContents = this.resolve(contents);
    const refs = Array.isArray(contents) ? contents : Array.isArray(resolvedContents) ? resolvedContents : [contents];
    const streams = [];
    for (const ref of refs) {
      const object = ref?.ref ? this.objects.get(ref.ref) : Array.from(this.objects.values()).find((candidate) => candidate.value === ref);
      if (object?.stream) {
        streams.push(await this.decodeStream(object.stream.bytes, object.value));
      }
    }
    return streams;
  }

  async decodeStream(bytes, dictionary = {}) {
    const filters = normalizeFilters(this.resolve(dictionary.Filter));
    let output = bytes;
    for (const filter of filters) {
      if (filter === "FlateDecode" || filter === "Fl") {
        output = await inflate(output);
      } else if (filter === "ASCIIHexDecode" || filter === "AHx") {
        output = decodeAsciiHex(output);
      } else if (filter === "ASCII85Decode" || filter === "A85") {
        output = decodeAscii85(output);
      } else if (filter === "RunLengthDecode" || filter === "RL") {
        output = decodeRunLength(output);
      } else {
        throw new Error(`Unsupported stream filter ${filter}`);
      }
    }
    return output;
  }

  objectFor(value) {
    return value?.ref ? this.objects.get(value.ref) : Array.from(this.objects.values()).find((object) => object.value === value);
  }

  resolve(value, depth = 0) {
    if (depth > 20) {
      return value;
    }
    if (value?.ref) {
      return this.resolve(this.objects.get(value.ref)?.value, depth + 1);
    }
    return value;
  }
}

class ContentRenderer {
  constructor(pdf, page, context, metrics) {
    this.pdf = pdf;
    this.page = page;
    this.context = context;
    this.scale = metrics.scale;
    this.pageWidth = metrics.width;
    this.pageHeight = metrics.height;
    this.pageBoxWidth = metrics.boxWidth || metrics.width;
    this.pageBoxHeight = metrics.boxHeight || metrics.height;
    this.rotation = metrics.rotation || 0;
    this.originX = metrics.originX || 0;
    this.originY = metrics.originY || 0;
    this.stack = [];
    this.state = this.defaultState();
    this.unsupportedOperators = new Map();
    this.resources = page.resources || {};
    this.resourceStack = [];
    this.xObjectDepth = 0;
  }

  defaultState() {
    return {
      ctm: [1, 0, 0, 1, 0, 0],
      fill: "#000",
      stroke: "#000",
      fillColorSpace: "DeviceGray",
      strokeColorSpace: "DeviceGray",
      fillAlpha: 1,
      strokeAlpha: 1,
      lineWidth: 1,
      lineDash: [],
      lineDashOffset: 0,
      miterLimit: 10,
      lineCap: "butt",
      lineJoin: "miter",
      currentPoint: null,
      fontName: null,
      fontSize: 10,
      charSpacing: 0,
      wordSpacing: 0,
      horizontalScale: 1,
      leading: 0,
      textRenderingMode: 0,
      textRise: 0,
      textMatrix: [1, 0, 0, 1, 0, 0],
      lineMatrix: [1, 0, 0, 1, 0, 0],
    };
  }

  async interpret(content) {
    const tokens = tokenizeContent(content);
    const operands = [];
    for (const token of tokens) {
      if (token.type !== "operator") {
        operands.push(token.value);
        continue;
      }
      await this.applyOperator(token.value, operands.splice(0));
    }
  }

  async applyOperator(operator, operands) {
    switch (operator) {
      case "q":
        this.stack.push(structuredClone(this.state));
        this.context.save();
        break;
      case "Q":
        this.state = this.stack.pop() || this.defaultState();
        this.context.restore();
        break;
      case "cm":
        this.state.ctm = multiplyMatrix(this.state.ctm, operands.slice(-6).map(Number));
        break;
      case "w":
        this.state.lineWidth = Number(operands.at(-1)) || 1;
        break;
      case "M":
        this.state.miterLimit = Number(operands.at(-1)) || 10;
        break;
      case "d":
        this.state.lineDash = Array.isArray(operands[0]) ? operands[0].map(Number) : [];
        this.state.lineDashOffset = Number(operands[1]) || 0;
        break;
      case "J":
        this.state.lineCap = ["butt", "round", "square"][Number(operands.at(-1))] || "butt";
        break;
      case "j":
        this.state.lineJoin = ["miter", "round", "bevel"][Number(operands.at(-1))] || "miter";
        break;
      case "rg":
      case "g":
        this.state.fill = colorFromOperands(operator, operands);
        break;
      case "RG":
      case "G":
        this.state.stroke = colorFromOperands(operator, operands);
        break;
      case "cs":
        this.state.fillColorSpace = operands.at(-1) || this.state.fillColorSpace;
        break;
      case "CS":
        this.state.strokeColorSpace = operands.at(-1) || this.state.strokeColorSpace;
        break;
      case "sc":
      case "scn":
        this.state.fill = colorFromColorSpace(this.colorSpace(this.state.fillColorSpace), operands);
        break;
      case "SC":
      case "SCN":
        this.state.stroke = colorFromColorSpace(this.colorSpace(this.state.strokeColorSpace), operands);
        break;
      case "gs":
        this.applyGraphicsState(operands.at(-1));
        break;
      case "ri":
      case "i":
        break;
      case "BT":
        this.state.textMatrix = [1, 0, 0, 1, 0, 0];
        this.state.lineMatrix = [1, 0, 0, 1, 0, 0];
        break;
      case "ET":
        break;
      case "Tf":
        this.state.fontName = operands[0];
        this.state.fontSize = Number(operands[1]) || this.state.fontSize;
        break;
      case "Tc":
        this.state.charSpacing = Number(operands[0]) || 0;
        break;
      case "Tw":
        this.state.wordSpacing = Number(operands[0]) || 0;
        break;
      case "Tz":
        this.state.horizontalScale = (Number(operands[0]) || 100) / 100;
        break;
      case "TL":
        this.state.leading = Number(operands[0]) || 0;
        break;
      case "Tr":
        this.state.textRenderingMode = Number(operands[0]) || 0;
        break;
      case "Ts":
        this.state.textRise = Number(operands[0]) || 0;
        break;
      case "Td":
        this.moveText(Number(operands[0]) || 0, Number(operands[1]) || 0);
        break;
      case "TD": {
        const leading = Number(operands[1]) || 0;
        this.state.leading = -leading;
        this.moveText(Number(operands[0]) || 0, leading);
        break;
      }
      case "Tm":
        this.state.textMatrix = operands.slice(0, 6).map(Number);
        this.state.lineMatrix = this.state.textMatrix.slice();
        break;
      case "T*":
        this.moveText(0, -this.state.leading || -this.state.fontSize * 1.2);
        break;
      case "Tj":
        this.showText(operands.at(-1));
        break;
      case "'":
        this.moveText(0, -this.state.leading || -this.state.fontSize * 1.2);
        this.showText(operands.at(-1));
        break;
      case "\"":
        this.state.wordSpacing = Number(operands[0]) || 0;
        this.state.charSpacing = Number(operands[1]) || 0;
        this.moveText(0, -this.state.leading || -this.state.fontSize * 1.2);
        this.showText(operands.at(-1));
        break;
      case "TJ":
        this.showTextArray(operands.at(-1));
        break;
      case "Do":
        await this.paintXObject(operands.at(-1));
        break;
      case "m":
        this.pathMove(operands);
        break;
      case "l":
        this.pathLine(operands);
        break;
      case "c":
        this.pathCurve(operands);
        break;
      case "v":
        this.pathCurveFromCurrent(operands);
        break;
      case "y":
        this.pathCurveToFinalPoint(operands);
        break;
      case "re":
        this.pathRect(operands);
        break;
      case "h":
        this.context.closePath();
        break;
      case "W":
        this.clip("nonzero");
        break;
      case "W*":
        this.clip("evenodd");
        break;
      case "S":
        this.stroke();
        break;
      case "s":
        this.context.closePath();
        this.stroke();
        break;
      case "f":
      case "F":
        this.fill();
        break;
      case "f*":
        this.fill("evenodd");
        break;
      case "B":
        this.fill();
        this.stroke();
        break;
      case "B*":
        this.fill("evenodd");
        this.stroke();
        break;
      case "b":
        this.context.closePath();
        this.fill();
        this.stroke();
        break;
      case "b*":
        this.context.closePath();
        this.fill("evenodd");
        this.stroke();
        break;
      case "n":
        this.context.beginPath();
        this.state.currentPoint = null;
        break;
      case "BDC":
      case "BMC":
      case "EMC":
      case "MP":
      case "DP":
        break;
      default:
        this.unsupported(operator);
    }
  }

  moveText(x, y) {
    const next = multiplyMatrix(this.state.lineMatrix, [1, 0, 0, 1, x, y]);
    this.state.lineMatrix = next;
    this.state.textMatrix = next.slice();
  }

  showTextArray(parts) {
    if (!Array.isArray(parts)) {
      return;
    }
    for (const part of parts) {
      if (typeof part === "number") {
        this.advanceText(-(part / 1000) * this.state.fontSize * this.state.horizontalScale);
      } else {
        this.showText(part);
      }
    }
  }

  showText(value) {
    const text = this.decodeText(value);
    if (!text) {
      return;
    }
    const [x, y] = transformPoint(this.state.ctm, this.state.textMatrix[4], this.state.textMatrix[5]);
    const fontSize = Math.abs(this.state.fontSize * this.state.ctm[3] * this.scale);
    this.context.save();
    this.context.fillStyle = this.state.fill;
    this.context.globalAlpha = this.state.fillAlpha;
    this.context.strokeStyle = this.state.stroke;
    this.context.lineWidth = this.state.lineWidth * this.scale;
    this.context.lineCap = this.state.lineCap;
    this.context.lineJoin = this.state.lineJoin;
    this.context.font = canvasFontFor(this.currentFont(), fontSize);
    const [canvasX, canvasY] = this.pagePoint(x, y + this.state.textRise);
    this.context.translate(canvasX, canvasY);
    this.context.rotate((this.rotation * Math.PI) / 180);
    this.context.scale(this.state.horizontalScale, 1);
    this.paintText(text, 0, 0);
    const advance = this.context.measureText(text).width / this.scale;
    this.context.restore();
    this.advanceText(this.textAdvance(text, advance));
  }

  paintText(text, x, y) {
    const mode = this.state.textRenderingMode;
    const paintMode = mode >= 4 ? mode - 4 : mode;
    if (mode >= 4) {
      this.unsupported("Tr/TextClip");
    }
    if (paintMode === 0 || paintMode === 2) {
      this.context.fillText(text, x, y);
    }
    if (paintMode === 1 || paintMode === 2) {
      const previousAlpha = this.context.globalAlpha;
      this.context.globalAlpha = this.state.strokeAlpha;
      this.context.strokeText(text, x, y);
      this.context.globalAlpha = previousAlpha;
    }
  }

  textAdvance(text, measuredWidth) {
    const spaces = Array.from(text).filter((char) => char === " ").length;
    return (measuredWidth + text.length * this.state.charSpacing + spaces * this.state.wordSpacing) * this.state.horizontalScale;
  }

  advanceText(amount) {
    this.state.textMatrix = multiplyMatrix(this.state.textMatrix, [1, 0, 0, 1, amount, 0]);
  }

  decodeText(value) {
    const bytes = textTokenToBytes(value);
    const font = this.currentFont();
    if (font?.toUnicode?.size) {
      return decodeWithCMap(bytes, font.toUnicode);
    }
    return decodeWinAnsi(bytes);
  }

  currentFont() {
    const fonts = this.pdf.resolve(this.resources?.Font) || {};
    const ref = fonts[this.state.fontName];
    if (!ref?.ref) {
      return null;
    }
    return this.pdf.fonts.get(ref.ref);
  }

  colorSpace(name) {
    const colorSpaces = this.pdf.resolve(this.resources?.ColorSpace) || {};
    return this.pdf.resolve(colorSpaces[name]) || name;
  }

  applyGraphicsState(name) {
    const states = this.pdf.resolve(this.resources?.ExtGState) || {};
    const graphicsState = this.pdf.resolve(states[name]);
    if (!graphicsState) {
      return;
    }
    if (typeof graphicsState.ca === "number") {
      this.state.fillAlpha = graphicsState.ca;
    }
    if (typeof graphicsState.CA === "number") {
      this.state.strokeAlpha = graphicsState.CA;
    }
    if (typeof graphicsState.LW === "number") {
      this.state.lineWidth = graphicsState.LW;
    }
    if (typeof graphicsState.LC === "number") {
      this.state.lineCap = ["butt", "round", "square"][graphicsState.LC] || "butt";
    }
    if (typeof graphicsState.LJ === "number") {
      this.state.lineJoin = ["miter", "round", "bevel"][graphicsState.LJ] || "miter";
    }
    if (typeof graphicsState.ML === "number") {
      this.state.miterLimit = graphicsState.ML;
    }
    if (Array.isArray(graphicsState.D)) {
      this.state.lineDash = Array.isArray(graphicsState.D[0]) ? graphicsState.D[0].map(Number) : [];
      this.state.lineDashOffset = Number(graphicsState.D[1]) || 0;
    }
  }

  async paintXObject(name) {
    const xObjects = this.pdf.resolve(this.resources?.XObject) || {};
    const object = this.pdf.objectFor(xObjects[name]);
    const dictionary = object?.value;
    if (!object?.stream || !dictionary) {
      this.unsupported("Do");
      return;
    }
    if (dictionary.Subtype === "Form") {
      await this.paintFormXObject(object);
      return;
    }
    if (dictionary.Subtype === "Image") {
      await this.paintImageXObject(object);
      return;
    }
    this.unsupported(`Do/${dictionary.Subtype || "unknown"}`);
  }

  async paintFormXObject(object) {
    if (this.xObjectDepth > 12) {
      this.unsupported("Do/FormDepth");
      return;
    }
    const dictionary = object.value;
    let stream;
    try {
      stream = await this.pdf.decodeStream(object.stream.bytes, dictionary);
    } catch (error) {
      this.unsupported("Do/FormFilter");
      return;
    }
    this.context.save();
    this.resourceStack.push(this.resources);
    const previousState = structuredClone(this.state);
    this.xObjectDepth += 1;
    this.resources = this.pdf.resolve(dictionary.Resources) || this.resources;
    const matrix = numericArray(this.pdf.resolve(dictionary.Matrix));
    if (matrix) {
      this.state.ctm = multiplyMatrix(this.state.ctm, matrix);
    }
    await this.interpret(bytesToBinaryString(stream));
    this.state = previousState;
    this.resources = this.resourceStack.pop() || this.page.resources || {};
    this.xObjectDepth -= 1;
    this.context.restore();
  }

  async paintImageXObject(object) {
    const filters = normalizeFilters(this.pdf.resolve(object.value.Filter));
    try {
      if (filters.length === 1 && ["DCTDecode", "DCT"].includes(filters[0])) {
        const image = await createImageBitmap(new Blob([object.stream.bytes], { type: "image/jpeg" }));
        this.drawUnitImage(image);
        image.close?.();
        return;
      }
      if (filters.every(isDataImageFilter)) {
        const imageData = await this.imageDataForXObject(object);
        if (imageData) {
          const image = await createImageBitmap(imageData);
          this.drawUnitImage(image, { smoothing: !isIndexedColorSpace(this.pdf.resolve(object.value.ColorSpace)) });
          image.close?.();
          return;
        }
      }
      this.unsupported(`Do/Image/${filters.join("+") || "raw"}`);
    } catch (error) {
      this.unsupported("Do/ImageDecode");
    }
  }

  drawUnitImage(image, options = {}) {
    const [a, b, c, d, e, f] = this.state.ctm;
    const [canvasX, canvasY] = this.pagePoint(e, f);
    const [xA, xB] = this.pageVector(a, b);
    const [yA, yB] = this.pageVector(c, d);
    this.context.save();
    this.context.imageSmoothingEnabled = options.smoothing !== false;
    this.context.transform(xA, xB, yA, yB, canvasX, canvasY);
    this.context.transform(1, 0, 0, -1, 0, 1);
    this.context.drawImage(image, 0, 0, 1, 1);
    this.context.restore();
  }

  async imageDataForXObject(object) {
    const dictionary = object.value;
    const width = Number(this.pdf.resolve(dictionary.Width));
    const height = Number(this.pdf.resolve(dictionary.Height));
    const bits = Number(this.pdf.resolve(dictionary.BitsPerComponent));
    if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(bits)) {
      return null;
    }
    const colorSpace = this.pdf.resolve(dictionary.ColorSpace);
    const palette = await indexedColorPalette(this.pdf, colorSpace);
    if (palette) {
      const pixels = unpackIndexedSamples(applyImageDecodeParms(await this.pdf.decodeStream(object.stream.bytes, dictionary), dictionary, width, height), bits, width, height, dictionary.Decode);
      const alpha = await this.imageAlphaForXObject(dictionary, width, height);
      const imageData = new ImageData(width, height);
      for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex += 1) {
        const color = palette.colors[pixels[pixelIndex]] || palette.colors[0] || [0, 0, 0];
        const targetIndex = pixelIndex * 4;
        imageData.data[targetIndex] = color[0];
        imageData.data[targetIndex + 1] = color[1];
        imageData.data[targetIndex + 2] = color[2];
        imageData.data[targetIndex + 3] = alpha?.[pixelIndex] ?? 255;
      }
      return imageData;
    }
    if (bits !== 8) {
      return null;
    }
    const pixels = applyImageDecodeParms(await this.pdf.decodeStream(object.stream.bytes, dictionary), dictionary, width, height);
    const components = imageComponents(colorSpace, pixels.length, width, height);
    if (![1, 3, 4].includes(components)) {
      return null;
    }
    const expectedLength = width * height * components;
    if (pixels.length < expectedLength) {
      return null;
    }
    const alpha = await this.imageAlphaForXObject(dictionary, width, height);
    const imageData = new ImageData(width, height);
    for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex += 1) {
      const sourceIndex = pixelIndex * components;
      const targetIndex = pixelIndex * 4;
      const decoded = decodeImageComponents(pixels, sourceIndex, components, dictionary.Decode);
      if (components === 1) {
        const gray = decoded[0];
        imageData.data[targetIndex] = gray;
        imageData.data[targetIndex + 1] = gray;
        imageData.data[targetIndex + 2] = gray;
      } else if (components === 4) {
        const [red, green, blue] = cmykToRgb(decoded[0], decoded[1], decoded[2], decoded[3]);
        imageData.data[targetIndex] = red;
        imageData.data[targetIndex + 1] = green;
        imageData.data[targetIndex + 2] = blue;
      } else {
        imageData.data[targetIndex] = decoded[0];
        imageData.data[targetIndex + 1] = decoded[1];
        imageData.data[targetIndex + 2] = decoded[2];
      }
      imageData.data[targetIndex + 3] = alpha?.[pixelIndex] ?? 255;
    }
    return imageData;
  }

  async imageAlphaForXObject(dictionary, width, height) {
    const maskObject = this.pdf.objectFor(dictionary.SMask);
    if (!maskObject?.stream) {
      return null;
    }
    const mask = maskObject.value;
    const maskWidth = Number(this.pdf.resolve(mask.Width));
    const maskHeight = Number(this.pdf.resolve(mask.Height));
    const bits = Number(this.pdf.resolve(mask.BitsPerComponent));
    if (maskWidth !== width || maskHeight !== height || bits !== 8) {
      return null;
    }
    const filters = normalizeFilters(this.pdf.resolve(mask.Filter));
    if (!filters.every(isDataImageFilter)) {
      return null;
    }
    const pixels = applyImageDecodeParms(await this.pdf.decodeStream(maskObject.stream.bytes, mask), mask, width, height);
    const components = imageComponents(this.pdf.resolve(mask.ColorSpace), pixels.length, width, height);
    if (components !== 1 || pixels.length < width * height) {
      return null;
    }
    return pixels;
  }

  unsupported(operator) {
    this.unsupportedOperators.set(operator, (this.unsupportedOperators.get(operator) || 0) + 1);
  }

  pathMove(operands) {
    const [x, y] = this.point(operands[0], operands[1]);
    this.context.beginPath();
    this.context.moveTo(x, y);
    this.state.currentPoint = [Number(operands[0]) || 0, Number(operands[1]) || 0];
  }

  pathLine(operands) {
    const [x, y] = this.point(operands[0], operands[1]);
    this.context.lineTo(x, y);
    this.state.currentPoint = [Number(operands[0]) || 0, Number(operands[1]) || 0];
  }

  pathCurve(operands) {
    const [x1, y1] = this.point(operands[0], operands[1]);
    const [x2, y2] = this.point(operands[2], operands[3]);
    const [x3, y3] = this.point(operands[4], operands[5]);
    this.context.bezierCurveTo(x1, y1, x2, y2, x3, y3);
    this.state.currentPoint = [Number(operands[4]) || 0, Number(operands[5]) || 0];
  }

  pathCurveFromCurrent(operands) {
    const [x1, y1] = this.point(...(this.state.currentPoint || [0, 0]));
    const [x2, y2] = this.point(operands[0], operands[1]);
    const [x3, y3] = this.point(operands[2], operands[3]);
    this.context.bezierCurveTo(x1, y1, x2, y2, x3, y3);
    this.state.currentPoint = [Number(operands[2]) || 0, Number(operands[3]) || 0];
  }

  pathCurveToFinalPoint(operands) {
    const [x1, y1] = this.point(operands[0], operands[1]);
    const [x2, y2] = this.point(operands[2], operands[3]);
    this.context.bezierCurveTo(x1, y1, x2, y2, x2, y2);
    this.state.currentPoint = [Number(operands[2]) || 0, Number(operands[3]) || 0];
  }

  pathRect(operands) {
    const x = Number(operands[0]) || 0;
    const y = Number(operands[1]) || 0;
    const width = Number(operands[2]) || 0;
    const height = Number(operands[3]) || 0;
    const [x1, y1] = this.point(x, y);
    const [x2, y2] = this.point(x + width, y);
    const [x3, y3] = this.point(x + width, y + height);
    const [x4, y4] = this.point(x, y + height);
    this.context.beginPath();
    this.context.moveTo(x1, y1);
    this.context.lineTo(x2, y2);
    this.context.lineTo(x3, y3);
    this.context.lineTo(x4, y4);
    this.context.closePath();
    this.state.currentPoint = null;
  }

  point(x, y) {
    const point = transformPoint(this.state.ctm, Number(x) || 0, Number(y) || 0);
    return this.pagePoint(point[0], point[1]);
  }

  pagePoint(x, y) {
    const relativeX = x - this.originX;
    const relativeY = y - this.originY;
    if (this.rotation === 90) {
      return [relativeY * this.scale, relativeX * this.scale];
    }
    if (this.rotation === 180) {
      return [(this.pageBoxWidth - relativeX) * this.scale, relativeY * this.scale];
    }
    if (this.rotation === 270) {
      return [(this.pageBoxHeight - relativeY) * this.scale, (this.pageBoxWidth - relativeX) * this.scale];
    }
    return [relativeX * this.scale, (this.pageBoxHeight - relativeY) * this.scale];
  }

  pageVector(x, y) {
    if (this.rotation === 90) {
      return [y * this.scale, x * this.scale];
    }
    if (this.rotation === 180) {
      return [-x * this.scale, y * this.scale];
    }
    if (this.rotation === 270) {
      return [-y * this.scale, -x * this.scale];
    }
    return [x * this.scale, -y * this.scale];
  }

  clip(rule) {
    this.context.clip(rule);
  }

  stroke() {
    this.context.save();
    this.context.strokeStyle = this.state.stroke;
    this.context.globalAlpha = this.state.strokeAlpha;
    this.context.lineWidth = this.state.lineWidth * this.scale;
    this.context.miterLimit = this.state.miterLimit;
    this.context.lineCap = this.state.lineCap;
    this.context.lineJoin = this.state.lineJoin;
    this.context.setLineDash(this.state.lineDash.map((value) => value * this.scale));
    this.context.lineDashOffset = this.state.lineDashOffset * this.scale;
    this.context.stroke();
    this.context.restore();
    this.context.beginPath();
    this.state.currentPoint = null;
  }

  fill(rule = "nonzero") {
    this.context.save();
    this.context.fillStyle = this.state.fill;
    this.context.globalAlpha = this.state.fillAlpha;
    this.context.fill(rule);
    this.context.restore();
    this.context.beginPath();
    this.state.currentPoint = null;
  }
}

class PdfValueParser {
  constructor(source, position = 0) {
    this.source = source;
    this.position = position;
  }

  parseValue() {
    this.skipWhitespace();
    const char = this.source[this.position];
    if (char === "<" && this.source[this.position + 1] === "<") {
      return this.parseDictionary();
    }
    if (char === "[") {
      return this.parseArray();
    }
    if (char === "/") {
      return this.parseName();
    }
    if (char === "(") {
      return this.parseString();
    }
    if (char === "<") {
      return this.parseHexString();
    }
    return this.parseAtomOrReference();
  }

  parseDictionary() {
    const dictionary = {};
    this.position += 2;
    while (this.position < this.source.length) {
      this.skipWhitespace();
      if (this.source[this.position] === ">" && this.source[this.position + 1] === ">") {
        this.position += 2;
        break;
      }
      const key = this.parseName();
      dictionary[key] = this.parseValue();
    }
    return dictionary;
  }

  parseArray() {
    const array = [];
    this.position += 1;
    while (this.position < this.source.length) {
      this.skipWhitespace();
      if (this.source[this.position] === "]") {
        this.position += 1;
        break;
      }
      array.push(this.parseValue());
    }
    return array;
  }

  parseName() {
    this.position += 1;
    const start = this.position;
    while (this.position < this.source.length && !isPdfDelimiter(this.source.charCodeAt(this.position))) {
      this.position += 1;
    }
    return decodePdfName(this.source.slice(start, this.position));
  }

  parseString() {
    let depth = 1;
    let value = "";
    this.position += 1;
    while (this.position < this.source.length && depth > 0) {
      const char = this.source[this.position++];
      if (char === "\\") {
        value += this.parseStringEscape();
      } else if (char === "(") {
        depth += 1;
        value += char;
      } else if (char === ")") {
        depth -= 1;
        if (depth > 0) {
          value += char;
        }
      } else {
        value += char;
      }
    }
    return { string: value };
  }

  parseStringEscape() {
    const char = this.source[this.position++] || "";
    if (/[0-7]/.test(char)) {
      let octal = char;
      for (let count = 0; count < 2 && /[0-7]/.test(this.source[this.position] || ""); count += 1) {
        octal += this.source[this.position++];
      }
      return String.fromCharCode(parseInt(octal, 8) & 0xff);
    }
    if (char === "\r" && this.source[this.position] === "\n") {
      this.position += 1;
      return "";
    }
    if (char === "\n" || char === "\r") {
      return "";
    }
    return decodeEscape(char);
  }

  parseHexString() {
    this.position += 1;
    const start = this.position;
    const end = this.source.indexOf(">", start);
    this.position = end >= 0 ? end + 1 : this.source.length;
    return { hex: this.source.slice(start, end >= 0 ? end : this.source.length).replace(/\s+/g, "") };
  }

  parseAtomOrReference() {
    const first = this.readAtom();
    const firstNumber = Number(first);
    const checkpoint = this.position;
    this.skipWhitespace();
    const second = this.readAtom();
    const secondNumber = Number(second);
    const afterSecond = this.position;
    this.skipWhitespace();
    if (Number.isFinite(firstNumber) && Number.isFinite(secondNumber) && this.source[this.position] === "R") {
      this.position += 1;
      return { ref: firstNumber, generation: secondNumber };
    }
    this.position = checkpoint;
    if (first === "true") {
      return true;
    }
    if (first === "false") {
      return false;
    }
    if (first === "null") {
      return null;
    }
    if (Number.isFinite(firstNumber)) {
      return firstNumber;
    }
    this.position = afterSecond;
    return first;
  }

  readAtom() {
    this.skipWhitespace();
    const start = this.position;
    while (this.position < this.source.length && !isPdfDelimiter(this.source.charCodeAt(this.position))) {
      this.position += 1;
    }
    return this.source.slice(start, this.position);
  }

  skipWhitespace() {
    while (this.position < this.source.length) {
      const code = this.source.charCodeAt(this.position);
      if (WHITESPACE.has(code)) {
        this.position += 1;
      } else if (code === 37) {
        while (this.position < this.source.length && ![10, 13].includes(this.source.charCodeAt(this.position))) {
          this.position += 1;
        }
      } else {
        break;
      }
    }
  }
}

function parsePdfObject(raw) {
  const parser = new PdfValueParser(raw);
  return { value: parser.parseValue() };
}

function extractStream(source, bytes, objectStart, objectEnd, dictionary) {
  const streamIndex = source.indexOf("stream", objectStart);
  if (streamIndex < 0 || streamIndex > objectEnd || !dictionary || typeof dictionary !== "object") {
    return null;
  }
  let dataStart = streamIndex + 6;
  if (source[dataStart] === "\r" && source[dataStart + 1] === "\n") {
    dataStart += 2;
  } else if (source[dataStart] === "\n" || source[dataStart] === "\r") {
    dataStart += 1;
  }
  const declaredLength = Number(dictionary.Length);
  let dataEnd = Number.isFinite(declaredLength) && declaredLength > 0 ? dataStart + declaredLength : source.indexOf("endstream", dataStart);
  if (dataEnd < 0 || dataEnd > objectEnd) {
    return null;
  }
  if (!Number.isFinite(declaredLength) || declaredLength <= 0) {
    while (dataEnd > dataStart && [10, 13].includes(bytes[dataEnd - 1])) {
      dataEnd -= 1;
    }
  }
  return { bytes: bytes.slice(dataStart, dataEnd) };
}

function tokenizeContent(source) {
  const parser = new PdfValueParser(source);
  const tokens = [];
  while (parser.position < source.length) {
    parser.skipWhitespace();
    if (parser.position >= source.length) {
      break;
    }
    const char = source[parser.position];
    if (char === "/" || char === "[" || char === "(" || char === "<") {
      tokens.push({ type: "value", value: parser.parseValue() });
      continue;
    }
    const atom = parser.readAtom();
    const number = Number(atom);
    if (Number.isFinite(number)) {
      tokens.push({ type: "value", value: number });
    } else {
      tokens.push({ type: "operator", value: atom });
    }
  }
  return tokens;
}

async function inflate(bytes) {
  if (!window.DecompressionStream) {
    throw new Error("This browser does not expose DecompressionStream for FlateDecode");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeAsciiHex(bytes) {
  const source = bytesToBinaryString(bytes).replace(/\s+/g, "");
  const hex = source.replace(/>.*/, "");
  const padded = hex.length % 2 ? `${hex}0` : hex;
  const output = new Uint8Array(padded.length / 2);
  for (let index = 0; index < padded.length; index += 2) {
    output[index / 2] = parseInt(padded.slice(index, index + 2), 16) || 0;
  }
  return output;
}

function decodeAscii85(bytes) {
  const source = bytesToBinaryString(bytes).replace(/\s+/g, "").replace(/^<~/, "").replace(/~>$/, "");
  const output = [];
  let group = [];
  for (const char of source) {
    if (char === "z" && !group.length) {
      output.push(0, 0, 0, 0);
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 33 || code > 117) {
      continue;
    }
    group.push(code - 33);
    if (group.length === 5) {
      appendAscii85Group(output, group, 4);
      group = [];
    }
  }
  if (group.length) {
    const outputBytes = group.length - 1;
    while (group.length < 5) {
      group.push(84);
    }
    appendAscii85Group(output, group, outputBytes);
  }
  return new Uint8Array(output);
}

function appendAscii85Group(output, group, byteCount) {
  let value = 0;
  for (const digit of group) {
    value = value * 85 + digit;
  }
  output.push((value >>> 24) & 0xff);
  if (byteCount > 1) output.push((value >>> 16) & 0xff);
  if (byteCount > 2) output.push((value >>> 8) & 0xff);
  if (byteCount > 3) output.push(value & 0xff);
}

function decodeRunLength(bytes) {
  const output = [];
  for (let index = 0; index < bytes.length;) {
    const length = bytes[index++];
    if (length === 128) {
      break;
    }
    if (length <= 127) {
      const count = length + 1;
      output.push(...bytes.slice(index, index + count));
      index += count;
    } else {
      const count = 257 - length;
      const value = bytes[index++];
      for (let repeat = 0; repeat < count; repeat += 1) {
        output.push(value);
      }
    }
  }
  return new Uint8Array(output);
}

function bytesToBinaryString(bytes) {
  const chunks = [];
  for (let index = 0; index < bytes.length; index += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)));
  }
  return chunks.join("");
}

function isPdfDelimiter(code) {
  return WHITESPACE.has(code) || DELIMITERS.has(code);
}

function decodePdfName(name) {
  return name.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeEscape(char) {
  return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" })[char] || char;
}

function normalizeFilters(filter) {
  if (!filter) {
    return [];
  }
  return Array.isArray(filter) ? filter : [filter];
}

function isDataImageFilter(filter) {
  return ["FlateDecode", "Fl", "ASCIIHexDecode", "AHx", "ASCII85Decode", "A85", "RunLengthDecode", "RL"].includes(filter);
}

function recordFilter(filters, value) {
  for (const filter of normalizeFilters(value?.Filter)) {
    filters.set(filter, (filters.get(filter) || 0) + 1);
  }
}

function resolvePrimitive(pdf, value) {
  return pdf.resolve(value);
}

function numericArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "number") ? value : null;
}

function normalizeRotation(value) {
  const rotation = Number(value) || 0;
  return ((rotation % 360) + 360) % 360;
}

async function indexedColorPalette(pdf, colorSpace) {
  if (!isIndexedColorSpace(colorSpace)) {
    return null;
  }
  const baseColorSpace = pdf.resolve(colorSpace[1]);
  const highValue = Number(pdf.resolve(colorSpace[2]));
  const lookup = colorSpace[3];
  const componentCount = paletteComponentCount(baseColorSpace);
  if (!Number.isFinite(highValue) || componentCount < 1) {
    return null;
  }
  const lookupBytes = await lookupBytesFor(pdf, lookup);
  if (!lookupBytes.length) {
    return null;
  }
  const colors = [];
  for (let index = 0; index <= highValue; index += 1) {
    const offset = index * componentCount;
    const components = Array.from(lookupBytes.slice(offset, offset + componentCount));
    colors.push(rgbFromPaletteComponents(baseColorSpace, components));
  }
  return { colors };
}

function isIndexedColorSpace(colorSpace) {
  return Array.isArray(colorSpace) && ["Indexed", "I"].includes(colorSpace[0]);
}

function paletteComponentCount(colorSpace) {
  const name = Array.isArray(colorSpace) ? colorSpace[0] : colorSpace;
  if (name === "DeviceGray") {
    return 1;
  }
  if (name === "DeviceRGB") {
    return 3;
  }
  if (name === "DeviceCMYK") {
    return 4;
  }
  if (name === "ICCBased") {
    const components = Number(colorSpace?.[1]?.N);
    return [1, 3, 4].includes(components) ? components : 0;
  }
  return 0;
}

async function lookupBytesFor(pdf, lookup) {
  const resolved = pdf.resolve(lookup);
  if (resolved?.hex) {
    return hexStringToBytes(resolved.hex);
  }
  if (resolved?.string) {
    return new Uint8Array(textTokenToBytes(resolved));
  }
  const object = pdf.objectFor(lookup);
  if (object?.stream) {
    return pdf.decodeStream(object.stream.bytes, object.value);
  }
  return new Uint8Array();
}

function rgbFromPaletteComponents(colorSpace, components) {
  const name = Array.isArray(colorSpace) ? colorSpace[0] : colorSpace;
  if (name === "DeviceGray") {
    const gray = components[0] || 0;
    return [gray, gray, gray];
  }
  if (name === "DeviceCMYK") {
    return cmykToRgb(components[0] || 0, components[1] || 0, components[2] || 0, components[3] || 0);
  }
  return [components[0] || 0, components[1] || 0, components[2] || 0];
}

function unpackIndexedSamples(bytes, bits, width, height, decode) {
  const sampleCount = width * height;
  const output = new Uint8Array(sampleCount);
  if (bits === 8) {
    output.set(bytes.slice(0, sampleCount));
    return applyIndexedDecode(output, decode, bits);
  }
  if (![1, 2, 4].includes(bits)) {
    return output;
  }
  const mask = (1 << bits) - 1;
  let outputIndex = 0;
  for (const byte of bytes) {
    for (let shift = 8 - bits; shift >= 0 && outputIndex < sampleCount; shift -= bits) {
      output[outputIndex++] = (byte >> shift) & mask;
    }
  }
  return applyIndexedDecode(output, decode, bits);
}

function applyIndexedDecode(samples, decode, bits) {
  if (!Array.isArray(decode) || typeof decode[0] !== "number" || typeof decode[1] !== "number") {
    return samples;
  }
  const maxSample = (1 << bits) - 1;
  const low = decode[0];
  const high = decode[1];
  return samples.map((sample) => Math.round(low + (sample / maxSample) * (high - low)));
}

function imageComponents(colorSpace, byteLength, width, height) {
  const name = Array.isArray(colorSpace) ? colorSpace[0] : colorSpace;
  if (name === "DeviceGray") {
    return 1;
  }
  if (name === "DeviceRGB") {
    return 3;
  }
  if (name === "DeviceCMYK") {
    return 4;
  }
  if (name === "ICCBased") {
    const profile = colorSpace?.[1];
    const components = Number(profile?.N);
    if ([1, 3, 4].includes(components)) {
      return components;
    }
  }
  const inferred = byteLength / Math.max(1, width * height);
  return Number.isInteger(inferred) ? inferred : 0;
}

function cmykToRgb(cyanByte, magentaByte, yellowByte, blackByte) {
  const cyan = cyanByte / 255;
  const magenta = magentaByte / 255;
  const yellow = yellowByte / 255;
  const black = blackByte / 255;
  return [
    Math.round(255 * (1 - cyan) * (1 - black)),
    Math.round(255 * (1 - magenta) * (1 - black)),
    Math.round(255 * (1 - yellow) * (1 - black)),
  ];
}

function applyImageDecodeParms(bytes, dictionary, width, height) {
  const params = imageDecodeParms(dictionary);
  const predictor = Number(params?.Predictor) || 1;
  if (predictor <= 1) {
    return bytes;
  }
  const colors = Number(params.Colors) || imageComponents(dictionary.ColorSpace, bytes.length, width, height) || 1;
  const bits = Number(params.BitsPerComponent) || Number(dictionary.BitsPerComponent) || 8;
  const columns = Number(params.Columns) || width;
  if (bits !== 8 || colors < 1 || columns < 1) {
    return bytes;
  }
  if (predictor === 2) {
    return applyTiffPredictor(bytes, colors, columns, height);
  }
  if (predictor >= 10 && predictor <= 15) {
    return applyPngPredictor(bytes, colors, columns, height);
  }
  return bytes;
}

function imageDecodeParms(dictionary) {
  const params = dictionary.DecodeParms || dictionary.DP;
  return Array.isArray(params) ? params[0] : params;
}

function applyTiffPredictor(bytes, colors, columns, rows) {
  const rowLength = colors * columns;
  const output = new Uint8Array(bytes);
  for (let row = 0; row < rows; row += 1) {
    const rowStart = row * rowLength;
    for (let index = colors; index < rowLength; index += 1) {
      output[rowStart + index] = (output[rowStart + index] + output[rowStart + index - colors]) & 0xff;
    }
  }
  return output;
}

function applyPngPredictor(bytes, colors, columns, rows) {
  const rowLength = colors * columns;
  const output = new Uint8Array(rowLength * rows);
  let inputOffset = 0;
  let outputOffset = 0;
  for (let row = 0; row < rows && inputOffset < bytes.length; row += 1) {
    const filter = bytes[inputOffset++];
    for (let index = 0; index < rowLength && inputOffset < bytes.length; index += 1) {
      const raw = bytes[inputOffset++];
      const left = index >= colors ? output[outputOffset + index - colors] : 0;
      const up = row > 0 ? output[outputOffset + index - rowLength] : 0;
      const upperLeft = row > 0 && index >= colors ? output[outputOffset + index - rowLength - colors] : 0;
      output[outputOffset + index] = (raw + pngPredictorValue(filter, left, up, upperLeft)) & 0xff;
    }
    outputOffset += rowLength;
  }
  return output;
}

function pngPredictorValue(filter, left, up, upperLeft) {
  if (filter === 1) {
    return left;
  }
  if (filter === 2) {
    return up;
  }
  if (filter === 3) {
    return Math.floor((left + up) / 2);
  }
  if (filter === 4) {
    return paethPredictor(left, up, upperLeft);
  }
  return 0;
}

function paethPredictor(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function decodeImageComponents(bytes, sourceIndex, components, decode) {
  const values = [];
  for (let index = 0; index < components; index += 1) {
    const value = bytes[sourceIndex + index] || 0;
    values.push(decodeImageComponent(value, decode?.[index * 2], decode?.[index * 2 + 1]));
  }
  return values;
}

function decodeImageComponent(value, low, high) {
  if (typeof low !== "number" || typeof high !== "number") {
    return value;
  }
  return colorComponent(low + (value / 255) * (high - low));
}

function parseToUnicodeCMap(source) {
  const map = new Map();
  const bfcharPattern = /beginbfchar([\s\S]*?)endbfchar/g;
  let match;
  while ((match = bfcharPattern.exec(source))) {
    const pairs = Array.from(match[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g));
    for (const pair of pairs) {
      map.set(pair[1].toUpperCase(), hexToUnicode(pair[2]));
    }
  }
  const bfrangePattern = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((match = bfrangePattern.exec(source))) {
    const ranges = Array.from(match[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g));
    for (const range of ranges) {
      const start = parseInt(range[1], 16);
      const end = parseInt(range[2], 16);
      const target = hexToUnicode(range[3]);
      const width = range[1].length;
      for (let code = start; code <= end && code - start < 512; code += 1) {
        map.set(code.toString(16).toUpperCase().padStart(width, "0"), incrementUnicodeString(target, code - start));
      }
    }
    const arrayRanges = Array.from(match[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]+)\]/g));
    for (const range of arrayRanges) {
      const start = parseInt(range[1], 16);
      const end = parseInt(range[2], 16);
      const width = range[1].length;
      const targets = Array.from(range[3].matchAll(/<([0-9a-fA-F]+)>/g)).map((target) => target[1]);
      for (let offset = 0; offset < targets.length && start + offset <= end; offset += 1) {
        map.set((start + offset).toString(16).toUpperCase().padStart(width, "0"), hexToUnicode(targets[offset]));
      }
    }
  }
  return map;
}

function hexToUnicode(hex) {
  const chars = [];
  for (let index = 0; index < hex.length; index += 4) {
    chars.push(String.fromCharCode(parseInt(hex.slice(index, index + 4), 16)));
  }
  return chars.join("");
}

function incrementUnicodeString(text, offset) {
  if (!offset) {
    return text;
  }
  const chars = Array.from(text);
  const last = chars.pop() || "";
  const codePoint = last.codePointAt(0);
  if (!Number.isFinite(codePoint)) {
    return text;
  }
  return `${chars.join("")}${String.fromCodePoint(codePoint + offset)}`;
}

function textTokenToBytes(value) {
  if (value?.hex) {
    return Array.from(hexStringToBytes(value.hex));
  }
  if (value?.string) {
    return Array.from(value.string).map((char) => char.charCodeAt(0) & 0xff);
  }
  return [];
}

function hexStringToBytes(value) {
  const hex = value.length % 2 ? `${value}0` : value;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = parseInt(hex.slice(index, index + 2), 16) || 0;
  }
  return bytes;
}

function decodeWithCMap(bytes, cmap) {
  const hex = bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join("");
  const widths = Array.from(new Set(Array.from(cmap.keys()).map((key) => key.length))).sort((left, right) => right - left);
  let output = "";
  let index = 0;
  while (index < hex.length) {
    let matched = false;
    for (const width of widths) {
      const key = hex.slice(index, index + width);
      if (cmap.has(key)) {
        output += cmap.get(key);
        index += width;
        matched = true;
        break;
      }
    }
    if (!matched) {
      output += decodeWinAnsi([parseInt(hex.slice(index, index + 2), 16)]);
      index += 2;
    }
  }
  return output;
}

function decodeWinAnsi(bytes) {
  return bytes.map((byte) => WIN_ANSI.get(byte) || String.fromCharCode(byte)).join("");
}

function multiplyMatrix(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function transformPoint(matrix, x, y) {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

function colorFromOperands(operator, operands) {
  if (operator === "g" || operator === "G") {
    const value = Math.round((Number(operands[0]) || 0) * 255);
    return `rgb(${value}, ${value}, ${value})`;
  }
  const [red, green, blue] = operands.slice(-3).map((value) => Math.round((Number(value) || 0) * 255));
  return `rgb(${red}, ${green}, ${blue})`;
}

function colorFromColorSpace(colorSpace, operands) {
  const components = operands.filter((operand) => typeof operand === "number");
  const name = Array.isArray(colorSpace) ? colorSpace[0] : colorSpace;
  if (name === "DeviceGray" || components.length === 1) {
    const value = colorComponent(components[0]);
    return `rgb(${value}, ${value}, ${value})`;
  }
  if (name === "DeviceCMYK" || components.length >= 4) {
    const [cyan, magenta, yellow, black] = components.map((value) => clamp01(value));
    const red = colorComponent((1 - cyan) * (1 - black));
    const green = colorComponent((1 - magenta) * (1 - black));
    const blue = colorComponent((1 - yellow) * (1 - black));
    return `rgb(${red}, ${green}, ${blue})`;
  }
  const [red, green, blue] = components.slice(-3).map(colorComponent);
  return `rgb(${red || 0}, ${green || 0}, ${blue || 0})`;
}

function colorComponent(value) {
  return Math.round(clamp01(value) * 255);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function canvasFontFor(font, fontSize) {
  return `${fontStyleFor(font)} ${fontWeightFor(font)} ${fontSize}px ${fontFamilyFor(font)}`;
}

function fontStyleFor(font) {
  const base = normalizedFontName(font);
  return base.includes("italic") || base.includes("oblique") ? "italic" : "normal";
}

function fontWeightFor(font) {
  const base = normalizedFontName(font);
  if (base.includes("black") || base.includes("heavy")) {
    return "900";
  }
  if (base.includes("bold") || base.includes("semibold") || base.includes("demibold")) {
    return "700";
  }
  return "400";
}

function fontFamilyFor(font) {
  const base = normalizedFontName(font);
  if (base.includes("courier") || base.includes("mono")) {
    return "ui-monospace, monospace";
  }
  if (base.includes("times") || base.includes("serif")) {
    return "Times New Roman, serif";
  }
  return "Arial, sans-serif";
}

function normalizedFontName(font) {
  const base = String(font?.baseFont || "").toLowerCase();
  return base.replace(/^[a-z]{6}\+/, "").replace(/[,_-]/g, "");
}