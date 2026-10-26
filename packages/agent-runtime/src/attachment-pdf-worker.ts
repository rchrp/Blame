import { parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";

// PDF.js recognizes Node worker threads correctly, including when their host
// is an Electron utility process (which PDF.js otherwise mistakes for a DOM).
try {
  const { bytes, page } = workerData as { bytes: Uint8Array; page: number };
  parentPort!.postMessage({ result: await pdfText(bytes, page) });
} catch (error) {
  parentPort!.postMessage({
    error: error instanceof Error ? error.message : "Unable to read PDF.",
  });
}

async function pdfText(bytes: Uint8Array, page: number) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const assets = new URL(
    "../../",
    import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"),
  );
  const loading = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    standardFontDataUrl: fileURLToPath(new URL("standard_fonts/", assets)),
    cMapUrl: fileURLToPath(new URL("cmaps/", assets)),
    cMapPacked: true,
    wasmUrl: fileURLToPath(new URL("wasm/", assets)),
  });
  try {
    const pdf = await loading.promise;
    if (page > pdf.numPages)
      throw new Error(`Page must be between 1 and ${pdf.numPages}.`);
    const content = await (await pdf.getPage(page)).getTextContent();
    const text = content.items
      .map((item) =>
        "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
      )
      .join("");
    return {
      format: "pdf",
      page,
      pages: pdf.numPages,
      text,
      ...(!text.trim()
        ? {
            notice:
              "This page has no selectable text. It may be a scan; do not infer its contents from the filename.",
          }
        : {}),
    };
  } finally {
    await loading.destroy();
  }
}
