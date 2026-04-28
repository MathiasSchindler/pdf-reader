const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const WIN_ANSI = new Map([
  [0x80, "€"], [0x82, "‚"], [0x83, "ƒ"], [0x84, "„"], [0x85, "…"], [0x86, "†"], [0x87, "‡"],
  [0x88, "ˆ"], [0x89, "‰"], [0x8a, "Š"], [0x8b, "‹"], [0x8c, "Œ"], [0x8e, "Ž"], [0x91, "‘"],
  [0x92, "’"], [0x93, "“"], [0x94, "”"], [0x95, "•"], [0x96, "–"], [0x97, "—"], [0x98, "˜"],
  [0x99, "™"], [0x9a, "š"], [0x9b, "›"], [0x9c, "œ"], [0x9e, "ž"], [0x9f, "Ÿ"]
]);

const ENABLE_DIAGNOSTICS = typeof PDF_LITE_DIAGNOSTICS === "boolean" ? PDF_LITE_DIAGNOSTICS : true;
const ENABLE_EXPERIMENTAL_OUTLINES = typeof PDF_LITE_EXPERIMENTAL_OUTLINES === "boolean" ? PDF_LITE_EXPERIMENTAL_OUTLINES : true;
const ENABLE_IMAGES = typeof PDF_LITE_IMAGES === "boolean" ? PDF_LITE_IMAGES : true;

// --- Defensive limits -------------------------------------------------------
// Generous caps that real PDFs never approach but that keep pathological or
// adversarial inputs bounded. These turn would-be hangs and runaway
// allocations into fast, deterministic errors.
const MAX_OBJECTS = 200_000;
const MAX_PAGES = 10_000;
const MAX_PAGE_DEPTH = 64;
const MAX_PAGE_KIDS = 8192;
const MAX_PAGE_DIMENSION_PX = 16384; // upper bound on canvas width/height
const MAX_CONTENT_STREAM_BYTES = 64 * 1024 * 1024; // combined per page

export async function loadPdfLite(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const pdf = new PdfLiteDocument(bytes, url);
  await pdf.parse();
  // Reject obviously broken files that parsed to nothing useful. These are
  // structural minimums; any real PDF clears them trivially. Rejecting here
  // gives callers a clear error instead of an empty 0-page document.
  if (!pdf.source.includes("%PDF-")) {
    throw new Error("Invalid PDF: missing %PDF- header.");
  }
  if (pdf.objects.size === 0) {
    throw new Error("Invalid PDF: no objects could be parsed.");
  }
  if (pdf.pages.length === 0) {
    throw new Error("Invalid PDF: no pages found.");
  }
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
    if (!ENABLE_DIAGNOSTICS) {
      return {
        url: this.url,
        version: this.source.match(/%PDF-([^\r\n]+)/)?.[1] || "unknown",
        pages: this.pages.length,
      };
    }
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
        hasEmbeddedFont: font.hasEmbeddedFont,
        embeddedFontFormat: font.embeddedFontFormat,
        embeddedFontLoaded: font.embeddedFontLoaded,
        embeddedFontError: font.embeddedFontError,
        embeddedOutlineLoaded: font.embeddedOutlineLoaded,
        embeddedOutlineUsable: font.embeddedOutlineUsable,
        embeddedOutlineExperimental: font.embeddedOutlineExperimental,
        hasToUnicode: Boolean(font.toUnicode),
        cmapEntries: font.toUnicode?.size || 0,
        hasWidths: font.widths.size > 0,
        defaultWidth: font.defaultWidth,
      })),
      images: this.imageAudit(),
      warnings: this.warnings,
    };
  }

  imageAudit() {
    if (!ENABLE_DIAGNOSTICS) {
      return [];
    }
    return Array.from(this.objects.values())
      .filter((object) => object.value?.Subtype === "Image")
      .map((object) => ({
        object: object.id,
        width: this.resolve(object.value.Width),
        height: this.resolve(object.value.Height),
        bitsPerComponent: this.resolve(object.value.BitsPerComponent),
        filters: normalizeFilters(this.resolve(object.value.Filter)),
        colorSpace: colorSpaceLabel(this.resolveColorSpace(object.value.ColorSpace)),
        hasMask: Boolean(object.value.Mask),
        hasSoftMask: Boolean(object.value.SMask),
        imageMask: Boolean(object.value.ImageMask),
      }));
  }

  resolveColorSpace(value) {
    const colorSpace = this.resolve(value);
    if (Array.isArray(colorSpace)) {
      return colorSpace.map((part, index) => index === 0 ? part : this.resolve(part));
    }
    return colorSpace;
  }

  async renderPage(index, canvas, options = {}) {
    const page = this.pages[index];
    if (!page) {
      throw new Error(`Page ${index + 1} not found`);
    }
    const scale = options.scale || 1;
    const mediaBox = page.mediaBox || [0, 0, 595, 842];
    const pageBox = page.cropBox || mediaBox;
    const rawWidth = Math.abs(pageBox[2] - pageBox[0]);
    const rawHeight = Math.abs(pageBox[3] - pageBox[1]);
    // Reject pathologically tiny or NaN boxes; clamp huge ones so we never
    // attempt a multi-gigapixel canvas allocation.
    const safeWidth = clampDimension(rawWidth, 595);
    const safeHeight = clampDimension(rawHeight, 842);
    const rotation = normalizeRotation(page.rotate);
    const boxWidth = safeWidth;
    const boxHeight = safeHeight;
    const width = rotation === 90 || rotation === 270 ? boxHeight : boxWidth;
    const height = rotation === 90 || rotation === 270 ? boxWidth : boxHeight;
    const pixelRatio = window.devicePixelRatio || 1;
    const pixelWidth = Math.min(MAX_PAGE_DIMENSION_PX, Math.max(1, Math.floor(width * scale * pixelRatio)));
    const pixelHeight = Math.min(MAX_PAGE_DIMENSION_PX, Math.max(1, Math.floor(height * scale * pixelRatio)));
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    canvas.style.width = `${Math.floor(width * scale)}px`;
    canvas.style.height = `${Math.floor(height * scale)}px`;
    const context = canvas.getContext("2d");
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width * scale, height * scale);
    const renderer = new ContentRenderer(this, page, context, { scale, width, height, boxWidth, boxHeight, rotation, originX: pageBox[0], originY: pageBox[1], fontMode: options.fontMode || "stable" });
    const streams = await this.getPageContentStreams(page);
    let totalBytes = 0;
    const safeStreams = [];
    for (const stream of streams) {
      totalBytes += stream.length;
      if (totalBytes > MAX_CONTENT_STREAM_BYTES) {
        if (ENABLE_DIAGNOSTICS) this.warnings.push(`Content stream truncated at ${MAX_CONTENT_STREAM_BYTES} bytes for page ${index + 1}.`);
        break;
      }
      safeStreams.push(stream);
    }
    await renderer.interpret(safeStreams.map((stream) => bytesToBinaryString(stream)).join("\n"));
    return { unsupportedOperators: ENABLE_DIAGNOSTICS ? renderer.unsupportedOperators : new Map() };
  }

  readDirectObjects() {
    const objectPattern = /(\d+)\s+(\d+)\s+obj\b/g;
    let match;
    while ((match = objectPattern.exec(this.source))) {
      if (this.objects.size >= MAX_OBJECTS) {
        if (ENABLE_DIAGNOSTICS) this.warnings.push(`Object limit reached (${MAX_OBJECTS}); ignoring remaining objects.`);
        break;
      }
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
        if (ENABLE_DIAGNOSTICS) {
          this.warnings.push(`Could not decode object stream ${object.id}: ${error.message}`);
        }
      }
    }
  }

  collectPages() {
    const catalog = Array.from(this.objects.values()).find((object) => object.value?.Type === "Catalog")?.value;
    const pagesRoot = this.resolve(catalog?.Pages);
    this.pages = [];
    this.walkPages(pagesRoot, {}, 0, new Set());
  }

  walkPages(node, inherited, depth = 0, visited = new Set()) {
    if (!node) {
      return;
    }
    if (depth > MAX_PAGE_DEPTH) {
      if (ENABLE_DIAGNOSTICS) this.warnings.push(`Page tree depth limit (${MAX_PAGE_DEPTH}) reached.`);
      return;
    }
    if (this.pages.length >= MAX_PAGES) {
      return;
    }
    if (typeof node === "object" && node !== null) {
      if (visited.has(node)) {
        if (ENABLE_DIAGNOSTICS) this.warnings.push("Cycle detected in page tree; bailing out of branch.");
        return;
      }
      visited.add(node);
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
    const limit = Math.min(kids.length, MAX_PAGE_KIDS);
    if (kids.length > MAX_PAGE_KIDS && ENABLE_DIAGNOSTICS) {
      this.warnings.push(`Page kids array truncated from ${kids.length} to ${MAX_PAGE_KIDS}.`);
    }
    for (let index = 0; index < limit; index += 1) {
      if (this.pages.length >= MAX_PAGES) break;
      this.walkPages(this.resolve(kids[index]), nextInherited, depth + 1, visited);
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
              if (ENABLE_DIAGNOSTICS) {
                this.warnings.push(`Could not decode ToUnicode map for ${resourceName}: ${error.message}`);
              }
            }
          }
        }
        const descendantFont = Array.isArray(font.DescendantFonts) ? this.resolve(font.DescendantFonts[0]) : null;
        const descriptor = this.resolve(font.FontDescriptor) || this.resolve(descendantFont?.FontDescriptor) || null;
        const embeddedFont = await this.loadEmbeddedFont(resourceName, font, descendantFont, descriptor);
        const metrics = buildFontMetrics(font, descendantFont, toUnicode);
        await installEmbeddedBrowserFont(embeddedFont, metrics, toUnicode);
        const embeddedOutlineUsable = Boolean(embeddedFont?.outlineFont && embeddedFont.outlineFont.kind !== "cff" && !metrics.isCidFont && toUnicode?.size);
        const embeddedOutlineExperimental = Boolean(ENABLE_EXPERIMENTAL_OUTLINES && embeddedFont?.outlineFont?.kind === "cff" && !metrics.isCidFont && toUnicode?.size);
        this.fonts.set(objectId, {
          objectId,
          resourceName,
          subtype: font.Subtype || "unknown",
          baseFont: font.BaseFont || "unknown",
          hasEmbeddedFont: Boolean(embeddedFont),
          embeddedFontFamily: embeddedFont?.family || null,
          embeddedFontFormat: embeddedFont?.format || null,
          embeddedFontLoaded: Boolean(embeddedFont?.loaded),
          embeddedFontError: embeddedFont?.error || null,
          embeddedOutlineFont: embeddedFont?.outlineFont || null,
          embeddedOutlineLoaded: Boolean(embeddedFont?.outlineFont),
          embeddedOutlineUsable,
          embeddedOutlineExperimental,
          toUnicode,
          widths: metrics.widths,
          defaultWidth: metrics.defaultWidth,
          hasExplicitDefaultWidth: metrics.hasExplicitDefaultWidth,
          codeByteWidths: metrics.codeByteWidths,
          codeToGlyphName: metrics.codeToGlyphName,
          isCidFont: metrics.isCidFont,
        });
      }
    }
  }

  async loadEmbeddedFont(resourceName, font, descendantFont, descriptor) {
    const entry = embeddedFontEntry(descriptor);
    if (!entry) {
      return null;
    }
    const object = this.objectFor(entry.ref);
    if (!object?.stream) {
      return null;
    }
    const format = entry.format === "fontfile3" ? object.value.Subtype || entry.format : entry.format;
    const family = `PdfLite-${resourceName}-${object.id}`;
    const embedded = { family, format, loaded: false, error: null, outlineFont: null, bytes: null };
    let bytes;
    try {
      bytes = await this.decodeStream(object.stream.bytes, object.value);
      embedded.bytes = bytes;
      if (format === "truetype") {
        embedded.outlineFont = parseTrueTypeFont(bytes);
      } else if (format === "Type1C") {
        embedded.outlineFont = parseCffFont(bytes);
        embedded.error = "Type1C/CFF outlines are parsed for diagnostics but not painted yet";
      }
    } catch (error) {
      embedded.error = error.message;
      return embedded;
    }
    embedded.error ||= embedded.outlineFont?.browserInstallableError || null;
    return embedded;
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
    this.fontMode = metrics.fontMode || "stable";
    this.stack = [];
    this.state = this.defaultState();
    this.unsupportedOperators = ENABLE_DIAGNOSTICS ? new Map() : null;
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
      currentSubpathStart: null,
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
        this.state.currentPoint = this.state.currentSubpathStart;
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
        this.state.currentSubpathStart = null;
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
    const glyphs = this.decodeGlyphRun(value);
    const text = glyphs.map((glyph) => glyph.text).join("");
    if (!text) {
      return;
    }
    const font = this.currentFont();
    const textMatrix = multiplyMatrix(this.state.ctm, this.state.textMatrix);
    const textYScale = Math.hypot(textMatrix[2], textMatrix[3]) || Math.hypot(textMatrix[0], textMatrix[1]) || 1;
    const fontSize = Math.abs(this.state.fontSize * textYScale * this.scale) || 1;
    this.context.save();
    this.context.fillStyle = this.state.fill;
    this.context.globalAlpha = this.state.fillAlpha;
    this.context.strokeStyle = this.state.stroke;
    this.context.lineWidth = this.state.lineWidth * this.scale;
    this.context.lineCap = this.state.lineCap;
    this.context.lineJoin = this.state.lineJoin;
    this.context.font = canvasFontFor(font, fontSize);
    const [originX, originY] = transformPoint(textMatrix, 0, this.state.textRise);
    const [canvasX, canvasY] = this.pagePoint(originX, originY);
    const [textXAxisX, textXAxisY] = this.pageVector(textMatrix[0], textMatrix[1]);
    const [textYAxisX, textYAxisY] = this.pageVector(textMatrix[2], textMatrix[3]);
    const unitScale = Math.hypot(textYAxisX, textYAxisY) || Math.hypot(textXAxisX, textXAxisY) || this.scale || 1;
    this.context.translate(canvasX, canvasY);
    this.context.transform(textXAxisX / unitScale, textXAxisY / unitScale, -textYAxisX / unitScale, -textYAxisY / unitScale, 0, 0);
    this.context.scale(this.state.horizontalScale, 1);
    let advance;
    let advanceIncludesSpacing = false;
    if (glyphs.some((glyph) => Number.isFinite(glyph.width))) {
      advance = this.paintGlyphRun(glyphs, unitScale, fontSize);
      advanceIncludesSpacing = true;
    } else {
      this.paintText(text, 0, 0);
      advance = this.context.measureText(text).width / unitScale;
    }
    this.context.restore();
    this.advanceText(advanceIncludesSpacing ? advance * this.state.horizontalScale : this.textAdvance(text, advance));
  }

  paintGlyphRun(glyphs, unitScale, fontSize) {
    const font = this.currentFont();
    let x = 0;
    for (const glyph of glyphs) {
      if (glyph.text) {
        if (!this.paintEmbeddedGlyph(font, glyph, x * unitScale, fontSize)) {
          this.paintText(glyph.text, x * unitScale, 0);
        }
      }
      x += this.glyphAdvance(glyph, unitScale) + this.spacingAdvance(glyph.text);
    }
    return x;
  }

  paintEmbeddedGlyph(font, glyph, x, fontSize) {
    const outlineFont = font?.embeddedOutlineFont;
    if (!outlineFont || !this.canPaintEmbeddedGlyph(font, outlineFont) || !Number.isFinite(glyph.code)) {
      return false;
    }
    const outline = glyphOutlineForGlyph(outlineFont, glyph);
    if (!outline) {
      return false;
    }
    const scale = fontSize / outlineFont.unitsPerEm;
    const mode = this.state.textRenderingMode;
    const paintMode = mode >= 4 ? mode - 4 : mode;
    if (mode >= 4) {
      this.unsupported("Tr/TextClip");
    }
    this.context.beginPath();
    appendGlyphPath(this.context, outline, x, scale, fontSize, outlineFont);
    if (paintMode === 0 || paintMode === 2) {
      this.context.fill();
    }
    if (paintMode === 1 || paintMode === 2) {
      const previousAlpha = this.context.globalAlpha;
      this.context.globalAlpha = this.state.strokeAlpha;
      this.context.stroke();
      this.context.globalAlpha = previousAlpha;
    }
    return true;
  }

  canPaintEmbeddedGlyph(font, outlineFont) {
    if (ENABLE_EXPERIMENTAL_OUTLINES && this.fontMode === "embedded") {
      return Boolean(!font.isCidFont && font.toUnicode?.size && outlineFont.kind !== "truetype-cid");
    }
    return Boolean(font.embeddedOutlineUsable);
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
    return (measuredWidth + this.spacingAdvance(text)) * this.state.horizontalScale;
  }

  spacingAdvance(text) {
    const chars = Array.from(text);
    const spaces = chars.filter((char) => char === " ").length;
    return chars.length * this.state.charSpacing + spaces * this.state.wordSpacing;
  }

  glyphAdvance(glyph, unitScale) {
    if (Number.isFinite(glyph.width)) {
      return (glyph.width / 1000) * this.state.fontSize;
    }
    return this.context.measureText(glyph.text).width / unitScale;
  }

  advanceText(amount) {
    this.state.textMatrix = multiplyMatrix(this.state.textMatrix, [1, 0, 0, 1, amount, 0]);
  }

  decodeText(value) {
    return this.decodeGlyphRun(value).map((glyph) => glyph.text).join("");
  }

  decodeGlyphRun(value) {
    return decodeGlyphRun(textTokenToBytes(value), this.currentFont());
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
      if (!ENABLE_IMAGES) {
        this.unsupported("Do/ImageDisabled");
        return;
      }
      await paintImageXObject(this, object);
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

  unsupported(operator) {
    if (!ENABLE_DIAGNOSTICS) {
      return;
    }
    this.unsupportedOperators.set(operator, (this.unsupportedOperators.get(operator) || 0) + 1);
  }

  pathMove(operands) {
    const [x, y] = this.point(operands[0], operands[1]);
    this.context.moveTo(x, y);
    const point = [Number(operands[0]) || 0, Number(operands[1]) || 0];
    this.state.currentPoint = point;
    this.state.currentSubpathStart = point;
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
    this.state.currentSubpathStart = null;
  }

  fill(rule = "nonzero") {
    this.context.save();
    this.context.fillStyle = this.state.fill;
    this.context.globalAlpha = this.state.fillAlpha;
    this.context.fill(rule);
    this.context.restore();
    this.context.beginPath();
    this.state.currentPoint = null;
    this.state.currentSubpathStart = null;
  }
}

async function paintImageXObject(renderer, object) {
  const filters = normalizeFilters(renderer.pdf.resolve(object.value.Filter));
  try {
    if (filters.length === 1 && ["DCTDecode", "DCT"].includes(filters[0])) {
      const image = await createImageBitmap(new Blob([object.stream.bytes], { type: "image/jpeg" }));
      drawUnitImage(renderer, image);
      image.close?.();
      return;
    }
    if (filters.every(isDataImageFilter)) {
      const imageData = await imageDataForXObject(renderer, object);
      if (imageData) {
        const image = await createImageBitmap(imageData);
        drawUnitImage(renderer, image, { smoothing: !isIndexedColorSpace(renderer.pdf.resolve(object.value.ColorSpace)) });
        image.close?.();
        return;
      }
    }
    renderer.unsupported(`Do/Image/${filters.join("+") || "raw"}`);
  } catch (error) {
    renderer.unsupported("Do/ImageDecode");
  }
}

function drawUnitImage(renderer, image, options = {}) {
  const [a, b, c, d, e, f] = renderer.state.ctm;
  const [canvasX, canvasY] = renderer.pagePoint(e, f);
  const [xA, xB] = renderer.pageVector(a, b);
  const [yA, yB] = renderer.pageVector(c, d);
  renderer.context.save();
  renderer.context.imageSmoothingEnabled = options.smoothing !== false;
  renderer.context.transform(xA, xB, yA, yB, canvasX, canvasY);
  renderer.context.transform(1, 0, 0, -1, 0, 1);
  renderer.context.drawImage(image, 0, 0, 1, 1);
  renderer.context.restore();
}

async function imageDataForXObject(renderer, object) {
  const dictionary = object.value;
  const width = Number(renderer.pdf.resolve(dictionary.Width));
  const height = Number(renderer.pdf.resolve(dictionary.Height));
  const bits = Number(renderer.pdf.resolve(dictionary.BitsPerComponent));
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(bits)) {
    return null;
  }
  const colorSpace = renderer.pdf.resolve(dictionary.ColorSpace);
  const palette = await indexedColorPalette(renderer.pdf, colorSpace);
  if (palette) {
    const pixels = unpackIndexedSamples(applyImageDecodeParms(await renderer.pdf.decodeStream(object.stream.bytes, dictionary), dictionary, width, height), bits, width, height, dictionary.Decode);
    const alpha = await imageAlphaForXObject(renderer, dictionary, width, height);
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
  const pixels = applyImageDecodeParms(await renderer.pdf.decodeStream(object.stream.bytes, dictionary), dictionary, width, height);
  const components = imageComponents(colorSpace, pixels.length, width, height);
  if (![1, 3, 4].includes(components)) {
    return null;
  }
  const expectedLength = width * height * components;
  if (pixels.length < expectedLength) {
    return null;
  }
  const alpha = await imageAlphaForXObject(renderer, dictionary, width, height);
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

async function imageAlphaForXObject(renderer, dictionary, width, height) {
  const maskObject = renderer.pdf.objectFor(dictionary.SMask);
  if (!maskObject?.stream) {
    return null;
  }
  const mask = maskObject.value;
  const maskWidth = Number(renderer.pdf.resolve(mask.Width));
  const maskHeight = Number(renderer.pdf.resolve(mask.Height));
  const bits = Number(renderer.pdf.resolve(mask.BitsPerComponent));
  if (maskWidth !== width || maskHeight !== height || bits !== 8) {
    return null;
  }
  const filters = normalizeFilters(renderer.pdf.resolve(mask.Filter));
  if (!filters.every(isDataImageFilter)) {
    return null;
  }
  const pixels = applyImageDecodeParms(await renderer.pdf.decodeStream(maskObject.stream.bytes, mask), mask, width, height);
  const components = imageComponents(renderer.pdf.resolve(mask.ColorSpace), pixels.length, width, height);
  if (components !== 1 || pixels.length < width * height) {
    return null;
  }
  return pixels;
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
    if (!Number.isFinite(firstNumber)) {
      if (first === "true") {
        return true;
      }
      if (first === "false") {
        return false;
      }
      if (first === "null") {
        return null;
      }
      return first;
    }
    const checkpoint = this.position;
    this.skipWhitespace();
    const second = this.readAtom();
    const secondNumber = Number(second);
    this.skipWhitespace();
    if (Number.isFinite(firstNumber) && Number.isFinite(secondNumber) && this.source[this.position] === "R") {
      this.position += 1;
      return { ref: firstNumber, generation: secondNumber };
    }
    this.position = checkpoint;
    return firstNumber;
  }

  readAtom() {
    this.skipWhitespace();
    const start = this.position;
    while (this.position < this.source.length && !isPdfDelimiter(this.source.charCodeAt(this.position))) {
      this.position += 1;
    }
    if (this.position === start && this.position < this.source.length) {
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
  const declaredLength = streamLength(source, dictionary.Length);
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

function streamLength(source, value) {
  if (typeof value === "number") {
    return value;
  }
  if (!value?.ref) {
    return Number(value);
  }
  const pattern = new RegExp(`\\b${value.ref}\\s+${value.generation || 0}\\s+obj\\s+([+-]?(?:\\d+\\.?\\d*|\\.\\d+))\\s+endobj\\b`);
  const match = source.match(pattern);
  return match ? Number(match[1]) : NaN;
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

function buildFontMetrics(font, descendantFont, toUnicode) {
  const isCidFont = font.Subtype === "Type0" || Boolean(descendantFont);
  const widths = isCidFont ? cidWidthMap(descendantFont?.W) : simpleWidthMap(font.FirstChar, font.Widths);
  const explicitDefaultWidth = Number(isCidFont ? descendantFont?.DW : font.MissingWidth);
  return {
    widths,
    defaultWidth: Number.isFinite(explicitDefaultWidth) ? explicitDefaultWidth : isCidFont ? 1000 : 500,
    hasExplicitDefaultWidth: Number.isFinite(explicitDefaultWidth),
    codeByteWidths: fontCodeByteWidths(toUnicode, isCidFont),
    codeToGlyphName: isCidFont ? new Map() : fontEncodingMap(font.Encoding),
    isCidFont,
  };
}

function simpleWidthMap(firstChar, widths) {
  const map = new Map();
  if (!Array.isArray(widths)) {
    return map;
  }
  const first = Number(firstChar) || 0;
  widths.forEach((width, index) => {
    if (Number.isFinite(width)) {
      map.set(first + index, width);
    }
  });
  return map;
}

function cidWidthMap(widths) {
  const map = new Map();
  if (!Array.isArray(widths)) {
    return map;
  }
  for (let index = 0; index < widths.length;) {
    const first = Number(widths[index++]);
    const next = widths[index++];
    if (!Number.isFinite(first)) {
      continue;
    }
    if (Array.isArray(next)) {
      next.forEach((width, offset) => {
        if (Number.isFinite(width)) {
          map.set(first + offset, width);
        }
      });
      continue;
    }
    const last = Number(next);
    const width = Number(widths[index++]);
    if (!Number.isFinite(last) || !Number.isFinite(width)) {
      continue;
    }
    for (let code = first; code <= last; code += 1) {
      map.set(code, width);
    }
  }
  return map;
}

function fontEncodingMap(encoding) {
  const map = new Map();
  for (let code = 0; code < 256; code += 1) {
    const name = standardGlyphName(code);
    if (name) {
      map.set(code, name);
    }
  }
  if (encoding && typeof encoding === "object" && Array.isArray(encoding.Differences)) {
    let code = 0;
    for (const item of encoding.Differences) {
      if (typeof item === "number") {
        code = item;
      } else if (typeof item === "string") {
        map.set(code, item);
        code += 1;
      }
    }
  }
  return map;
}

function standardGlyphName(code) {
  if (code >= 65 && code <= 90) return String.fromCharCode(code);
  if (code >= 97 && code <= 122) return String.fromCharCode(code);
  if (code >= 48 && code <= 57) return ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][code - 48];
  return MAC_ROMAN_GLYPH_NAMES[code] || null;
}

const MAC_ROMAN_GLYPH_NAMES = {
  32: "space", 33: "exclam", 34: "quotedbl", 35: "numbersign", 36: "dollar", 37: "percent", 38: "ampersand", 39: "quotesingle",
  40: "parenleft", 41: "parenright", 42: "asterisk", 43: "plus", 44: "comma", 45: "hyphen", 46: "period", 47: "slash",
  58: "colon", 59: "semicolon", 60: "less", 61: "equal", 62: "greater", 63: "question", 64: "at", 91: "bracketleft", 92: "backslash", 93: "bracketright", 94: "asciicircum", 95: "underscore", 96: "grave", 123: "braceleft", 124: "bar", 125: "braceright", 126: "asciitilde",
  128: "Adieresis", 129: "Aring", 130: "Ccedilla", 131: "Eacute", 132: "Ntilde", 133: "Odieresis", 134: "Udieresis", 135: "aacute", 136: "agrave", 137: "acircumflex", 138: "adieresis", 139: "atilde", 140: "aring", 141: "ccedilla", 142: "eacute", 143: "egrave", 144: "ecircumflex", 145: "edieresis", 146: "iacute", 147: "igrave", 148: "icircumflex", 149: "idieresis", 150: "ntilde", 151: "oacute", 152: "ograve", 153: "ocircumflex", 154: "odieresis", 155: "otilde", 156: "uacute", 157: "ugrave", 158: "ucircumflex", 159: "udieresis",
  160: "dagger", 161: "degree", 162: "cent", 163: "sterling", 164: "section", 165: "bullet", 166: "paragraph", 167: "germandbls", 168: "registered", 169: "copyright", 170: "trademark", 171: "acute", 172: "dieresis", 173: "notequal", 174: "AE", 175: "Oslash", 176: "infinity", 177: "plusminus", 178: "lessequal", 179: "greaterequal", 180: "yen", 181: "mu", 182: "partialdiff", 183: "summation", 184: "product", 185: "pi", 186: "integral", 187: "ordfeminine", 188: "ordmasculine", 189: "Omega", 190: "ae", 191: "oslash",
  192: "questiondown", 193: "exclamdown", 194: "logicalnot", 195: "radical", 196: "florin", 197: "approxequal", 198: "Delta", 199: "guillemotleft", 200: "guillemotright", 201: "ellipsis", 202: "space", 203: "Agrave", 204: "Atilde", 205: "Otilde", 206: "OE", 207: "oe", 208: "endash", 209: "emdash", 210: "quotedblleft", 211: "quotedblright", 212: "quoteleft", 213: "quoteright", 214: "divide", 215: "lozenge", 216: "ydieresis", 217: "Ydieresis", 218: "fraction", 219: "currency", 220: "guilsinglleft", 221: "guilsinglright", 222: "fi", 223: "fl",
  224: "daggerdbl", 225: "periodcentered", 226: "quotesinglbase", 227: "quotedblbase", 228: "perthousand", 229: "Acircumflex", 230: "Ecircumflex", 231: "Aacute", 232: "Edieresis", 233: "Egrave", 234: "Iacute", 235: "Icircumflex", 236: "Idieresis", 237: "Igrave", 238: "Oacute", 239: "Ocircumflex", 240: "apple", 241: "Ograve", 242: "Uacute", 243: "Ucircumflex", 244: "Ugrave", 245: "dotlessi", 246: "circumflex", 247: "tilde", 248: "macron", 249: "breve", 250: "dotaccent", 251: "ring", 252: "cedilla", 253: "hungarumlaut", 254: "ogonek", 255: "caron",
};

const CFF_STANDARD_STRINGS = [
  ".notdef", "space", "exclam", "quotedbl", "numbersign", "dollar", "percent", "ampersand", "quoteright", "parenleft", "parenright", "asterisk", "plus", "comma", "hyphen", "period", "slash",
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "colon", "semicolon", "less", "equal", "greater", "question", "at",
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
  "bracketleft", "backslash", "bracketright", "asciicircum", "underscore", "quoteleft",
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
  "braceleft", "bar", "braceright", "asciitilde", "exclamdown", "cent", "sterling", "fraction", "yen", "florin", "section", "currency", "quotesingle", "quotedblleft", "guillemotleft", "guilsinglleft", "guilsinglright", "fi", "fl", "endash", "dagger", "daggerdbl", "periodcentered", "paragraph", "bullet", "quotesinglbase", "quotedblbase", "quotedblright", "guillemotright", "ellipsis", "perthousand", "questiondown", "grave", "acute", "circumflex", "tilde", "macron", "breve", "dotaccent", "dieresis", "ring", "cedilla", "hungarumlaut", "ogonek", "caron", "emdash",
  "AE", "ordfeminine", "Lslash", "Oslash", "OE", "ordmasculine", "ae", "dotlessi", "lslash", "oslash", "oe", "germandbls", "onesuperior", "logicalnot", "mu", "trademark", "Eth", "onehalf", "plusminus", "Thorn", "onequarter", "divide", "brokenbar", "degree", "thorn", "threequarters", "twosuperior", "registered", "minus", "eth", "multiply", "threesuperior", "copyright", "Aacute", "Acircumflex", "Adieresis", "Agrave", "Aring", "Atilde", "Ccedilla", "Eacute", "Ecircumflex", "Edieresis", "Egrave", "Iacute", "Icircumflex", "Idieresis", "Igrave", "Ntilde", "Oacute", "Ocircumflex", "Odieresis", "Ograve", "Otilde", "Scaron", "Uacute", "Ucircumflex", "Udieresis", "Ugrave", "Yacute", "Ydieresis", "Zcaron", "aacute", "acircumflex", "adieresis", "agrave", "aring", "atilde", "ccedilla", "eacute", "ecircumflex", "edieresis", "egrave", "iacute", "icircumflex", "idieresis", "igrave", "ntilde", "oacute", "ocircumflex", "odieresis", "ograve", "otilde", "scaron", "uacute", "ucircumflex", "udieresis", "ugrave", "yacute", "ydieresis", "zcaron"
];

const CFF_ISO_ADOBE_CHARSET = CFF_STANDARD_STRINGS.slice(0, 229);

function fontCodeByteWidths(toUnicode, isCidFont) {
  if (toUnicode?.size) {
    return Array.from(new Set(Array.from(toUnicode.keys()).map((key) => key.length / 2))).sort((left, right) => right - left);
  }
  return isCidFont ? [2] : [1];
}

function normalizeRotation(value) {
  const rotation = Number(value) || 0;
  return ((rotation % 360) + 360) % 360;
}

function clampDimension(value, fallback) {
  // Reject NaN/Infinity/non-positive box sides and clamp to a generous upper
  // bound. PDF user-space units cap; canvas pixel clamp is applied separately.
  if (!Number.isFinite(value) || value <= 0) return fallback;
  if (value > 1_000_000) return fallback;
  return value;
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

function decodeGlyphRun(bytes, font) {
  if (!bytes.length) {
    return [];
  }
  if (!font) {
    return bytes.map((byte) => ({ code: byte, glyphName: standardGlyphName(byte), text: decodeWinAnsi([byte]), width: null }));
  }
  const glyphs = [];
  const codeByteWidths = font.codeByteWidths?.length ? font.codeByteWidths : font.isCidFont ? [2] : [1];
  for (let index = 0; index < bytes.length;) {
    const match = matchMappedGlyph(bytes, index, codeByteWidths, font);
    if (match) {
      glyphs.push(match.glyph);
      index += match.byteWidth;
      continue;
    }
    const byteWidth = font.isCidFont && index + 1 < bytes.length ? 2 : 1;
    const codeBytes = bytes.slice(index, index + byteWidth);
    const code = codeFromBytes(codeBytes);
    glyphs.push({
      code,
      glyphName: font.codeToGlyphName?.get(code) || standardGlyphName(code),
      text: font.isCidFont ? String.fromCharCode(code) : decodeWinAnsi([codeBytes[0]]),
      width: fontWidth(font, code),
    });
    index += byteWidth;
  }
  return glyphs;
}

function matchMappedGlyph(bytes, index, codeByteWidths, font) {
  if (!font.toUnicode?.size) {
    return null;
  }
  for (const byteWidth of codeByteWidths) {
    if (index + byteWidth > bytes.length) {
      continue;
    }
    const codeBytes = bytes.slice(index, index + byteWidth);
    const key = codeBytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join("");
    if (!font.toUnicode.has(key)) {
      continue;
    }
    const code = parseInt(key, 16);
    return {
      byteWidth,
      glyph: {
        code,
        glyphName: font.codeToGlyphName?.get(code) || standardGlyphName(code),
        text: font.toUnicode.get(key),
        width: fontWidth(font, code),
      },
    };
  }
  return null;
}

function codeFromBytes(bytes) {
  return bytes.reduce((code, byte) => (code << 8) | byte, 0);
}

function fontWidth(font, code) {
  if (!Number.isFinite(code)) {
    return null;
  }
  if (font.widths?.has(code)) {
    return font.widths.get(code);
  }
  if (font.widths?.size > 0) {
    return Number.isFinite(font.defaultWidth) ? font.defaultWidth : null;
  }
  return null;
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

function colorSpaceLabel(colorSpace) {
  if (Array.isArray(colorSpace)) {
    const name = colorSpace[0];
    if (name === "ICCBased") {
      return `ICCBased(${Number(colorSpace[1]?.N) || "unknown"})`;
    }
    if (name === "Indexed" || name === "I") {
      return `Indexed(${colorSpaceLabel(colorSpace[1])})`;
    }
    return name || "unknown";
  }
  return colorSpace || "unknown";
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
  if (base.includes("semibold") || base.includes("demibold")) {
    return "600";
  }
  if (base.includes("bold")) {
    return "700";
  }
  if (base.includes("medium")) {
    return "500";
  }
  if (base.includes("light")) {
    return "300";
  }
  return "400";
}

function fontFamilyFor(font) {
  if (font?.embeddedFontLoaded && font.embeddedFontFamily) {
    return quoteCssFontFamily(font.embeddedFontFamily);
  }
  const base = normalizedFontName(font);
  if (base.includes("lora")) {
    return "Lora, Georgia, Times New Roman, serif";
  }
  if (base.includes("merriweather")) {
    return "Merriweather, Georgia, Times New Roman, serif";
  }
  if (base.includes("satyr") || base.includes("faunus") || base.includes("crimson")) {
    return "Georgia, Times New Roman, serif";
  }
  if (base.includes("poppins")) {
    return "Poppins, Avenir Next, Helvetica Neue, Arial, sans-serif";
  }
  if (base.includes("roboto")) {
    return base.includes("mono") ? "Roboto Mono, ui-monospace, monospace" : "Roboto, Helvetica Neue, Arial, sans-serif";
  }
  if (base.includes("courier") || base.includes("mono")) {
    return "Courier New, ui-monospace, monospace";
  }
  if (base.includes("times")) {
    return "Times New Roman, Times, serif";
  }
  if (base.includes("serif") || base.includes("georgia") || base.includes("mincho")) {
    return "Georgia, Times New Roman, serif";
  }
  if (base.includes("arial")) {
    return "Arial, Helvetica, sans-serif";
  }
  return "Arial, Helvetica, sans-serif";
}

function quoteCssFontFamily(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function embeddedFontEntry(descriptor) {
  if (!descriptor) {
    return null;
  }
  if (descriptor.FontFile2) {
    return { ref: descriptor.FontFile2, format: "truetype" };
  }
  if (descriptor.FontFile3) {
    return { ref: descriptor.FontFile3, format: descriptor.Subtype || "fontfile3" };
  }
  if (descriptor.FontFile) {
    return { ref: descriptor.FontFile, format: "type1" };
  }
  return null;
}

async function installEmbeddedBrowserFont(embedded, metrics, toUnicode) {
  if (!embedded?.bytes || embedded.loaded || embedded.format !== "Type1C" || embedded.outlineFont?.kind !== "cff" || typeof document === "undefined" || !document.fonts) {
    return;
  }
  try {
    const fontBytes = buildOpenTypeCffFont(embedded.bytes, embedded.outlineFont, metrics, toUnicode, embedded.family);
    const fontFace = new FontFace(embedded.family, fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength));
    await fontFace.load();
    document.fonts.add(fontFace);
    embedded.loaded = true;
    embedded.error = null;
  } catch (error) {
    embedded.error = `Could not wrap Type1C/CFF as OpenType: ${error.message}`;
  }
}

function buildOpenTypeCffFont(cffBytes, cffFont, metrics, toUnicode, family) {
  const glyphCount = cffFont.charStrings.length;
  const cmap = cffUnicodeGlyphMap(cffFont, metrics, toUnicode);
  const widths = cffGlyphWidths(cffFont, metrics);
  const tables = new Map([
    ["CFF ", cffBytes],
    ["OS/2", buildOs2Table(cmap)],
    ["cmap", buildCmapTable(cmap)],
    ["head", buildHeadTable()],
    ["hhea", buildHheaTable(glyphCount, widths)],
    ["hmtx", buildHmtxTable(widths)],
    ["maxp", buildMaxpTable(glyphCount)],
    ["name", buildNameTable(family)],
    ["post", buildPostTable()],
  ]);
  return buildSfnt("OTTO", tables);
}

function cffUnicodeGlyphMap(cffFont, metrics, toUnicode) {
  const map = new Map();
  for (const [code, glyphName] of metrics.codeToGlyphName || []) {
    const glyphIndex = cffFont.nameToGlyph.get(glyphName);
    if (!Number.isFinite(glyphIndex)) {
      continue;
    }
    const unicode = unicodeForPdfCode(code, toUnicode) || unicodeForGlyphName(glyphName);
    if (unicode && unicode >= 0 && unicode < 0xffff) {
      map.set(unicode, glyphIndex);
    }
  }
  return map;
}

function unicodeForPdfCode(code, toUnicode) {
  if (!toUnicode?.size) {
    return null;
  }
  const width = code > 0xff ? 4 : 2;
  const text = toUnicode.get(code.toString(16).toUpperCase().padStart(width, "0"));
  const chars = text ? Array.from(text) : [];
  return chars.length === 1 ? chars[0].codePointAt(0) : null;
}

function unicodeForGlyphName(name) {
  if (!name) {
    return null;
  }
  if (name.length === 1) {
    return name.codePointAt(0);
  }
  const digit = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"].indexOf(name);
  return digit >= 0 ? 48 + digit : null;
}

function cffGlyphWidths(cffFont, metrics) {
  const widths = new Array(cffFont.charStrings.length).fill(Number.isFinite(metrics.defaultWidth) ? metrics.defaultWidth : 500);
  for (const [code, glyphName] of metrics.codeToGlyphName || []) {
    const glyphIndex = cffFont.nameToGlyph.get(glyphName);
    if (Number.isFinite(glyphIndex)) {
      widths[glyphIndex] = metrics.widths.get(code) ?? widths[glyphIndex];
    }
  }
  widths[0] = widths[0] || 500;
  return widths.map((width) => Math.max(0, Math.min(0xffff, Math.round(width))));
}

function buildSfnt(version, tableMap) {
  const entries = Array.from(tableMap.entries()).sort(([left], [right]) => left.localeCompare(right));
  const tableCount = entries.length;
  const entrySelector = Math.floor(Math.log2(tableCount));
  const searchRange = 16 * (1 << entrySelector);
  const rangeShift = tableCount * 16 - searchRange;
  let offset = 12 + tableCount * 16;
  const records = [];
  const tableBytes = [];
  for (const [tag, bytes] of entries) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const padded = paddedTable(data);
    records.push({ tag, checksum: tableChecksum(padded), offset, length: data.length });
    tableBytes.push(padded);
    offset += padded.length;
  }
  const output = new Uint8Array(offset);
  const writer = new BinaryWriter(output);
  writer.tag(version);
  writer.uint16(tableCount);
  writer.uint16(searchRange);
  writer.uint16(entrySelector);
  writer.uint16(rangeShift);
  for (const record of records) {
    writer.tag(record.tag);
    writer.uint32(record.checksum);
    writer.uint32(record.offset);
    writer.uint32(record.length);
  }
  for (const table of tableBytes) {
    output.set(table, writer.offset);
    writer.offset += table.length;
  }
  const headRecord = records.find((record) => record.tag === "head");
  writeUint32(output, headRecord.offset + 8, (0xb1b0afba - tableChecksum(output)) >>> 0);
  return output;
}

function paddedTable(bytes) {
  const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
  padded.set(bytes);
  return padded;
}

function tableChecksum(bytes) {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    sum = (sum + readUint32(bytes, offset)) >>> 0;
  }
  return sum;
}

function buildCmapTable(map) {
  const codes = Array.from(map.keys()).sort((left, right) => left - right);
  const segCount = codes.length + 1;
  const entrySelector = Math.floor(Math.log2(segCount));
  const searchRange = 2 * (1 << entrySelector);
  const rangeShift = segCount * 2 - searchRange;
  const length = 16 + segCount * 8;
  const bytes = new Uint8Array(12 + length);
  const writer = new BinaryWriter(bytes);
  writer.uint16(0);
  writer.uint16(1);
  writer.uint16(3);
  writer.uint16(1);
  writer.uint32(12);
  writer.uint16(4);
  writer.uint16(length);
  writer.uint16(0);
  writer.uint16(segCount * 2);
  writer.uint16(searchRange);
  writer.uint16(entrySelector);
  writer.uint16(rangeShift);
  for (const code of codes) writer.uint16(code);
  writer.uint16(0xffff);
  writer.uint16(0);
  for (const code of codes) writer.uint16(code);
  writer.uint16(0xffff);
  for (const code of codes) writer.int16(((map.get(code) - code) & 0xffff) << 16 >> 16);
  writer.int16(1);
  for (let index = 0; index < segCount; index += 1) writer.uint16(0);
  return bytes;
}

function buildHeadTable() {
  const writer = new BinaryWriter(new Uint8Array(54));
  writer.fixed(1);
  writer.fixed(1);
  writer.uint32(0);
  writer.uint32(0x5f0f3cf5);
  writer.uint16(0);
  writer.uint16(1000);
  writer.longDateTime(0);
  writer.longDateTime(0);
  writer.int16(-1000);
  writer.int16(-500);
  writer.int16(2000);
  writer.int16(1200);
  writer.uint16(0);
  writer.uint16(8);
  writer.int16(2);
  writer.int16(0);
  writer.int16(0);
  return writer.bytes;
}

function buildHheaTable(glyphCount, widths) {
  const writer = new BinaryWriter(new Uint8Array(36));
  writer.fixed(1);
  writer.int16(800);
  writer.int16(-250);
  writer.int16(200);
  writer.uint16(Math.max(...widths, 500));
  writer.int16(0);
  writer.int16(0);
  writer.int16(Math.max(...widths, 500));
  writer.int16(1);
  writer.int16(0);
  writer.int16(0);
  for (let index = 0; index < 4; index += 1) writer.int16(0);
  writer.int16(0);
  writer.uint16(glyphCount);
  return writer.bytes;
}

function buildHmtxTable(widths) {
  const writer = new BinaryWriter(new Uint8Array(widths.length * 4));
  for (const width of widths) {
    writer.uint16(width);
    writer.int16(0);
  }
  return writer.bytes;
}

function buildMaxpTable(glyphCount) {
  const writer = new BinaryWriter(new Uint8Array(6));
  writer.uint32(0x00005000);
  writer.uint16(glyphCount);
  return writer.bytes;
}

function buildNameTable(family) {
  const records = [1, 2, 4, 6].map((id) => ({ id, text: id === 2 ? "Regular" : family.replace(/[^A-Za-z0-9-]/g, "") }));
  const strings = records.map((record) => utf16Be(record.text));
  const stringOffset = 6 + records.length * 12;
  const length = stringOffset + strings.reduce((sum, bytes) => sum + bytes.length, 0);
  const writer = new BinaryWriter(new Uint8Array(length));
  writer.uint16(0);
  writer.uint16(records.length);
  writer.uint16(stringOffset);
  let offset = 0;
  records.forEach((record, index) => {
    writer.uint16(3);
    writer.uint16(1);
    writer.uint16(0x0409);
    writer.uint16(record.id);
    writer.uint16(strings[index].length);
    writer.uint16(offset);
    offset += strings[index].length;
  });
  for (const bytes of strings) {
    writer.bytes.set(bytes, writer.offset);
    writer.offset += bytes.length;
  }
  return writer.bytes;
}

function utf16Be(text) {
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    writeUint16(bytes, index * 2, text.charCodeAt(index));
  }
  return bytes;
}

function buildOs2Table(map) {
  const codes = Array.from(map.keys());
  const first = codes.length ? Math.min(...codes) : 0;
  const last = codes.length ? Math.max(...codes) : 0;
  const writer = new BinaryWriter(new Uint8Array(96));
  writer.uint16(3);
  writer.int16(500);
  writer.uint16(400);
  writer.uint16(5);
  writer.uint16(0);
  for (let index = 0; index < 11; index += 1) writer.int16(0);
  writer.bytes.set(new Uint8Array(10), writer.offset); writer.offset += 10;
  writer.uint32(1);
  writer.uint32(0);
  writer.uint32(0);
  writer.uint32(0);
  writer.tag("PDFL");
  writer.uint16(0x0040);
  writer.uint16(first);
  writer.uint16(last);
  writer.int16(800);
  writer.int16(-250);
  writer.int16(200);
  writer.uint16(1000);
  writer.uint16(300);
  writer.uint32(0);
  writer.uint32(0);
  writer.int16(500);
  writer.int16(700);
  writer.uint16(0);
  writer.uint16(32);
  writer.uint16(1);
  return writer.bytes;
}

function buildPostTable() {
  const writer = new BinaryWriter(new Uint8Array(32));
  writer.fixed(3);
  writer.fixed(0);
  writer.int16(-100);
  writer.int16(50);
  writer.uint32(0);
  writer.uint32(0);
  writer.uint32(0);
  writer.uint32(0);
  writer.uint32(0);
  return writer.bytes;
}

function parseCffFont(bytes) {
  const headerSize = bytes[2] || 4;
  let offset = headerSize;
  const nameIndex = readCffIndex(bytes, offset); offset = nameIndex.end;
  const topIndex = readCffIndex(bytes, offset); offset = topIndex.end;
  const stringIndex = readCffIndex(bytes, offset); offset = stringIndex.end;
  const globalSubrIndex = readCffIndex(bytes, offset);
  const topDict = parseCffDict(topIndex.objects[0] || new Uint8Array());
  const charStringsOffset = topDict.CharStrings;
  if (!charStringsOffset) {
    return null;
  }
  const charStrings = readCffIndex(bytes, charStringsOffset).objects;
  const strings = stringIndex.objects.map((value) => bytesToBinaryString(value));
  const charset = readCffCharset(bytes, topDict.charset || 0, charStrings.length, strings);
  let localSubrs = [];
  if (ENABLE_EXPERIMENTAL_OUTLINES && Array.isArray(topDict.Private)) {
    const privateOffset = topDict.Private[1];
    const privateSize = topDict.Private[0];
    const privateDict = parseCffDict(bytes.slice(privateOffset, privateOffset + privateSize));
    if (privateDict.Subrs) {
      localSubrs = readCffIndex(bytes, privateOffset + privateDict.Subrs).objects;
    }
  }
  return {
    kind: "cff",
    unitsPerEm: 1000,
    fontMatrix: cffFontMatrix(topDict.FontMatrix),
    charStrings,
    charset,
    nameToGlyph: new Map(charset.map((name, index) => [name, index])),
    localSubrs,
    localSubrBias: cffSubrBias(localSubrs.length),
    globalSubrs: globalSubrIndex.objects,
    globalSubrBias: cffSubrBias(globalSubrIndex.objects.length),
    glyphCache: new Map(),
    browserInstallable: false,
    browserInstallableError: "Type1C/CFF outlines are rendered directly, not installed as browser fonts",
  };
}

function cffFontMatrix(value) {
  if (!Array.isArray(value) || value.length < 6 || !value.every(Number.isFinite)) {
    return [0.001, 0, 0, 0.001, 0, 0];
  }
  return value.slice(0, 6);
}

function readCffIndex(bytes, offset) {
  const count = readUint16(bytes, offset);
  offset += 2;
  if (!count) {
    return { objects: [], end: offset };
  }
  const offSize = bytes[offset++];
  const offsets = [];
  for (let index = 0; index <= count; index += 1) {
    let value = 0;
    for (let byteIndex = 0; byteIndex < offSize; byteIndex += 1) {
      value = (value << 8) | bytes[offset++];
    }
    offsets.push(value);
  }
  const dataStart = offset;
  const objects = [];
  for (let index = 0; index < count; index += 1) {
    objects.push(bytes.slice(dataStart + offsets[index] - 1, dataStart + offsets[index + 1] - 1));
  }
  return { objects, end: dataStart + offsets[count] - 1 };
}

function parseCffDict(bytes) {
  const dict = {};
  const stack = [];
  for (let index = 0; index < bytes.length;) {
    const byte = bytes[index++];
    if (byte <= 21) {
      const operator = byte === 12 ? `12 ${bytes[index++]}` : String(byte);
      assignCffDictOperator(dict, operator, stack.splice(0));
      continue;
    }
    const parsed = readCffNumber(bytes, index - 1);
    stack.push(parsed.value);
    index = parsed.offset;
  }
  return dict;
}

function assignCffDictOperator(dict, operator, operands) {
  const value = operands.length === 1 ? operands[0] : operands;
  if (operator === "12 7") dict.FontMatrix = operands;
  if (operator === "15") dict.charset = value;
  if (operator === "17") dict.CharStrings = value;
  if (operator === "18") dict.Private = operands;
  if (operator === "19") dict.Subrs = value;
}

function readCffNumber(bytes, offset) {
  const byte = bytes[offset++];
  if (byte >= 32 && byte <= 246) return { value: byte - 139, offset };
  if (byte >= 247 && byte <= 250) return { value: (byte - 247) * 256 + bytes[offset++] + 108, offset };
  if (byte >= 251 && byte <= 254) return { value: -(byte - 251) * 256 - bytes[offset++] - 108, offset };
  if (byte === 28) {
    const value = readInt16(bytes, offset);
    return { value, offset: offset + 2 };
  }
  if (byte === 29) {
    const value = readUint32(bytes, offset);
    return { value, offset: offset + 4 };
  }
  if (byte === 30) return readCffRealNumber(bytes, offset);
  return { value: 0, offset };
}

function readCffRealNumber(bytes, offset) {
  let value = "";
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    for (const nibble of [byte >> 4, byte & 0x0f]) {
      if (nibble === 0x0f) {
        const number = Number(value);
        return { value: Number.isFinite(number) ? number : 0, offset };
      }
      value += cffRealNibble(nibble);
    }
  }
  const number = Number(value);
  return { value: Number.isFinite(number) ? number : 0, offset };
}

function cffRealNibble(nibble) {
  if (nibble <= 9) return String(nibble);
  if (nibble === 0x0a) return ".";
  if (nibble === 0x0b) return "E";
  if (nibble === 0x0c) return "E-";
  if (nibble === 0x0e) return "-";
  return "";
}

function readCffCharset(bytes, offset, glyphCount, strings) {
  if (offset === 0) {
    return CFF_ISO_ADOBE_CHARSET.slice(0, glyphCount);
  }
  const names = [".notdef"];
  const format = bytes[offset++];
  if (format === 0) {
    while (names.length < glyphCount) {
      names.push(cffString(readUint16(bytes, offset), strings));
      offset += 2;
    }
  } else if (format === 1 || format === 2) {
    while (names.length < glyphCount) {
      let sid = readUint16(bytes, offset); offset += 2;
      const left = format === 1 ? bytes[offset++] : readUint16(bytes, offset);
      if (format === 2) offset += 2;
      for (let index = 0; index <= left && names.length < glyphCount; index += 1) {
        names.push(cffString(sid + index, strings));
      }
    }
  }
  return names;
}

function cffString(sid, strings) {
  return CFF_STANDARD_STRINGS[sid] || strings[sid - 391] || `.sid${sid}`;
}

function cffSubrBias(count) {
  return count < 1240 ? 107 : count < 33900 ? 1131 : 32768;
}

function cffGlyphOutlineForName(font, glyphName) {
  const glyphIndex = font.nameToGlyph.get(glyphName);
  if (!Number.isFinite(glyphIndex)) {
    return null;
  }
  if (!font.glyphCache.has(glyphIndex)) {
    font.glyphCache.set(glyphIndex, parseType2CharString(font, glyphIndex));
  }
  return font.glyphCache.get(glyphIndex);
}

function parseType2CharString(font, glyphIndex) {
  const commands = [];
  const state = { x: 0, y: 0, stack: [], stems: 0, commands };
  interpretType2Bytes(font, font.charStrings[glyphIndex], state, 0);
  return commands.length ? { commands } : null;
}

function interpretType2Bytes(font, bytes, state, depth) {
  if (!bytes || depth > 10) return;
  for (let offset = 0; offset < bytes.length;) {
    const byte = bytes[offset++];
    if (byte >= 32 || byte === 28 || byte === 255) {
      const parsed = readType2Number(bytes, offset - 1);
      state.stack.push(parsed.value);
      offset = parsed.offset;
      continue;
    }
    if (byte === 12) {
      interpretType2Escape(bytes[offset++], state);
      continue;
    }
    if (byte === 10 || byte === 29) {
      const operand = state.stack.pop();
      const subrs = byte === 10 ? font.localSubrs : font.globalSubrs;
      const bias = byte === 10 ? font.localSubrBias : font.globalSubrBias;
      interpretType2Bytes(font, subrs[operand + bias], state, depth + 1);
      continue;
    }
    if (byte === 11) return;
    offset = interpretType2Operator(byte, bytes, offset, state);
  }
}

function readType2Number(bytes, offset) {
  const byte = bytes[offset++];
  if (byte >= 32 && byte <= 246) return { value: byte - 139, offset };
  if (byte >= 247 && byte <= 250) return { value: (byte - 247) * 256 + bytes[offset++] + 108, offset };
  if (byte >= 251 && byte <= 254) return { value: -(byte - 251) * 256 - bytes[offset++] - 108, offset };
  if (byte === 28) return { value: readInt16(bytes, offset), offset: offset + 2 };
  if (byte === 255) return { value: readInt16(bytes, offset) + readUint16(bytes, offset + 2) / 65536, offset: offset + 4 };
  return { value: 0, offset };
}

function interpretType2Operator(operator, bytes, offset, state) {
  const stack = state.stack;
  if ([1, 3, 18, 23].includes(operator)) {
    state.stems += type2StemCount(stack);
    stack.length = 0;
    return offset;
  }
  if (operator === 19 || operator === 20) {
    state.stems += type2StemCount(stack);
    stack.length = 0;
    return offset + Math.ceil(state.stems / 8);
  }
  if (operator === 13) state.x += stack[0] || 0;
  if (operator === 4) moveType2(state, 0, stack.pop() || 0);
  else if (operator === 21) moveType2(state, stack.at(-2) || 0, stack.at(-1) || 0);
  else if (operator === 22) moveType2(state, stack.pop() || 0, 0);
  else if (operator === 5) type2LinePairs(state, stack);
  else if (operator === 6) type2AlternatingLines(state, stack, true);
  else if (operator === 7) type2AlternatingLines(state, stack, false);
  else if (operator === 8) type2CurveGroups(state, stack);
  else if (operator === 14) return bytes.length;
  else if (operator === 24) type2CurveLine(state, stack);
  else if (operator === 25) type2LineCurve(state, stack);
  else if (operator === 26) type2VVCurve(state, stack);
  else if (operator === 27) type2HHCurve(state, stack);
  else if (operator === 30) type2VHCurve(state, stack, false);
  else if (operator === 31) type2VHCurve(state, stack, true);
  stack.length = 0;
  return offset;
}

function type2StemCount(stack) {
  return Math.floor((stack.length % 2 ? stack.length - 1 : stack.length) / 2);
}

function interpretType2Escape(operator, state) {
  const values = state.stack;
  if (operator === 34 && values.length >= 7) {
    const [dx1, dx2, dy2, dx3, dx4, dx5, dx6] = values;
    curveType2(state, dx1, 0, dx2, dy2, dx3, 0);
    curveType2(state, dx4, 0, dx5, -dy2, dx6, 0);
  } else if (operator === 35 && values.length >= 13) {
    curveType2(state, values[0], values[1], values[2], values[3], values[4], values[5]);
    curveType2(state, values[6], values[7], values[8], values[9], values[10], values[11]);
  } else if (operator === 36 && values.length >= 9) {
    curveType2(state, values[0], values[1], values[2], values[3], values[4], 0);
    curveType2(state, values[5], 0, values[6], values[7], values[8], -(values[1] + values[3] + values[7]));
  } else if (operator === 37 && values.length >= 11) {
    const dx = values[0] + values[2] + values[4] + values[6] + values[8];
    const dy = values[1] + values[3] + values[5] + values[7] + values[9];
    const horizontalLast = Math.abs(dx) > Math.abs(dy);
    curveType2(state, values[0], values[1], values[2], values[3], values[4], values[5]);
    curveType2(state, values[6], values[7], values[8], values[9], horizontalLast ? values[10] : -dx, horizontalLast ? -dy : values[10]);
  }
  state.stack.length = 0;
}

function moveType2(state, dx, dy) {
  state.x += dx;
  state.y += dy;
  state.commands.push(["M", state.x, state.y]);
}

function lineType2(state, dx, dy) {
  state.x += dx;
  state.y += dy;
  state.commands.push(["L", state.x, state.y]);
}

function curveType2(state, dx1, dy1, dx2, dy2, dx3, dy3) {
  const x1 = state.x + dx1;
  const y1 = state.y + dy1;
  const x2 = x1 + dx2;
  const y2 = y1 + dy2;
  state.x = x2 + dx3;
  state.y = y2 + dy3;
  state.commands.push(["C", x1, y1, x2, y2, state.x, state.y]);
}

function type2LinePairs(state, values) {
  for (let index = 0; index + 1 < values.length; index += 2) lineType2(state, values[index], values[index + 1]);
}

function type2AlternatingLines(state, values, horizontalFirst) {
  values.forEach((value, index) => lineType2(state, (index % 2 === 0) === horizontalFirst ? value : 0, (index % 2 === 0) === horizontalFirst ? 0 : value));
}

function type2CurveGroups(state, values) {
  for (let index = 0; index + 5 < values.length; index += 6) curveType2(state, values[index], values[index + 1], values[index + 2], values[index + 3], values[index + 4], values[index + 5]);
}

function type2CurveLine(state, values) {
  type2CurveGroups(state, values.slice(0, -2));
  lineType2(state, values.at(-2) || 0, values.at(-1) || 0);
}

function type2LineCurve(state, values) {
  type2LinePairs(state, values.slice(0, -6));
  type2CurveGroups(state, values.slice(-6));
}

function type2VVCurve(state, values) {
  let index = values.length % 2 ? 1 : 0;
  if (index) curveType2(state, values[0], values[1], values[2], values[3], 0, values[4]);
  for (; index + 3 < values.length; index += 4) curveType2(state, 0, values[index], values[index + 1], values[index + 2], 0, values[index + 3]);
}

function type2HHCurve(state, values) {
  let index = values.length % 2 ? 1 : 0;
  if (index) curveType2(state, values[1], values[0], values[2], values[3], values[4], 0);
  for (; index + 3 < values.length; index += 4) curveType2(state, values[index], 0, values[index + 1], values[index + 2], values[index + 3], 0);
}

function type2VHCurve(state, values, horizontalFirst) {
  let index = 0;
  while (index + 3 < values.length) {
    const remainingAfterCurve = values.length - index - 4;
    const finalDelta = remainingAfterCurve === 1 ? values[index + 4] : 0;
    if (horizontalFirst) {
      curveType2(state, values[index], 0, values[index + 1], values[index + 2], finalDelta, values[index + 3]);
    } else {
      curveType2(state, 0, values[index], values[index + 1], values[index + 2], values[index + 3], finalDelta);
    }
    index += finalDelta ? 5 : 4;
    horizontalFirst = !horizontalFirst;
  }
}

function parseTrueTypeFont(bytes) {
  const tables = trueTypeTables(bytes);
  const head = tables.get("head");
  const maxp = tables.get("maxp");
  const loca = tables.get("loca");
  const glyf = tables.get("glyf");
  const cmap = tables.get("cmap");
  if (!head || !maxp || !loca || !glyf || !cmap) {
    return null;
  }
  const unitsPerEm = readUint16(bytes, head.offset + 18) || 1000;
  const indexToLocFormat = readInt16(bytes, head.offset + 50);
  const glyphCount = readUint16(bytes, maxp.offset + 4);
  return {
    bytes,
    tables,
    unitsPerEm,
    indexToLocFormat,
    glyphCount,
    cmap: parseTrueTypeCmap(bytes, cmap),
    glyphCache: new Map(),
    browserInstallable: tables.has("OS/2"),
    browserInstallableError: tables.has("OS/2") ? null : "TrueType subset is missing browser-required OS/2 table",
  };
}

function trueTypeTables(bytes) {
  const tables = new Map();
  const tableCount = readUint16(bytes, 4);
  for (let tableIndex = 0; tableIndex < tableCount; tableIndex += 1) {
    const offset = 12 + tableIndex * 16;
    tables.set(readTag(bytes, offset), {
      offset: readUint32(bytes, offset + 8),
      length: readUint32(bytes, offset + 12),
    });
  }
  return tables;
}

function parseTrueTypeCmap(bytes, table) {
  const maps = [];
  const subtableCount = readUint16(bytes, table.offset + 2);
  for (let recordIndex = 0; recordIndex < subtableCount; recordIndex += 1) {
    const recordOffset = table.offset + 4 + recordIndex * 8;
    const platform = readUint16(bytes, recordOffset);
    const encoding = readUint16(bytes, recordOffset + 2);
    const subtableOffset = table.offset + readUint32(bytes, recordOffset + 4);
    const format = readUint16(bytes, subtableOffset);
    const map = format === 0 ? parseCmapFormat0(bytes, subtableOffset) : format === 4 ? parseCmapFormat4(bytes, subtableOffset) : null;
    if (map) {
      maps.push({ platform, encoding, map });
    }
  }
  return maps.find((entry) => entry.platform === 1)?.map || maps[0]?.map || new Map();
}

function parseCmapFormat0(bytes, offset) {
  const map = new Map();
  for (let code = 0; code < 256; code += 1) {
    map.set(code, bytes[offset + 6 + code] || 0);
  }
  return map;
}

function parseCmapFormat4(bytes, offset) {
  const map = new Map();
  const segmentCount = readUint16(bytes, offset + 6) / 2;
  const endCodesOffset = offset + 14;
  const startCodesOffset = endCodesOffset + segmentCount * 2 + 2;
  const idDeltasOffset = startCodesOffset + segmentCount * 2;
  const idRangeOffsetsOffset = idDeltasOffset + segmentCount * 2;
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const endCode = readUint16(bytes, endCodesOffset + segmentIndex * 2);
    const startCode = readUint16(bytes, startCodesOffset + segmentIndex * 2);
    const idDelta = readInt16(bytes, idDeltasOffset + segmentIndex * 2);
    const idRangeOffsetLocation = idRangeOffsetsOffset + segmentIndex * 2;
    const idRangeOffset = readUint16(bytes, idRangeOffsetLocation);
    for (let code = startCode; code <= endCode && code !== 0xffff; code += 1) {
      let glyphIndex = 0;
      if (idRangeOffset === 0) {
        glyphIndex = (code + idDelta) & 0xffff;
      } else {
        const glyphOffset = idRangeOffsetLocation + idRangeOffset + (code - startCode) * 2;
        glyphIndex = readUint16(bytes, glyphOffset);
        if (glyphIndex) {
          glyphIndex = (glyphIndex + idDelta) & 0xffff;
        }
      }
      map.set(code, glyphIndex);
    }
  }
  return map;
}

function glyphOutlineForCode(font, code) {
  const glyphIndex = font.cmap.get(code);
  if (!Number.isFinite(glyphIndex)) {
    return null;
  }
  if (!font.glyphCache.has(glyphIndex)) {
    font.glyphCache.set(glyphIndex, parseGlyphOutline(font, glyphIndex));
  }
  return font.glyphCache.get(glyphIndex);
}

function glyphOutlineForGlyph(font, glyph) {
  if (font.kind === "cff") {
    return ENABLE_EXPERIMENTAL_OUTLINES && glyph.glyphName ? cffGlyphOutlineForName(font, glyph.glyphName) : null;
  }
  return glyphOutlineForCode(font, glyph.code);
}

function parseGlyphOutline(font, glyphIndex) {
  const location = glyphLocation(font, glyphIndex);
  if (!location || location.start === location.end) {
    return null;
  }
  const bytes = font.bytes;
  const glyphOffset = font.tables.get("glyf").offset + location.start;
  const contourCount = readInt16(bytes, glyphOffset);
  if (contourCount <= 0) {
    return null;
  }
  const contourEnds = [];
  for (let contourIndex = 0; contourIndex < contourCount; contourIndex += 1) {
    contourEnds.push(readUint16(bytes, glyphOffset + 10 + contourIndex * 2));
  }
  const pointCount = contourEnds.at(-1) + 1;
  let offset = glyphOffset + 10 + contourCount * 2;
  offset += 2 + readUint16(bytes, offset);
  const flags = [];
  while (flags.length < pointCount) {
    const flag = bytes[offset++];
    flags.push(flag);
    if (flag & 8) {
      const repeat = bytes[offset++];
      for (let repeatIndex = 0; repeatIndex < repeat; repeatIndex += 1) {
        flags.push(flag);
      }
    }
  }
  const xs = readGlyphCoordinates(bytes, flags, offset, 2, 16);
  offset = xs.offset;
  const ys = readGlyphCoordinates(bytes, flags, offset, 4, 32);
  const points = flags.map((flag, pointIndex) => ({ x: xs.values[pointIndex], y: ys.values[pointIndex], on: Boolean(flag & 1) }));
  const contours = [];
  let contourStart = 0;
  for (const contourEnd of contourEnds) {
    contours.push(points.slice(contourStart, contourEnd + 1));
    contourStart = contourEnd + 1;
  }
  return contours;
}

function readGlyphCoordinates(bytes, flags, offset, shortFlag, sameFlag) {
  const values = [];
  let value = 0;
  for (const flag of flags) {
    let delta = 0;
    if (flag & shortFlag) {
      delta = bytes[offset++];
      if (!(flag & sameFlag)) {
        delta = -delta;
      }
    } else if (!(flag & sameFlag)) {
      delta = readInt16(bytes, offset);
      offset += 2;
    }
    value += delta;
    values.push(value);
  }
  return { values, offset };
}

function glyphLocation(font, glyphIndex) {
  if (glyphIndex < 0 || glyphIndex >= font.glyphCount) {
    return null;
  }
  const locaOffset = font.tables.get("loca").offset;
  if (font.indexToLocFormat === 0) {
    return {
      start: readUint16(font.bytes, locaOffset + glyphIndex * 2) * 2,
      end: readUint16(font.bytes, locaOffset + glyphIndex * 2 + 2) * 2,
    };
  }
  return {
    start: readUint32(font.bytes, locaOffset + glyphIndex * 4),
    end: readUint32(font.bytes, locaOffset + glyphIndex * 4 + 4),
  };
}

function appendGlyphPath(context, contours, x, scale, fontSize = 1, outlineFont = null) {
  if (contours?.commands) {
    appendCommandGlyphPath(context, contours.commands, x, scale, fontSize, outlineFont?.fontMatrix);
    return;
  }
  for (const contour of contours) {
    appendGlyphContour(context, contour, x, scale);
  }
}

function appendCommandGlyphPath(context, commands, x, scale, fontSize, fontMatrix) {
  for (const command of commands) {
    if (command[0] === "M") {
      const [pointX, pointY] = glyphCommandPoint(command[1], command[2], x, scale, fontSize, fontMatrix);
      context.moveTo(pointX, pointY);
    }
    if (command[0] === "L") {
      const [pointX, pointY] = glyphCommandPoint(command[1], command[2], x, scale, fontSize, fontMatrix);
      context.lineTo(pointX, pointY);
    }
    if (command[0] === "C") {
      const first = glyphCommandPoint(command[1], command[2], x, scale, fontSize, fontMatrix);
      const second = glyphCommandPoint(command[3], command[4], x, scale, fontSize, fontMatrix);
      const third = glyphCommandPoint(command[5], command[6], x, scale, fontSize, fontMatrix);
      context.bezierCurveTo(first[0], first[1], second[0], second[1], third[0], third[1]);
    }
  }
}

function glyphCommandPoint(glyphX, glyphY, x, scale, fontSize, fontMatrix) {
  if (!fontMatrix) {
    return [x + glyphX * scale, -glyphY * scale];
  }
  const [a, b, c, d, e, f] = fontMatrix;
  return [x + (glyphX * a + glyphY * c + e) * fontSize, -(glyphX * b + glyphY * d + f) * fontSize];
}

function appendGlyphContour(context, contour, x, scale) {
  if (!contour.length) {
    return;
  }
  const first = contour[0];
  const last = contour.at(-1);
  const start = first.on ? first : last.on ? last : midpoint(first, last);
  context.moveTo(x + start.x * scale, -start.y * scale);
  let pointIndex = first.on ? 1 : 0;
  while (pointIndex < contour.length) {
    const point = contour[pointIndex];
    if (point.on) {
      context.lineTo(x + point.x * scale, -point.y * scale);
      pointIndex += 1;
      continue;
    }
    const next = contour[(pointIndex + 1) % contour.length];
    const end = next.on ? next : midpoint(point, next);
    context.quadraticCurveTo(x + point.x * scale, -point.y * scale, x + end.x * scale, -end.y * scale);
    pointIndex += next.on ? 2 : 1;
  }
  context.closePath();
}

function midpoint(first, second) {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2, on: true };
}

function readTag(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

class BinaryWriter {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  tag(value) {
    for (let index = 0; index < 4; index += 1) {
      this.bytes[this.offset++] = value.charCodeAt(index) || 0;
    }
  }

  uint16(value) {
    writeUint16(this.bytes, this.offset, value);
    this.offset += 2;
  }

  int16(value) {
    writeUint16(this.bytes, this.offset, value & 0xffff);
    this.offset += 2;
  }

  uint32(value) {
    writeUint32(this.bytes, this.offset, value);
    this.offset += 4;
  }

  fixed(value) {
    this.uint32(Math.round(value * 65536) >>> 0);
  }

  longDateTime(value) {
    this.uint32(0);
    this.uint32(value >>> 0);
  }
}

function writeUint16(bytes, offset, value) {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeUint32(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function readUint16(bytes, offset) {
  return ((bytes[offset] || 0) << 8) | (bytes[offset + 1] || 0);
}

function readInt16(bytes, offset) {
  const value = readUint16(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

function readUint32(bytes, offset) {
  return (((bytes[offset] || 0) * 0x1000000) + (((bytes[offset + 1] || 0) << 16) | ((bytes[offset + 2] || 0) << 8) | (bytes[offset + 3] || 0))) >>> 0;
}

function normalizedFontName(font) {
  const base = String(font?.baseFont || "").toLowerCase();
  return base.replace(/^[a-z]{6}\+/, "").replace(/[,_-]/g, "");
}