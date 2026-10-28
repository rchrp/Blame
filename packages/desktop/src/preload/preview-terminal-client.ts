import type { PreviewTerminalClient } from "@blame/app";

type Event = Parameters<Parameters<PreviewTerminalClient["onEvent"]>[1]>[0];
type Delivery = Event & { id: string; sequence: number };
type Stream = {
  sequence?: number;
  events: Delivery[];
  bytes: number;
  callback?: (event: Event) => void;
};
type Transport = {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(
    channel: string,
    callback: (_event: unknown, value: Delivery) => void,
  ): unknown;
};

/** Listen before attach: output may arrive before its IPC reply or React's
 * event subscription. Sequence numbers discard bytes already in the replay. */
export function createPreviewTerminalClient(
  ipc: Transport,
): PreviewTerminalClient {
  const streams = new Map<string, Stream>();
  ipc.on("preview-terminal:event", (_event, event) => {
    let stream = streams.get(event.id);
    if (!stream) {
      if (streams.size >= 32) return;
      stream = { events: [], bytes: 0 };
      streams.set(event.id, stream);
    }
    if (stream.sequence !== undefined && event.sequence <= stream.sequence)
      return;
    if (stream.callback) {
      stream.sequence = event.sequence;
      stream.callback(event);
    } else {
      stream.bytes += event.data.length;
      if (stream.bytes > 4 * 1024 * 1024) {
        streams.delete(event.id);
        void ipc.invoke("preview-terminal:detach", event.id);
        return;
      }
      stream.events.push(event);
    }
  });
  return {
    async attach(scope) {
      const result = await ipc.invoke("preview-terminal:attach", scope);
      const stream = streams.get(result.id) ?? { events: [], bytes: 0 };
      stream.sequence = result.sequence;
      stream.events = stream.events.filter(
        (event) => event.sequence > result.sequence,
      );
      stream.bytes = stream.events.reduce(
        (sum, event) => sum + event.data.length,
        0,
      );
      streams.set(result.id, stream);
      return result;
    },
    detach(id) {
      streams.delete(id);
      return ipc.invoke("preview-terminal:detach", id);
    },
    write: (input) => ipc.invoke("preview-terminal:write", input),
    resize: (input) => ipc.invoke("preview-terminal:resize", input),
    restart: (id) => ipc.invoke("preview-terminal:restart", id),
    read: (id) => ipc.invoke("preview-terminal:read", id),
    onEvent(id, callback) {
      const stream = streams.get(id);
      if (!stream) return () => {};
      stream.callback = callback;
      const pending = stream.events;
      stream.events = [];
      stream.bytes = 0;
      for (const event of pending) {
        if (stream.sequence !== undefined && event.sequence <= stream.sequence)
          continue;
        stream.sequence = event.sequence;
        callback(event);
      }
      return () => {
        if (stream.callback === callback) stream.callback = undefined;
      };
    },
  };
}
