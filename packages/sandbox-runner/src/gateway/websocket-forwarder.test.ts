import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import net, { type AddressInfo } from "node:net";
import test from "node:test";
import { forwardWebSocket } from "./websocket-forwarder.js";

const publicOrigin =
  "https://0123456789abcdef0123456789abcdef01234567.preview.blame.so";

async function upgradeThroughGateway(target: string, origin: string) {
  const upstream = net.createServer((socket) => {
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (!received.includes("\r\n\r\n")) return;
      socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
      upstreamRequest.resolve(received);
    });
  });
  const upstreamRequest = deferred<string>();
  await listen(upstream);
  const gateway = createHttpServer();
  gateway.on("upgrade", (request, socket, head) =>
    forwardWebSocket(request, socket, head, {
      sessionId: "session",
      routeId: "route",
      serviceId: "web",
      endpointId: "web",
      generation: 1,
      logicalPort: 3000,
      sandboxPort: 43001,
      targetHost: "127.0.0.1",
      targetPort: (upstream.address() as AddressInfo).port,
    }),
  );
  await listen(gateway);
  try {
    const client = net.connect(
      (gateway.address() as AddressInfo).port,
      "127.0.0.1",
    );
    client.write(
      [
        `GET ${target} HTTP/1.1`,
        "host: 0123456789abcdef.vercel.run",
        "connection: Upgrade",
        "upgrade: websocket",
        "sec-websocket-version: 13",
        "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==",
        `origin: ${origin}`,
        "sec-fetch-site: same-origin",
        "",
        "",
      ].join("\r\n"),
    );
    client.on("error", () => undefined);
    const received = await upstreamRequest.promise;
    client.destroy();
    return received.toLowerCase();
  } finally {
    gateway.close();
    upstream.close();
  }
}

test("a WebSocket to the Next.js HMR endpoint reaches the service from localhost", async () => {
  const received = await upgradeThroughGateway(
    "/_next/hmr?id=abc",
    publicOrigin,
  );
  assert.match(received, /^get \/_next\/hmr\?id=abc http\/1\.1\r\n/);
  assert.match(received, /\r\nhost: localhost:3000\r\n/);
  assert.match(received, /\r\norigin: http:\/\/localhost:3000\r\n/);
  assert.doesNotMatch(received, /preview\.blame\.so/);
});

test("a WebSocket of the application keeps the public Origin", async () => {
  const received = await upgradeThroughGateway("/socket", publicOrigin);
  assert.match(received, /\r\nhost: localhost:3000\r\n/);
  assert.match(received, new RegExp(`\\r\\norigin: ${publicOrigin}\\r\\n`));
});

function listen(server: net.Server) {
  return new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
