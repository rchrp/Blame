import type { LightAliasRegistry } from "./light-aliases.js";
import type { LightRunTaskInput, LightToolResult } from "./light-contracts.js";
import { sha256 } from "./light-identity.js";
import { analyzeSymbolicSource } from "./symbolic-analysis.js";
import type { WorkspaceFiles } from "./workspace-files.js";

/** Read-only reasoning evidence, deliberately outside validation admission. */
export async function analyzeWorkspaceSymbol(
  files: WorkspaceFiles,
  aliases: LightAliasRegistry,
  input: Extract<LightRunTaskInput, { kind: "analyze" }>,
  signal?: AbortSignal,
): Promise<LightToolResult<unknown>> {
  try {
    signal?.throwIfAborted();
    const before = await files.snapshot(signal);
    const revision = before.revision.source_revision_id;
    const resolved = await aliases.resolveSymbol(input.target, files, revision);
    if (!/\.(?:[cm]?ts|tsx)$/iu.test(resolved.path) || resolved.content.length > 256 * 1024)
      return { status: "blocked", category: "input", message: "Symbolic analysis needs a typed TypeScript file no larger than 256 KiB." };
    const sourceHash = sha256(resolved.content);
    const analysis = await analyzeSymbolicSource({
      source: resolved.content.toString("utf8"),
      functionName: resolved.symbol.qualified_name,
      inputs: input.inputs,
      assertion: input.assertion,
      timeoutMs: input.timeoutMs,
      signal,
      solverPath: process.env.BLAME_Z3_PATH,
    });
    signal?.throwIfAborted();
    const current = (await files.snapshot(signal)).revision.source_revision_id === revision &&
      sha256((await files.read(resolved.path)).content) === sourceHash;
    if (!current) return { status: "ok", data: {
      status: "unknown", reason: "source_changed", sourceRevisionId: revision,
      sourceSha256: sourceHash, target: `${resolved.path}#${resolved.symbol.qualified_name}`,
      validationAdmission: false,
      guidance: "Source changed during analysis. Repeat on current source; the previous result is not current evidence.",
    } };
    return { status: "ok", data: {
      ...analysis, sourceRevisionId: revision,
      target: `${resolved.path}#${resolved.symbol.qualified_name}`,
      guidance: "Analysis applies only to this function, input domain and supplied assertion. A witness is reproduced by the supported source interpreter. Run a real regression test before treating it as a project defect. No edit coverage or source verification is granted.",
    } };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "blocked", category: "input",
      message: error instanceof Error ? error.message : String(error),
      recovery: "Choose a current function alias or path#functionName and explicit bounded scalar inputs. Unsupported code remains unknown." };
  }
}
