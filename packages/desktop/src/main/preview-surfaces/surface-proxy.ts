import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

/** A single-use loopback channel. Credentials stay in the main process. */
export async function openSurfaceChannel(open: () => Promise<WebSocket>) {
  const token = randomBytes(32).toString("hex");
  const server = createServer((_request, response) =>
    response.writeHead(404).end(),
  );
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
  });
  let used = false;
  let upstream: WebSocket | undefined;
  const close = () => {
    clearTimeout(timeout);
    upstream?.terminate();
    sockets.clients.forEach((socket) => socket.terminate());
    sockets.close();
    server.close();
  };
  const timeout = setTimeout(close, 30_000);
  timeout.unref();
  server.on("upgrade", (request, socket, head) => {
    const path = Buffer.from(request.url ?? "");
    const expected = Buffer.from(`/${token}`);
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (
      used ||
      request.headers.host !== host ||
      path.length !== expected.length ||
      !timingSafeEqual(path, expected)
    ) {
      socket.destroy();
      return;
    }
    used = true;
    clearTimeout(timeout);
    sockets.handleUpgrade(request, socket, head, (client) => {
      client.once("close", close);
      client.on("error", close);
      void open()
        .then((source) => {
          upstream = source;
          const queue: Array<{ data: Buffer; binary: boolean }> = [];
          let bytes = 0;
          client.on("message", (data, binary) => {
            if (source.readyState === WebSocket.OPEN)
              source.send(data, { binary });
            else if ((bytes += data.toString().length) < 1024 * 1024)
              queue.push({ data: data as Buffer, binary });
            else close();
          });
          source.on("open", () => {
            for (const item of queue)
              source.send(item.data, { binary: item.binary });
            queue.length = 0;
          });
          source.on("message", (data, binary) => {
            if (client.readyState !== WebSocket.OPEN) return;
            if (client.bufferedAmount > 4 * 1024 * 1024) {
              close();
              return;
            }
            client.send(data, { binary });
          });
          source.on("error", close);
          source.once("close", close);
        })
        .catch(close);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/${token}`,
    close,
  };
}
