// A specialist runs as a sub-agent inside the consult_specialist tool call.
// Its own tool calls, messages and reasoning are relayed as updates of that
// call, so the app can show them as the specialist's thread, apart from the
// lead agent's work.

export const specialistStepUpdateType = "blame.specialist_step";

export type SpecialistStep =
  | {
      id: string;
      kind: "tool";
      phase: "started" | "finished" | "failed";
      toolCallId: string;
      toolName: string;
      input?: unknown;
      output?: unknown;
      error?: string;
    }
  | { id: string; kind: "message" | "reasoning"; text: string };

export type SpecialistStepUpdate = {
  type: typeof specialistStepUpdateType;
  step: SpecialistStep;
};

const maxValueLength = 8_000;

// Reads one sub-agent event (Cline's shared AgentEvent shape). Only finished
// text and reasoning are relayed, not every streamed delta, to keep the
// thread light.
export function specialistStepReader() {
  let textCount = 0;
  return (event: unknown): SpecialistStep | undefined => {
    const value = record(event);
    const type = value.type;
    const contentType = value.contentType;
    if (contentType === "tool") {
      const toolCallId = stringValue(value.toolCallId);
      const toolName = stringValue(value.toolName);
      if (!toolCallId || !toolName) return undefined;
      if (type === "content_start")
        return {
          id: `tool-${toolCallId}`,
          kind: "tool",
          phase: "started",
          toolCallId,
          toolName,
          input: compactValue(value.input),
        };
      if (type === "content_end") {
        const error = stringValue(value.error);
        return {
          id: `tool-${toolCallId}`,
          kind: "tool",
          phase: error ? "failed" : "finished",
          toolCallId,
          toolName,
          output: compactValue(value.output),
          ...(error ? { error } : {}),
        };
      }
      return undefined;
    }
    if (type !== "content_end") return undefined;
    if (contentType === "text") {
      const text = stringValue(value.text)?.trim();
      if (!text) return undefined;
      textCount += 1;
      return { id: `message-${textCount}`, kind: "message", text };
    }
    if (contentType === "reasoning") {
      const text = stringValue(value.reasoning)?.trim();
      if (!text) return undefined;
      textCount += 1;
      return { id: `reasoning-${textCount}`, kind: "reasoning", text };
    }
    return undefined;
  };
}

export function specialistStepUpdate(step: SpecialistStep): SpecialistStepUpdate {
  return { type: specialistStepUpdateType, step };
}

// Large tool inputs and outputs are cut to an excerpt, the same compact
// shape the app already reads for tool details.
function compactValue(value: unknown) {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : safeJson(value);
  if (text === undefined || text.length <= maxValueLength) return value;
  return { excerpt: text.slice(0, maxValueLength), truncated: true };
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}
