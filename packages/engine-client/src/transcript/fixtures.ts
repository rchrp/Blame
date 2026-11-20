// Builders for the transcript tests: write a session the way the engine does.
import type {
  AssistantBlock,
  Delivery,
  RecordBody,
  SessionConfig,
  SessionRecord,
  ToolOutcome,
  Usage,
} from "../protocol.js";

export const config: SessionConfig = {
  purpose: "development",
  workspace_root: "/work",
  model: { provider: "anthropic", model: "sonnet" },
  system_prompt: "system",
  engine_tools: [],
  client_tools: [],
  tool_options: {},
  limits: {},
  checkpoints: true,
};

export const usage = (input: number, output: number, cost?: number): Usage => ({
  input_tokens: input,
  output_tokens: output,
  ...(cost === undefined ? {} : { cost_micro_usd: cost }),
});

export const text = (value: string): AssistantBlock => ({
  type: "text",
  text: value,
});
export const reasoning = (value: string): AssistantBlock => ({
  type: "reasoning",
  text: value,
});
export const call = (
  id: string,
  name = "read_code",
  input: unknown = { path: `${id}.ts` },
): AssistantBlock => ({
  type: "tool_call",
  call: id,
  name,
  input: input as never,
});

/** Appends records with consecutive seqs, as the store does. */
export class Log {
  readonly records: SessionRecord[] = [];
  private clock = 1_000;

  constructor(withSession = true) {
    if (withSession) this.add({ type: "session_created", config });
  }

  get head(): number {
    return this.records.length;
  }

  /** Adds a record and returns its seq. */
  add(body: RecordBody): number {
    const record = {
      seq: this.records.length + 1,
      at_ms: (this.clock += 10),
      ...body,
    } as SessionRecord;
    this.records.push(record);
    return record.seq;
  }

  user(turn: string, message: string, delivery: Delivery = "turn"): number {
    return this.add({
      type: "user_message",
      turn,
      input: [{ type: "text", text: message }],
      delivery,
    });
  }

  checkpoint(turn: string): number {
    return this.add({
      type: "checkpoint_created",
      turn,
      checkpoint: `cp-${turn}`,
      snapshot: `tree-${turn}`,
    });
  }

  request(turn: string, request: string, attempt = 1): number {
    return this.add({
      type: "request_started",
      turn,
      request,
      model: config.model,
      attempt,
      prefix_digest: "sha256:0",
    });
  }

  reply(
    turn: string,
    request: string,
    blocks: AssistantBlock[],
    stop: "end_turn" | "tool_use" = "end_turn",
    u = usage(10, 5, 100),
  ): number {
    return this.add({
      type: "assistant_message",
      turn,
      request,
      blocks,
      stop,
      usage: u,
    });
  }

  failed(
    turn: string,
    request: string,
    kind: "overloaded" | "context_overflow" = "overloaded",
  ): number {
    return this.add({
      type: "request_failed",
      turn,
      request,
      error: { kind, message: kind },
    });
  }

  started(
    turn: string,
    id: string,
    name = "read_code",
    effect: "read_only" | "command" = "read_only",
  ): number {
    return this.add({
      type: "tool_call_started",
      turn,
      call: id,
      name,
      effect,
    });
  }

  finished(
    turn: string,
    id: string,
    outcome: ToolOutcome = "completed",
    output = "ok",
  ): number {
    return this.add({
      type: "tool_call_finished",
      turn,
      call: id,
      outcome,
      content: [{ type: "text", text: output }],
    });
  }

  ended(
    turn: string,
    outcome: "completed" | "interrupted" = "completed",
  ): number {
    return this.add({ type: "turn_ended", turn, outcome: { status: outcome } });
  }

  /** A rewind to `to`, as the engine writes it: started, then finished. */
  rewind(to: number): { started: number; finished: number } {
    const started = this.add({ type: "rewind_started", to });
    const finished = this.add({
      type: "rewind_finished",
      started,
      to,
      workspace: { status: "not_requested" },
      unreverted_commands: [],
    });
    return { started, finished };
  }

  undo(rewind: number): number {
    return this.add({ type: "rewind_undone", rewind });
  }

  /** One whole turn with a plain answer. */
  turn(turn: string, message: string, answer: string): void {
    this.user(turn, message);
    this.checkpoint(turn);
    this.request(turn, `${turn}-r1`);
    this.reply(turn, `${turn}-r1`, [text(answer)]);
    this.ended(turn);
  }
}
