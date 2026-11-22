import assert from "node:assert/strict";
import test from "node:test";
import {
  forwardedRequestHeaders,
  gatewayRequestTarget,
} from "./http-forwarder.js";

test("keeps gateway requests on their declared upstream", () => {
  assert.equal(gatewayRequestTarget("/api/items?q=1"), "/api/items?q=1");
  assert.throws(
    () => gatewayRequestTarget("http://169.254.169.254/latest"),
    /Invalid/,
  );
  assert.throws(
    () => gatewayRequestTarget("//169.254.169.254/latest"),
    /Invalid/,
  );
  assert.throws(
    () => gatewayRequestTarget("/\\169.254.169.254/latest"),
    /Invalid/,
  );
});

test("preserves logical cross-origin CORS headers", () => {
  const headers = forwardedRequestHeaders(
    {
      host: "provider.vercel.run",
      origin: "http://localhost:3000",
      referer: "http://localhost:3000/dashboard",
      "x-blame-preview-capability": "remove-me",
    },
    {
      sessionId: "session",
      routeId: "route",
      serviceId: "api",
      endpointId: "api",
      generation: 1,
      logicalPort: 3333,
      sandboxPort: 43001,
      targetHost: "127.0.0.1",
      targetPort: 44001,
    },
  );
  assert.equal(headers.host, "localhost:3333");
  assert.equal(headers.origin, "http://localhost:3000");
  assert.equal(headers.referer, "http://localhost:3000/dashboard");
  assert.equal(headers["x-blame-preview-capability"], undefined);
});

const gatewayRoute = {
  sessionId: "session",
  routeId: "route",
  serviceId: "web",
  endpointId: "web",
  generation: 1,
  logicalPort: 3000,
  sandboxPort: 43001,
  targetHost: "127.0.0.1",
  targetPort: 44001,
};
const publicOrigin =
  "https://0123456789abcdef0123456789abcdef01234567.preview.blame.so";

test("presents the Next.js dev resources to the service as localhost", () => {
  for (const target of [
    "/_next/hmr?id=abc",
    "/_next/webpack-hmr",
    "/__nextjs_original-stack-frames",
    "/base/_next/hmr",
  ]) {
    const headers = forwardedRequestHeaders(
      { host: "provider.vercel.run", origin: publicOrigin },
      gatewayRoute,
      target,
    );
    assert.equal(headers.origin, "http://localhost:3000", target);
    assert.equal(headers.host, "localhost:3000", target);
  }
});

test("keeps the browser's Origin for the application's own routes", () => {
  for (const target of ["/", "/api/items", "/login?next=/_dashboard"]) {
    const headers = forwardedRequestHeaders(
      { host: "provider.vercel.run", origin: publicOrigin },
      gatewayRoute,
      target,
    );
    assert.equal(headers.origin, publicOrigin, target);
  }
  assert.equal(
    forwardedRequestHeaders({ origin: publicOrigin }, gatewayRoute).origin,
    publicOrigin,
  );
});

test("leaves Next.js dev resources of other sites to Next.js", () => {
  for (const site of ["cross-site", "same-site"]) {
    const headers = forwardedRequestHeaders(
      { origin: "https://evil.example", "sec-fetch-site": site },
      gatewayRoute,
      "/_next/hmr",
    );
    assert.equal(headers.origin, "https://evil.example", site);
  }
  for (const site of ["same-origin", "none", undefined]) {
    const headers = forwardedRequestHeaders(
      { origin: publicOrigin, "sec-fetch-site": site },
      gatewayRoute,
      "/_next/hmr",
    );
    assert.equal(headers.origin, "http://localhost:3000", String(site));
  }
});

test("does not invent an Origin nor rewrite an opaque one", () => {
  const none = forwardedRequestHeaders({}, gatewayRoute, "/_next/hmr");
  assert.equal("origin" in none, false);
  const opaque = forwardedRequestHeaders(
    { origin: "null" },
    gatewayRoute,
    "/_next/hmr",
  );
  assert.equal(opaque.origin, "null");
  const local = forwardedRequestHeaders(
    { origin: "http://localhost:4000" },
    gatewayRoute,
    "/_next/hmr",
  );
  assert.equal(local.origin, "http://localhost:4000");
});
