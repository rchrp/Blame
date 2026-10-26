import assert from "node:assert/strict";
import test from "node:test";
import { extractWebPage, readWebPage, webSource } from "./web-page-reader.js";
import {
  publicWebUrl,
  publicAddress,
  resolvePublicWebUrl,
} from "./web-research-network.js";
import { withoutNativeWebSearch } from "./web-research-policy.js";
import { createProviderCompatibleFetch } from "./provider-schema-compatibility.js";
import { webResearchTools } from "./web-research-tools.js";
import type { AgentToolContext } from "@cline/sdk";

const text =
  "Mozilla Readability extracts useful article content for a local research agent. ".repeat(
    20,
  );
const html = `<html><head><title>Research article</title></head><body><nav>Navigation</nav><article><h1>Research article</h1><p>${text}</p></article><script>throw new Error('must not execute')</script></body></html>`;

test("Readability extracts plain article text, preserves stable ids across redirects and bounds content", () => {
  const result = extractWebPage(
    html,
    "https://example.org/new",
    "https://example.org/old#section",
  );
  assert.equal(result.status, "read");
  assert.equal(result.source.id, webSource("https://example.org/old").id);
  assert.equal(result.source.finalUrl, "https://example.org/new");
  assert.match(result.content, /Mozilla Readability/);
  assert.doesNotMatch(result.content, /must not execute|Navigation/);
  assert.equal(result.source.publishedAt, undefined);
  const long = extractWebPage(
    html.replace(text, text.repeat(80)),
    "https://example.org/",
  );
  assert.equal(long.content.length, 50_000);
  assert.equal(long.truncated, true);
});

test("renders sparse pages, keeps HTTP mode local, and reports unavailable browser honestly", async () => {
  let rendered = 0;
  const download = async () => ({
    url: "https://example.org/",
    body: '<div id="root">Enable JavaScript</div>',
    contentType: "text/html",
  });
  const render = async () => {
    rendered++;
    return { url: "https://example.org/", html };
  };
  const result = await readWebPage("https://example.org/", {
    download,
    render,
  });
  assert.equal(rendered, 1);
  assert.equal(result.method, "electron");
  assert.equal(result.status, "read");
  const plain = await readWebPage("https://example.org/", {
    download,
    render,
    mode: "http",
  });
  assert.equal(rendered, 1);
  assert.equal(plain.status, "partial");
  const unavailable = await readWebPage("https://example.org/", {
    mode: "browser",
  });
  assert.equal(unavailable.status, "failed");
  assert.match(unavailable.error!, /unavailable/);
  const aborted = new AbortController();
  aborted.abort(new Error("cancelled"));
  await assert.rejects(
    readWebPage("https://example.org/", {
      signal: aborted.signal,
      download: async () => {
        throw aborted.signal.reason;
      },
    }),
    /cancelled/,
  );
});

test("public reading rejects local, mapped IPv6, non-web and authenticated URLs", async () => {
  for (const url of [
    "file:///etc/passwd",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://169.254.169.254/",
    "http://user:pass@example.org/",
    "http://localhost/",
    "https://example.org:3000/",
  ])
    assert.throws(() => publicWebUrl(url));
  for (const ip of [
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:192.168.1.1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("1.1.1.1"), true);
  await assert.rejects(resolvePublicWebUrl("http://localhost/"));
});

test("all provider search formats are removed without removing Blame tools or other capabilities", async () => {
  const tools = [
    { type: "web_search" },
    { type: "web_search_preview" },
    { type: "web_search_20250305", name: "web_search" },
    { type: "function", name: "web_search" },
    { type: "function", function: { name: "web_search" } },
    { googleSearch: {} },
    { google_search: {} },
    { googleSearchRetrieval: {} },
    {
      google_search_retrieval: {},
      functionDeclarations: [{ name: "search_web" }],
    },
    { type: "function", name: "search_web" },
    { type: "function", name: "read_web_page" },
    { type: "image_generation" },
  ];
  const expected = [
    { functionDeclarations: [{ name: "search_web" }] },
    ...tools.slice(-3),
  ];
  assert.deepEqual(withoutNativeWebSearch({ tools }), { tools: expected });
  let captured: unknown;
  const compatible = createProviderCompatibleFetch(async (_url, init) => {
    captured = JSON.parse(String(init?.body));
    return Response.json({});
  });
  await compatible("https://provider.test/v1/messages", {
    method: "POST",
    body: JSON.stringify({ tools }),
  });
  assert.deepEqual(captured, { tools: expected });
  await compatible(
    new Request("https://provider.test/v1/messages", {
      method: "POST",
      body: JSON.stringify({ tools }),
    }),
  );
  assert.deepEqual(captured, { tools: expected });
});

test("search_web uses the authenticated Blame API and returns persisted source metadata", async () => {
  const original = globalThis.fetch;
  const source = webSource("https://example.org/");
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://blame.test/api/v1/web/search");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer test-token",
    );
    assert.equal(JSON.parse(String(init?.body)).query, "Mozilla");
    return Response.json({
      sources: [source],
      resultCount: 1,
      partial: false,
      query: "Mozilla",
      unavailableEngines: [],
      retrievedAt: source.retrievedAt,
    });
  };
  try {
    const tools = webResearchTools({
      url: "https://blame.test/api/v1",
      token: "test-token",
    });
    const result = (await tools[0]!.execute(
      { query: "Mozilla" },
      {} as AgentToolContext,
    )) as { kind: string; sources: unknown[] };
    assert.equal(result.kind, "web_search");
    assert.deepEqual(result.sources, [source]);
    await assert.rejects(
      tools[0]!.execute({ query: "x" }, {} as AgentToolContext),
    );
  } finally {
    globalThis.fetch = original;
  }
});
