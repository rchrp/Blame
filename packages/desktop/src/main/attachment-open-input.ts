import { basename, extname } from "node:path";

const extensions = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".tsv", ".ppt", ".pptx",
  ".odt", ".ods", ".odp", ".rtf", ".txt", ".md", ".markdown", ".tex", ".latex",
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".aiff", ".opus",
  ".mp4", ".mov", ".webm", ".mkv",
]);

export function attachmentOpenInput(input: unknown) {
  if (!input || typeof input !== "object" || !("name" in input) || !("content" in input) || typeof input.name !== "string" || !(input.content instanceof Uint8Array)) {
    throw new Error("Invalid attachment");
  }
  const extension = extname(input.name).toLowerCase();
  if (!extensions.has(extension)) throw new Error("Download this file to open it outside Blame.");
  if (input.content.byteLength > 100 * 1024 * 1024) throw new Error("This file is too large to open. Download it instead.");
  const stem = basename(input.name.replaceAll("\\", "/"), extname(input.name)).replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 100);
  return { name: `${stem || "attachment"}${extension}`, content: input.content };
}
