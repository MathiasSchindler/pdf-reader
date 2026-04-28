import { brotliCompressSync, gzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { minify } from "terser";

const profiles = [
  {
    name: "full",
    suffix: "",
    diagnostics: true,
    experimentalOutlines: true,
    images: true,
    description: "full renderer with audit diagnostics and experimental outline mode",
  },
  {
    name: "viewer",
    suffix: ".viewer",
    diagnostics: false,
    experimentalOutlines: false,
    images: true,
    description: "small stable viewer with images and embedded browser fonts",
  },
  {
    name: "text",
    suffix: ".text",
    diagnostics: false,
    experimentalOutlines: false,
    images: false,
    description: "smallest profile for text/vector-only PDFs; image XObjects disabled",
  },
];

const formats = [
  { name: "esm", entry: "src/pdf-lite/index.js", outfile: (profile) => `dist/pdf-crumb${profile.suffix}.min.js`, format: "esm" },
  { name: "global", entry: "src/pdf-lite/global.js", outfile: (profile) => `dist/pdf-crumb${profile.suffix}.global.min.js`, format: "iife" },
];

await mkdir("dist", { recursive: true });

const rows = [];
for (const profile of profiles) {
  for (const format of formats) {
    const outfile = format.outfile(profile);
    const bundled = await build({
      entryPoints: [format.entry],
      bundle: true,
      format: format.format,
      write: false,
      legalComments: "none",
      define: {
        PDF_LITE_DIAGNOSTICS: String(profile.diagnostics),
        PDF_LITE_EXPERIMENTAL_OUTLINES: String(profile.experimentalOutlines),
        PDF_LITE_IMAGES: String(profile.images),
      },
    });
    const source = bundled.outputFiles[0].text;
    const minified = await minify(source, {
      module: format.format === "esm",
      compress: {
        passes: 3,
        pure_getters: true,
        unsafe: true,
        unsafe_arrows: true,
      },
      mangle: true,
      format: {
        comments: false,
      },
    });
    if (!minified.code) {
      throw new Error(`Terser produced no output for ${outfile}`);
    }
    await writeFile(outfile, `${minified.code}\n`);
    const bytes = Buffer.byteLength(minified.code);
    rows.push({
      profile: profile.name,
      format: format.name,
      file: outfile,
      bytes,
      gzip: gzipSync(minified.code).length,
      brotli: brotliCompressSync(minified.code).length,
      description: profile.description,
    });
  }
}

const header = ["profile", "format", "bytes", "gzip", "brotli", "file"];
const widths = header.map((key) => Math.max(key.length, ...rows.map((row) => String(row[key]).length)));
console.log(header.map((key, index) => key.padEnd(widths[index])).join("  "));
console.log(widths.map((width) => "-".repeat(width)).join("  "));
for (const row of rows) {
  console.log(header.map((key, index) => String(row[key]).padEnd(widths[index])).join("  "));
}
