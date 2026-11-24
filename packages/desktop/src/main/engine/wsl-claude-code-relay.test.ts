import assert from "node:assert/strict";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { createServer, request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { text } from "node:stream/consumers";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { WslClaudeCodeRelay } from "./wsl-claude-code-relay.ts";

function post(socketPath: string, key: string, body = "") {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(
      {
        socketPath,
        method: "POST",
        path: "/v1/messages",
        headers: {
          "x-api-key": key,
          "content-length": Buffer.byteLength(body),
        },
        agent: false,
      },
      resolve,
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test(
  "the WSL relay carries concurrent authenticated streams and cancellation",
  {
    skip:
      process.platform === "win32" &&
      "the local guest stand-in needs a Unix socket",
    timeout: 10_000,
  },
  async (t) => {
    const firstFrame = "event: message_start\ndata: {}\n\n";
    const { promise: cancelled, resolve: onCancel } =
      Promise.withResolvers<void>();
    const bridge = createServer(async (req, res) => {
      if (
        req.url !== "/v1/messages" ||
        req.headers["x-api-key"] !== "signed-key"
      ) {
        res.writeHead(401).end();
        return;
      }
      const body = await text(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (body === "keep streaming") {
        res.once("close", onCancel);
        res.write(firstFrame);
        return;
      }
      res.end(`data: ${body.length}\n\n`);
    });
    t.after(() => {
      bridge.closeAllConnections();
      bridge.close();
    });
    bridge.listen(0, "127.0.0.1");
    await once(bridge, "listening");
    const baseUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}/v1`;

    // Stands in for wsl.exe by running the very same guest command locally.
    const relay = new WslClaudeCodeRelay(process.execPath, []);
    t.after(() => relay.close());
    assert.throws(() => relay.socket("http://192.0.2.1:4000/v1"), /loopback/);
    const [path, samePath] = await Promise.all([
      relay.socket(baseUrl),
      relay.socket(baseUrl),
    ]);
    assert.equal(path, samePath);
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);

    const streaming = await post(path, "signed-key", "keep streaming");
    assert.equal(streaming.headers["content-type"], "text/event-stream");
    const [first] = await once(streaming, "data");
    assert.equal(first.toString(), firstFrame);
    // Leave the first request open while sending a body larger than the pipe buffers.
    const result = await post(path, "signed-key", "a".repeat(512 * 1024));
    assert.equal(await text(result), "data: 524288\n\n");
    const denied = await post(path, "invalid");
    assert.equal(denied.statusCode, 401);
    await text(denied);

    streaming.destroy();
    await cancelled;
    relay.close();
    while (await stat(path).catch(() => undefined))
      await setTimeout(10, undefined, { signal: t.signal });
    const restarted = await relay.socket(baseUrl);
    assert.notEqual(restarted, path);
    assert.equal(
      await text(await post(restarted, "signed-key")),
      "data: 0\n\n",
    );
  },
);
