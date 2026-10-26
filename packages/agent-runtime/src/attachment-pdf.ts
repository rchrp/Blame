import { Worker } from "node:worker_threads";

type PdfText = {
  format: "pdf";
  page: number;
  pages: number;
  text: string;
  notice?: string;
};

export function readPdfAttachment(
  bytes: Uint8Array,
  page: number,
  signal?: AbortSignal,
): Promise<PdfText> {
  signal?.throwIfAborted();
  // Isolate PDF.js from Electron's process.type and from the agent event loop.
  // Do not spoof process globals: other libraries share the agent process.
  const data = Uint8Array.from(bytes);
  const worker = new Worker(
    new URL("./attachment-pdf-worker.js", import.meta.url),
    {
      execArgv: [],
      workerData: { bytes: data, page },
      transferList: [data.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    },
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: PdfText) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate().catch(() => undefined);
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(new Error("PDF reading was cancelled."));
    const timer = setTimeout(
      () => finish(new Error("PDF reading timed out.")),
      20_000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message: { error?: string; result?: PdfText }) => {
      if (message.error || !message.result)
        finish(new Error(message.error ?? "PDF reader returned no result."));
      else finish(undefined, message.result);
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) =>
      finish(new Error(`PDF reader exited before completing (${code}).`)),
    );
  });
}
