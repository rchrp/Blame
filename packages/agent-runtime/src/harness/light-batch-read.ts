import type { LightReadCodeInput, LightToolResult } from "./light-contracts.js";

type BatchReader<State> = {
  checkpoint(): State;
  restore(state: State): Promise<void>;
  revision(): Promise<string>;
  read(input: LightReadCodeInput): Promise<LightToolResult<unknown>>;
  observed(input: LightReadCodeInput, result: LightToolResult<unknown>): Promise<void>;
  signal?: AbortSignal;
};

/** Caller owns the workspace lock. Omitted bytes never establish observation. */
export async function batchRead<State>(reads: LightReadCodeInput[], reader: BatchReader<State>) {
  if (reads.length < 2 || reads.length > 4 || JSON.stringify(reads).length > 2_048)
    throw new Error("Batch reads require 2-4 bounded independent targets.");
  const initial = reader.checkpoint();
  const sourceRevisionId = await reader.revision();
  const results: Array<{ input: LightReadCodeInput; result: LightToolResult<unknown> }> = [];
  const budget = Math.min(6_000, Number(process.env.CLINE_MESSAGE_BUILDER_MAX_TOOL_RESULT_CHARS) || 8_000);
  const response = (remainingReads: LightReadCodeInput[]) => ({ status: "ok" as const, data: {
    view: "batch", sourceRevisionId, results, remainingReads,
    complete: remainingReads.length === 0,
    guidance: "Independent reads; inspect each result status. Remaining reads grant no coverage; request them individually or use a smaller range/signature. This is not validation.",
  } });
  try {
    for (const input of reads) {
      reader.signal?.throwIfAborted();
      const before = reader.checkpoint();
      const result = await reader.read(input);
      results.push({ input, result });
      const media = result.status === "ok" && result.content?.length;
      if (media || JSON.stringify(response(reads.slice(results.length))).length > budget) {
        results.pop();
        await reader.restore(before);
        break;
      }
    }
    reader.signal?.throwIfAborted();
    if (await reader.revision() !== sourceRevisionId) throw new Error("Source changed during batch read; read the current targets again.");
    for (const { input, result } of results) await reader.observed(input, result);
    return response(reads.slice(results.length));
  } catch (error) {
    await reader.restore(initial);
    throw error;
  }
}
