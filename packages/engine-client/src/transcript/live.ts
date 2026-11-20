import type {
  Delta,
  RequestId,
  SessionActivity,
  ToolCallId,
} from "../protocol.js";
import type { LiveBlock, LiveReply } from "./model.js";

/** Tool output kept per call: the tail is what a user watches. */
const MAX_PROGRESS_CHARS = 64 * 1024;

/**
 * What deltas say about the present: the reply being streamed, output of
 * running tools and the session's activity. None of it is stored, so none of
 * it takes part in rewinds: the records that follow replace it.
 */
export class LiveState {
  activity: SessionActivity = { state: "idle" };

  private request: RequestId | undefined;
  private blocks = new Map<number, LiveBlock>();
  /** The request whose reply (or failure) is already stored: late deltas are stale. */
  private closed: RequestId | undefined;
  private progress = new Map<ToolCallId, string>();
  private cachedReply: LiveReply | undefined;
  private cachedProgress: ReadonlyMap<ToolCallId, string> | undefined;

  /** A request was sent: whatever streamed before is over. */
  requestStarted(request: RequestId): void {
    this.dropReply();
    if (this.closed === request) this.closed = undefined;
  }

  /** The reply (or failure) of `request` is stored. */
  requestClosed(request: RequestId): void {
    this.closed = request;
    if (this.request === request) this.dropReply();
  }

  toolFinished(call: ToolCallId): void {
    if (this.progress.delete(call)) this.cachedProgress = undefined;
  }

  /** Forgets the stream: a rewind or a reload changed what is current. */
  reset(): void {
    this.dropReply();
    this.closed = undefined;
    this.progress = new Map();
    this.cachedProgress = undefined;
  }

  apply(delta: Delta): void {
    switch (delta.type) {
      case "activity":
        this.activity = delta.activity;
        return;
      case "tool_progress": {
        const text = (this.progress.get(delta.call) ?? "") + delta.text;
        this.progress.set(
          delta.call,
          text.length > MAX_PROGRESS_CHARS
            ? text.slice(-MAX_PROGRESS_CHARS)
            : text,
        );
        this.cachedProgress = undefined;
        return;
      }
      case "block_started":
        this.block(delta.request, delta.index, delta.kind, (block) => ({
          ...block,
          call: delta.call ?? block.call,
          tool: delta.tool ?? block.tool,
        }));
        return;
      case "text":
        this.block(delta.request, delta.index, "text", (block) => ({
          ...block,
          text: block.text + delta.text,
        }));
        return;
      case "reasoning":
        this.block(delta.request, delta.index, "reasoning", (block) => ({
          ...block,
          text: block.text + delta.text,
        }));
        return;
      case "tool_input":
        this.block(delta.request, delta.index, "tool_call", (block) => ({
          ...block,
          inputJson: block.inputJson + delta.json,
        }));
        return;
    }
  }

  reply(): LiveReply | undefined {
    if (this.request === undefined) return undefined;
    this.cachedReply ??= {
      request: this.request,
      blocks: [...this.blocks.values()].sort((a, b) => a.index - b.index),
    };
    return this.cachedReply;
  }

  toolProgress(): ReadonlyMap<ToolCallId, string> {
    this.cachedProgress ??= new Map(this.progress);
    return this.cachedProgress;
  }

  private dropReply(): void {
    this.request = undefined;
    this.blocks = new Map();
    this.cachedReply = undefined;
  }

  private block(
    request: RequestId,
    index: number,
    kind: LiveBlock["kind"],
    update: (block: LiveBlock) => LiveBlock,
  ): void {
    if (this.closed === request) return;
    if (this.request !== request) {
      this.dropReply();
      this.request = request;
    }
    const block = this.blocks.get(index) ?? {
      index,
      kind,
      text: "",
      call: undefined,
      tool: undefined,
      inputJson: "",
    };
    this.blocks.set(index, update(block));
    this.cachedReply = undefined;
  }
}
