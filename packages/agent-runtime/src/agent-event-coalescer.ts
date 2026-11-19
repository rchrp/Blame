import type { AgentEvent } from "./types.js";

/**
 * Two display frames at 60 Hz. Text then reaches the screen at most 33 ms
 * later, which reads as live, and each session sends at most 30 text updates
 * a second. Measured on synthetic three-session streams, this window removes
 * 27% of the events at 70 tokens/s in 3-token deltas and 75% at 100 tokens/s
 * in 1-token deltas; one frame (16 ms) removed only 12% of the former.
 */
const coalescingWindowMs = 33;

type PendingDelta = {
  event: AgentEvent;
  text: string;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Merges the text and reasoning deltas a session streams within one window
 * into one event, so the worker posts, the main process buffers and the
 * renderer reduces one event per window instead of one per token. Any other
 * event of the session first sends its pending delta: nothing is reordered
 * within a session, and tools, approvals and turn ends are never delayed.
 */
export function createAgentEventCoalescer(
  send: (event: AgentEvent) => void,
  windowMs = coalescingWindowMs,
) {
  const pending = new Map<string, PendingDelta>();

  const flushSession = (key: string) => {
    const delta = pending.get(key);
    if (!delta) return;
    pending.delete(key);
    clearTimeout(delta.timer);
    send(withDeltaText(delta.event, delta.text));
  };

  return {
    push(event: AgentEvent) {
      const key = event.sessionId ?? "";
      const text = deltaText(event);
      const current = pending.get(key);
      if (text !== undefined && current && extendsDelta(current, event, text)) {
        current.text += text;
        return;
      }
      flushSession(key);
      if (text === undefined) {
        send(event);
        return;
      }
      const timer = setTimeout(() => flushSession(key), windowMs);
      pending.set(key, { event, text, timer });
    },
    flush() {
      [...pending.keys()].forEach(flushSession);
    },
  };
}

function deltaText(event: AgentEvent) {
  if (event.type !== "text" && event.type !== "reasoning") return undefined;
  const text = payloadRecord(event).text;
  return typeof text === "string" ? text : undefined;
}

// A delta extends the pending one when only its text differs. A blank delta
// stays on its own: the conversation drops blank text that would open a
// message, so it must not swallow the words that follow it.
function extendsDelta(
  current: PendingDelta,
  next: AgentEvent,
  nextText: string,
) {
  if (!current.text.trim() && nextText.trim()) return false;
  return (
    sameFields(current.event, next, "payload") &&
    sameFields(payloadRecord(current.event), payloadRecord(next), "text")
  );
}

function sameFields(left: object, right: object, except: string) {
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(leftRecord),
    ...Object.keys(rightRecord),
  ]);
  keys.delete(except);
  for (const key of keys) {
    if (leftRecord[key] !== rightRecord[key]) return false;
  }
  return true;
}

function withDeltaText(event: AgentEvent, text: string): AgentEvent {
  if (payloadRecord(event).text === text) return event;
  return { ...event, payload: { ...payloadRecord(event), text } };
}

function payloadRecord(event: AgentEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};
}
