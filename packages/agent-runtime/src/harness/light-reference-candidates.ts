import { parseCode, type ParsedSymbol } from "./code-intelligence.js";
import { sha256 } from "./light-identity.js";
import type { WorkspaceFiles } from "./workspace-files.js";

const limits = { files: 64, bytes: 1024 * 1024, fileBytes: 256 * 1024, declarations: 4 };
const identifier = "[\\p{ID_Start}_$][\\p{ID_Continue}$]*";
const supportedQuery = new RegExp(`^${identifier}(?:\\.${identifier})*$`, "u");
const declarationPrefix = new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|const|let|var)\\s+(${identifier})$`, "u");

/** Recognize only a literal name or a complete declaration prefix, never a regex or expression. */
export function declarationQuery(query: string) {
  const text = query.trim();
  return supportedQuery.test(text) ? text : declarationPrefix.exec(text)?.[1];
}
type Candidate = { path: string; content: Buffer; symbol: ParsedSymbol; qualifiedUnique: boolean };

/** Syntax discovery only: a caller must explicitly choose a declaration before compiler resolution. */
export async function referenceDeclarationCandidates(
  files: WorkspaceFiles,
  query: string,
  paths: string[],
  revision: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  // Ordering hints never establish declaration identity. Keep exact filename
  // affinity first, then preserve the bounded scan for source before test callers.
  const filename = query.split(".")[0];
  const eligible = paths.filter((path) => /\.[cm]?[jt]sx?$/iu.test(path))
    .sort((left, right) => Number(right.split("/").at(-1)?.replace(/\.[cm]?[jt]sx?$/iu, "") === filename) -
      Number(left.split("/").at(-1)?.replace(/\.[cm]?[jt]sx?$/iu, "") === filename) ||
      (process.env.BLAME_AGENT_DECLARATION_SOURCE_ORDER === "false" ? 0 :
        Number(testLikePath(left)) - Number(testLikePath(right))));
  const selected: Candidate[] = [];
  const reads = new Map<string, string>();
  let visitedFiles = 0, readBytes = 0, skippedFiles = 0;
  let limited = false;
  const report = (status: string, candidates: Candidate[] = []) => ({
    candidates,
    discovery: { engine: "syntax", status, navigationOnly: true,
      ...(status === "current" ? { sourceRevision: revision } : {}),
      eligibleFiles: eligible.length, visitedFiles, readBytes, skippedFiles, limited, limits: { ...limits } },
  });
  if (!supportedQuery.test(query)) return report("unsupported_query");
  for (const path of eligible) {
    signal?.throwIfAborted();
    if (visitedFiles === limits.files || selected.length > limits.declarations) {
      limited = true;
      break;
    }
    visitedFiles++;
    let content: Buffer;
    try {
      const size = await files.fileSize(path);
      if (size > limits.fileBytes) { skippedFiles++; continue; }
      if (readBytes + size > limits.bytes) { limited = true; break; }
      content = (await files.read(path)).content;
    } catch {
      signal?.throwIfAborted();
      skippedFiles++;
      continue;
    }
    // Recheck after the read, since the file could have grown after stat.
    if (content.byteLength > limits.fileBytes) { skippedFiles++; continue; }
    if (readBytes + content.byteLength > limits.bytes) { limited = true; break; }
    readBytes += content.byteLength;
    reads.set(path, sha256(content));
    const parsed = parseCode(path, content);
    if (!parsed.supported || parsed.errorCount) { skippedFiles++; continue; }
    for (const symbol of parsed.symbols) {
      if (symbol.name !== query && symbol.qualified_name !== query) continue;
      const qualifiedUnique = parsed.symbols.filter(other => other.qualified_name === symbol.qualified_name).length === 1;
      selected.push({ path, content, symbol, qualifiedUnique });
      if (selected.length > limits.declarations) { limited = true; break; }
    }
  }
  if (skippedFiles) limited = true;
  signal?.throwIfAborted();
  if ((await files.snapshot(signal)).revision.source_revision_id !== revision)
    return report("source_changed");
  for (const [path, hash] of reads) {
    signal?.throwIfAborted();
    try {
      if (await files.blobHash(path) === hash) continue;
    } catch { signal?.throwIfAborted(); }
    return report("source_changed");
  }
  return report("current", selected.slice(0, limits.declarations));
}

function testLikePath(path: string) {
  return /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)(?:-d)?\.[cm]?[jt]sx?$/iu.test(path);
}
