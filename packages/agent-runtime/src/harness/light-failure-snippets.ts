import type { LightToolResult } from "./light-contracts.js";
import { arrayValue, lineByteRange } from "./light-read-results.js";
import { recordValue } from "./light-navigation.js";
import type { WorkspaceFiles } from "./workspace-files.js";

type ReadRange = (path: string, startLine: number, endLine: number) => Promise<LightToolResult<unknown>>;

/** Source excerpts around the first locations a failed check reports. */
export async function failedCheckSnippets(files: WorkspaceFiles, data: Record<string, unknown>, readRange: ReadRange) {
  const output = typeof data.output === "string" ? data.output : "";
  const snippets: unknown[] = [];
  let remaining = 4 * 1024;
  const seen = new Set<string>();
  const locations = [
    ...arrayValue(recordValue(data.check).diagnostics).flatMap((value) => {
      const diagnostic = recordValue(value);
      return typeof diagnostic.path === "string" && typeof diagnostic.line === "number"
        ? [{ path: diagnostic.path, line: diagnostic.line }] : [];
    }),
    ...[...output.matchAll(/(?:^|\s|\()([^\s():]+\.(?:[cm]?[jt]sx?|py|java|cs)):(\d+)(?::\d+)?/gmu)]
      .map((match) => ({ path: match[1]!, line: Number(match[2]) })),
  ];
  for (const location of locations) {
    const { line } = location;
    let path: string;
    try { path = files.normalizePath(location.path); } catch { continue; }
    if (snippets.length >= 2) break;
    if (seen.has(path)) continue;
    seen.add(path);
    if (!Number.isSafeInteger(line) || line < 1) continue;
    try {
      const content = (await files.read(path)).content;
      const [start, end] = lineByteRange(content, Math.max(1, line - 2), line + 2);
      if (end - start > remaining - 512) continue;
    } catch { continue; }
    const snippet = await readRange(path, Math.max(1, line - 2), line + 2);
    if (snippet.status !== "ok") continue;
    const bytes = Buffer.byteLength(JSON.stringify(snippet.data));
    if (bytes > remaining) continue;
    remaining -= bytes;
    snippets.push({ ...recordValue(snippet.data), source: "current workspace; diagnostic revision not certified" });
  }
  return snippets;
}
