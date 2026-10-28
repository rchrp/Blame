import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { openSurfaceChannel } from "./surface-proxy.ts";

test("surface proxy forwards binary data and consumes its token once", async () => {
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  upstream.on("connection", (socket) =>
    socket.on("message", (data, binary) => socket.send(data, { binary })),
  );
  const channel = await openSurfaceChannel(
    async () => new WebSocket(`ws://127.0.0.1:${address.port}`),
  );
  const socket = new WebSocket(channel.url);
  try {
    await once(socket, "open");
    // The renderer may send input before the upstream handshake finishes.
    const echoed = once(socket, "message");
    socket.send(Buffer.from([1, 2, 3]));
    assert.deepEqual((await echoed)[0], Buffer.from([1, 2, 3]));
    const second = new WebSocket(channel.url);
    await assert.rejects(once(second, "open"));
  } finally {
    socket.terminate();
    channel.close();
    upstream.clients.forEach((s) => s.terminate());
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
