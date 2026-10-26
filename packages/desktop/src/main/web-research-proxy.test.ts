import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { researchProxy } from "./web-research-proxy.ts";

function throughProxy(proxy: string, target: string, method = "GET") {
  return new Promise<number>((resolve, reject) => {
    const client = request(proxy, { method, path: target }, (response) => {
      response.resume();
      resolve(response.statusCode!);
    });
    client.on("connect", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode!);
    });
    client.on("error", reject);
    client.end();
  });
}

test("browser proxy blocks private destinations, unsupported protocols and writes", async () => {
  const proxy = await researchProxy(new AbortController().signal);
  try {
    for (const url of [
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://169.254.169.254/",
      "file:///etc/passwd",
      "https://example.org/",
    ]) {
      assert.equal(await throughProxy(proxy.url, url), 403, url);
    }
    assert.equal(
      await throughProxy(proxy.url, "127.0.0.1:443", "CONNECT"),
      403,
    );
    assert.equal(
      await throughProxy(proxy.url, "example.org:22", "CONNECT"),
      403,
    );
    assert.equal(
      await throughProxy(proxy.url, "http://example.org/", "POST"),
      405,
    );
  } finally {
    proxy.close();
  }
});

test("cancellation closes the browser proxy and refuses future connections", async () => {
  const controller = new AbortController();
  const proxy = await researchProxy(controller.signal);
  controller.abort();
  await assert.rejects(throughProxy(proxy.url, "http://127.0.0.1/"));
  await assert.rejects(
    researchProxy(AbortSignal.abort(new Error("cancelled"))),
    /cancelled/,
  );
});
