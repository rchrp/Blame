import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "@cline/llms";

import { lightSemanticHarnessTools } from "./harness/light-tools.js";
import { appendProductionConfig } from "./production.js";

import {
  createProviderCompatibleFetch,
  normalizeJsonSchema,
  normalizeProviderPayload,
} from "./provider-schema-compatibility.js";

test("removes provider-incompatible patterns from nested JSON schemas", () => {
  const schema = {
    type: "object",
    properties: {
      email: {
        anyOf: [
          {
            type: "string",
            pattern: "^(?!\\.)(?!.*\\.\\.)[^@]+$",
          },
        ],
      },
      slug: { type: "string", pattern: "^[a-z0-9-]+$" },
    },
  };

  const normalized = normalizeJsonSchema(schema) as typeof schema;

  assert.equal(normalized.properties.email.anyOf[0].pattern, undefined);
  assert.equal(normalized.properties.slug.pattern, "^[a-z0-9-]+$");
});

test("normalizes schemas without changing ordinary pattern fields", () => {
  const payload = {
    messages: [{ role: "user", content: { pattern: "^(?!hidden)" } }],
    tools: [
      {
        type: "function",
        function: {
          name: "assign_domain",
          parameters: {
            type: "object",
            properties: {
              value: { type: "string", pattern: "(?<=domain)name" },
            },
          },
        },
      },
    ],
  };

  const normalized = normalizeProviderPayload(payload) as typeof payload;

  assert.equal(normalized.messages[0].content.pattern, "^(?!hidden)");
  assert.equal(
    normalized.tools[0].function.parameters.properties.value.pattern,
    undefined,
  );
});

test("normalizes a JSON request body immediately before sending", async () => {
  let body: BodyInit | null | undefined;
  const request: typeof fetch = async (_input, init) => {
    body = init?.body;
    return new Response(null, { status: 204 });
  };
  const compatibleFetch = createProviderCompatibleFetch(request);

  await compatibleFetch("https://provider.test", {
    method: "POST",
    body: JSON.stringify({
      input_schema: {
        type: "object",
        properties: { value: { type: "string", pattern: "a++" } },
      },
    }),
  });

  assert.equal(typeof body, "string");
  assert.deepEqual(JSON.parse(body as string), {
    input_schema: {
      type: "object",
      properties: { value: { type: "string" } },
    },
  });
});

test("simplifies constrained tool schemas for local providers", async () => {
  let body: BodyInit | null | undefined;
  const request: typeof fetch = async (_input, init) => {
    body = init?.body;
    return new Response(null, { status: 204 });
  };
  const compatibleFetch = createProviderCompatibleFetch(request);

  await compatibleFetch("http://127.0.0.1:8080/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      tools: [
        {
          type: "function",
          function: {
            name: "run_task",
            parameters: {
              type: "object",
              properties: {
                timeout_ms: {
                  type: "integer",
                  minimum: 1_000,
                  maximum: 900_000,
                },
                symbols: {
                  type: "array",
                  maxItems: 100,
                  items: {
                    type: "string",
                    minLength: 1,
                    maxLength: 4_096,
                    pattern: "^sym:\\/\\/",
                  },
                },
              },
              required: ["timeout_ms"],
              additionalProperties: false,
            },
          },
        },
      ],
    }),
  });

  assert.deepEqual(JSON.parse(body as string), {
    tools: [
      {
        type: "function",
        function: {
          name: "run_task",
          parameters: {
            type: "object",
            properties: {
              timeout_ms: { type: "integer" },
              symbols: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["timeout_ms"],
            additionalProperties: false,
          },
        },
      },
    ],
  });
});

test("preserves supported schema constraints for remote providers", async () => {
  let body: BodyInit | null | undefined;
  const request: typeof fetch = async (_input, init) => {
    body = init?.body;
    return new Response(null, { status: 204 });
  };
  const compatibleFetch = createProviderCompatibleFetch(request);
  const payload = {
    tools: [
      {
        type: "function",
        function: {
          name: "read_range",
          parameters: {
            type: "object",
            properties: {
              offset: { type: "integer", minimum: 0, maximum: 20_000 },
              reference: {
                type: "string",
                minLength: 1,
                maxLength: 4_096,
                pattern: "^sym:\\/\\/",
              },
            },
          },
        },
      },
    ],
  };

  await compatibleFetch("https://provider.test/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  assert.deepEqual(JSON.parse(body as string), payload);
});

test("preserves optional Responses arguments with explicit non-strict tools", async () => {
  const parameters = {
    type: "object",
    properties: { target: { type: "string" }, range: { type: "object" } },
    required: ["target"],
  };
  const tool = { type: "function", name: "read_code", parameters };
  const payload = { tools: [tool], input: [{ role: "user", content: "Read" }] };

  const normalized = await captureCompatiblePayload(
    "https://provider.test/v1/responses",
    payload,
  );

  assert.deepEqual(normalized, {
    ...payload,
    tools: [{ ...tool, strict: false }],
  });
  assert.equal("strict" in tool, false);
});

test("preserves explicit strict settings, builtins and nested function data", async () => {
  const tools = [
    ...[true, false, null].map((strict) => ({
      type: "function",
      name: "read",
      strict,
    })),
    { type: "web_search_preview" },
    { type: "function", function: { name: "chat_tool", parameters: {} } },
    null,
  ];
  const payload = {
    tools,
    input: [{ tools: [{ type: "function", name: "ordinary_data" }] }],
  };

  assert.deepEqual(
    await captureCompatiblePayload("https://provider.test/responses", payload),
    payload,
  );
});

test("limits non-strict defaults to the Responses creation route", async () => {
  const payload = {
    tools: [{ type: "function", name: "read", parameters: {} }],
  };
  for (const route of [
    "/chat/completions",
    "/messages",
    "/responses/id",
    "/responses/tokenize",
  ]) {
    assert.deepEqual(
      await captureCompatiblePayload(
        `https://provider.test/v1${route}`,
        payload,
      ),
      payload,
    );
  }
  assert.deepEqual(normalizeProviderPayload(payload), payload);
});

test("recognizes Responses URLs and Request inputs with queries and trailing slashes", async () => {
  const payload = { tools: [{ type: "function", name: "read" }] };
  for (const input of [
    new URL("https://provider.test/custom/responses/?api-version=2026-01-01"),
    new Request("https://provider.test/responses?version=1"),
  ]) {
    assert.deepEqual(await captureCompatiblePayload(input, payload), {
      tools: [{ type: "function", name: "read", strict: false }],
    });
  }
});

test("keeps unreadable request bodies untouched", async () => {
  const requests: (RequestInit | undefined)[] = [];
  const request: typeof fetch = async (_input, init) => {
    requests.push(init);
    return new Response(null, { status: 204 });
  };
  const compatibleFetch = createProviderCompatibleFetch(request);
  const invalidJson = { method: "POST", body: "{invalid" };
  const binaryBody = { method: "POST", body: new Uint8Array([123]) };

  await compatibleFetch("https://provider.test/responses", invalidJson);
  await compatibleFetch("https://provider.test/responses", binaryBody);
  await compatibleFetch("https://provider.test/responses");

  assert.equal(requests[0], invalidJson);
  assert.equal(requests[1], binaryBody);
  assert.equal(requests[2], undefined);
});

test("sends non-strict harness functions at the real Codex SDK boundary", async (context) => {
  context.mock.method(globalThis, "fetch", async () => {
    throw Error("Unexpected network fetch");
  });
  const body = await captureSdkResponsesRequest();
  const tools = body.tools as {
    type: string;
    name: string;
    strict?: boolean;
    parameters: { required: string[]; properties: Record<string, unknown> };
  }[];
  assert.equal(tools.length, 4);
  assert.ok(
    tools.every((tool) => tool.type === "function" && tool.strict === false),
  );
  const read = tools.find((tool) => tool.name === "read_code");
  assert.ok(read);
  assert.deepEqual(read.parameters.required, ["target"]);
  assert.ok("range" in read.parameters.properties);
  const edit = tools.find((tool) => tool.name === "edit_code");
  assert.ok(edit);
  const operations = edit.parameters.properties.operations as {
    items: { oneOf: Array<{ properties: Record<string, { const?: string }>; required: string[] }> };
  };
  const patch = operations.items.oneOf.find((item) => item.properties.kind?.const === "patch");
  assert.ok(patch);
  assert.ok("target" in patch.properties);
  assert.ok(!patch.required.includes("target"));
  const run = tools.find((tool) => tool.name === "run_task");
  assert.ok(run);
  const variants = (run.parameters as unknown as {
    oneOf: Array<{
      properties: Record<string, { const?: string }>;
      required: string[];
    }>;
  }).oneOf;
  const inspect = variants.find(
    (item) => item.properties.kind?.const === "inspect",
  );
  assert.ok(inspect);
  assert.ok(inspect.required.includes("run"));
  assert.ok(!inspect.required.includes("cursor"));
});

async function captureCompatiblePayload(
  input: Parameters<typeof fetch>[0],
  payload: unknown,
) {
  let body: BodyInit | null | undefined;
  const request: typeof fetch = async (_input, init) => {
    body = init?.body;
    return new Response(null, { status: 204 });
  };
  await createProviderCompatibleFetch(request)(input, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  assert.equal(typeof body, "string");
  return JSON.parse(body as string);
}

test("symbolic analysis exposure is optional at the actual Codex SDK schema boundary", async (context) => {
  context.mock.method(globalThis, "fetch", async () => {
    throw Error("Unexpected network fetch");
  });
  const previous = process.env.BLAME_AGENT_SYMBOLIC_ANALYSIS;
  try {
    process.env.BLAME_AGENT_SYMBOLIC_ANALYSIS = "false";
    const ordinary = await captureSdkResponsesRequest();
    process.env.BLAME_AGENT_SYMBOLIC_ANALYSIS = "true";
    const experimental = await captureSdkResponsesRequest();
    type Tool = { name: string; strict: boolean; description: string;
      parameters: { oneOf: { properties: { kind: { const: string } }; required: string[] }[] } };
    const off = ordinary.tools as Tool[], on = experimental.tools as Tool[];
    assert.deepEqual(on.map(({ name }) => name), off.map(({ name }) => name));
    for (const tool of on.filter(({ name }) => name !== "run_task"))
      assert.deepEqual(tool, off.find(({ name }) => name === tool.name));
    const runOff = off.find(({ name }) => name === "run_task")!;
    const runOn = on.find(({ name }) => name === "run_task")!;
    assert.equal(runOn.strict, false);
    assert.equal(runOff.parameters.oneOf.some(({ properties }) => properties.kind.const === "analyze"), false);
    const analyze = runOn.parameters.oneOf.find(({ properties }) => properties.kind.const === "analyze");
    assert.ok(analyze);
    assert.deepEqual(analyze.required, ["kind", "target", "inputs", "assertion"]);
    assert.deepEqual(runOn.parameters.oneOf.filter(({ properties }) => properties.kind.const !== "analyze"), runOff.parameters.oneOf);
    assert.match(runOn.description, /bounded|counterexamples/u);
    assert.ok(!runOff.description.includes("Z3"));
  } finally {
    if (previous === undefined) delete process.env.BLAME_AGENT_SYMBOLIC_ANALYSIS;
    else process.env.BLAME_AGENT_SYMBOLIC_ANALYSIS = previous;
  }
});

async function captureSdkResponsesRequest() {
  const { bodies, request } = sdkFetchCapture();
  const handler = offlineCodexHandler(request);
  const tools = lightSemanticHarnessTools("/offline-workspace", {
    executor: async () => {
      throw Error("Tool execution forbidden");
    },
  });
  try {
    for await (const part of handler.createMessage(
      "Inspect schemas.",
      [{ role: "user", content: "Read a symbol." }],
      tools,
    )) {
      assert.ok(part.type === "error" || part.type === "done");
    }
  } catch (error) {
    assert.match(String(error), /Offline capture/);
  }
  assert.equal(bodies.length, 1);
  return JSON.parse(bodies[0]);
}

function sdkFetchCapture() {
  const bodies: string[] = [];
  const request: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://offline.invalid/responses");
    assert.equal(typeof init?.body, "string");
    bodies.push(init!.body as string);
    return new Response(
      '{"error":{"message":"Offline capture","type":"invalid_request_error"}}',
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    );
  };
  return { bodies, request };
}

function offlineCodexHandler(request: typeof fetch, maxOutputTokens?: number) {
  return createHandler({
    providerId: "openai-codex",
    modelId: "gpt-5.6-luna",
    apiKey: "offline-placeholder",
    accessToken: "offline-placeholder",
    baseUrl: "https://offline.invalid",
    fetch: createProviderCompatibleFetch(request),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  });
}

test("the legacy Codex handler serializes an explicit output cap", async () => {
  const { bodies, request } = sdkFetchCapture();
  const config = appendProductionConfig({ providerId: "openai-codex", modelId: "gpt-5.6-luna", maxTokensPerTurn: 128_000 },
    { requestMaxOutputTokens: 8192 });
  // Invoke this handler explicitly. This tests its serializer, not the complete
  // SDK start/model-selection path or the limit in the final transmitted request.
  const handler = offlineCodexHandler(request, config.maxTokensPerTurn);
  try { for await (const part of handler.createMessage("Inspect.", [{ role: "user", content: "Read a symbol." }]))
    assert.ok(part.type === "error" || part.type === "done");
  } catch (error) { assert.match(String(error), /Offline capture/u); }
  assert.equal(bodies.length, 1);
  assert.equal(JSON.parse(bodies[0]!).max_output_tokens, 8192);
});
