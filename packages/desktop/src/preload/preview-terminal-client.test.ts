import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createPreviewTerminalClient } from "./preview-terminal-client.ts";

test("terminal attach replays once and preserves output during both IPC and view gaps", async () => {
  const events = new EventEmitter();
  const reply = Promise.withResolvers<object>();
  const client = createPreviewTerminalClient({
    on: events.on.bind(events),
    invoke: async () => reply.promise,
  });
  const deliver = (sequence: number, data: string) =>
    events.emit("preview-terminal:event", null, {
      id: "session",
      sequence,
      type: "stdout",
      data,
    });
  const attaching = client.attach({ storyId: "s", serviceId: "cli" });
  deliver(1, "already replayed");
  deliver(2, "after capture");
  reply.resolve({
    id: "session",
    sequence: 1,
    replay: "already replayed",
    status: "ready",
    message: "Running",
  });
  const result = await attaching;
  deliver(3, "before view listener");
  const received: string[] = [];
  client.onEvent(result.id, (event) => received.push(event.data));
  deliver(4, "live");
  assert.equal(result.replay, "already replayed");
  assert.deepEqual(received, ["after capture", "before view listener", "live"]);
});
