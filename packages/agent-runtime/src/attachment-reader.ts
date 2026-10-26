import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { readPdfAttachment } from "./attachment-pdf.js";
import type { LightToolResult } from "./harness/light-contracts.js";

export const attachmentReadSchema = z.object({
  path: z.string().min(1),
  page: z.number().int().positive().optional(),
  sheet: z.string().min(1).optional(),
  offset: z.number().int().nonnegative().optional(),
});
type AttachmentReadInput = z.infer<typeof attachmentReadSchema>;
const maxBytes = 10 * 1024 * 1024;
const textLimit = 20_000;

// This is a read tool, not a conversion pipeline: originals stay intact and
// parsing happens only when the model asks to inspect an attached document.
export async function readAttachment(
  workspaceRoot: string,
  value: unknown,
  signal?: AbortSignal,
): Promise<LightToolResult<unknown>> {
  try {
    const input = attachmentReadSchema.parse(value);
    signal?.throwIfAborted();
    const root = await realpath(workspaceRoot);
    const attachments = join(root, ".blame", "attachments");
    const path = await realpath(resolve(workspaceRoot, input.path));
    const local = relative(attachments, path);
    if (
      !local ||
      local === ".." ||
      local.startsWith(`..${sep}`) ||
      isAbsolute(local)
    )
      throw new Error(
        "Only files in this workspace's attachment directory can be read.",
      );
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes)
      throw new Error("Attachments must be files of at most 10 MiB.");
    const bytes = await readFile(path);
    if (bytes.length > maxBytes) throw new Error("Attachment exceeds 10 MiB.");
    signal?.throwIfAborted();
    const document = await documentText(
      bytes,
      extname(path).toLowerCase(),
      input,
      signal,
    );
    signal?.throwIfAborted();
    const offset = input.offset ?? 0;
    const text = document.text.slice(offset, offset + textLimit);
    const truncated = offset + text.length < document.text.length;
    return {
      status: "ok",
      data: {
        ...document,
        path: input.path,
        text,
        truncated,
        ...(truncated ? { nextOffset: offset + text.length } : {}),
      },
    };
  } catch (error) {
    return {
      status: "blocked",
      category: "input",
      message:
        error instanceof Error ? error.message : "Unable to read attachment.",
    };
  }
}

async function documentText(
  bytes: Buffer,
  extension: string,
  input: AttachmentReadInput,
  signal?: AbortSignal,
): Promise<{
  text: string;
  format: string;
  page?: number;
  pages?: number;
  sheet?: string;
  sheets?: string[];
  notice?: string;
}> {
  if (extension === ".pdf")
    return readPdfAttachment(bytes, input.page ?? 1, signal);
  if (extension === ".docx") {
    const { extractRawText } = await import("mammoth");
    const result = await extractRawText({ buffer: bytes });
    return { format: "docx", text: result.value };
  }
  if (extension === ".xlsx") {
    const { default: readXlsx } = await import("read-excel-file/node");
    const workbook = await readXlsx(bytes);
    const sheets = workbook.map((entry) => entry.sheet);
    const sheet = input.sheet ?? sheets[0];
    if (!sheet || !sheets.includes(sheet))
      throw new Error(`Unknown worksheet. Choose from: ${sheets.join(", ")}`);
    const rows = workbook.find((entry) => entry.sheet === sheet)!.data;
    return {
      format: "xlsx",
      sheet,
      sheets,
      text: rows
        .map((row) =>
          row
            .map((cell) =>
              cell instanceof Date ? cell.toISOString() : String(cell ?? ""),
            )
            .join("\t"),
        )
        .join("\n"),
    };
  }
  // Text sources, Markdown, LaTeX, CSV, etc. Binary formats must never enter
  // a model prompt as mojibake or a misleading empty document.
  if (bytes.includes(0))
    throw new Error(
      "This binary format is not supported. Attach a PDF, DOCX, XLSX or text document.",
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      "This document is not UTF-8 text or a supported PDF, DOCX or XLSX file.",
    );
  }
  return { format: "text", text };
}
