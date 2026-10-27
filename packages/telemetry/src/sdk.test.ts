import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  getBlameTelemetry,
  initializeBlameTelemetry,
  shutdownBlameTelemetry,
} from "./sdk.js";

test("the SDK exports traces, logs and metrics without sensitive attributes", async () => {
  const received = new Map<string, Buffer>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.set(request.url!, Buffer.concat(chunks));
    response.setHeader("content-type", "application/x-protobuf");
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const config = initializeBlameTelemetry({
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      environment: {},
      serviceName: "sdk-test",
      serviceVersion: "test",
    });
    assert.equal(config.enabled, true);
    const telemetry = getBlameTelemetry();
    const attributes = {
      "blame.operation.status": "succeeded",
      password: "never-export-this",
    };
    telemetry.startSpan("migration.trace", { attributes }).end();
    telemetry.log("info", "migration.log", attributes);
    telemetry.count("migration.counter", 1, attributes);
    await shutdownBlameTelemetry();
    for (const signal of ["traces", "logs", "metrics"]) {
      const payload = received.get(`/v1/${signal}`);
      assert.ok(payload?.length, `missing ${signal} export`);
      assert.equal(payload.includes("never-export-this"), false);
      assert.ok(
        payload.includes(
          `migration.${signal === "traces" ? "trace" : signal === "logs" ? "log" : "counter"}`,
        ),
      );
    }
  } finally {
    await shutdownBlameTelemetry();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
