// For the engine host's tests: a model server that answers like Anthropic's
// Messages API with scripted replies (as `blame_engine_providers::testing`
// does for the Rust tests), and a stand-in for Blame's API with the routes
// the host calls.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const testModel = "claude-sonnet-4-6";

type Reply =
  | { kind: "text"; pieces: string[] }
  | { kind: "tools"; calls: Array<{ name: string; input: unknown }> }
  /** The beginning of a reply, then silence: a turn that stays in flight. */
  | { kind: "stall"; text: string }
  /** An HTTP error, as the provider sends one. */
  | { kind: "error"; status: number; type: string };

export const text = (...pieces: string[]): Reply => ({ kind: "text", pieces });
export const tools = (
  ...calls: Array<{ name: string; input: unknown }>
): Reply => ({
  kind: "tools",
  calls,
});
export const stall = (text: string): Reply => ({ kind: "stall", text });
export const failure = (status: number, type: string): Reply => ({
  kind: "error",
  status,
  type,
});

function sse(events: Array<[string, unknown]>) {
  return events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

function start(id: string): [string, unknown] {
  return [
    "message_start",
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: testModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  ];
}

function end(stop: string): Array<[string, unknown]> {
  return [
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
}

function textEvents(pieces: string[]): Array<[string, unknown]> {
  return [
    start("msg_text"),
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ],
    ...pieces.map((piece): [string, unknown] => [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: piece },
      },
    ]),
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ...end("end_turn"),
  ];
}

function toolEvents(
  calls: Array<{ name: string; input: unknown }>,
): Array<[string, unknown]> {
  const events: Array<[string, unknown]> = [start("msg_tool")];
  calls.forEach(({ name, input }, index) => {
    events.push(
      [
        "content_block_start",
        {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: `toolu_${index}`,
            name,
            input: {},
          },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(input),
          },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index }],
    );
  });
  return [...events, ...end("tool_use")];
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export class MockModel {
  readonly requests: Array<{ path: string; body: Record<string, unknown> }> =
    [];
  private readonly replies: Reply[];
  private readonly server: Server;
  private readonly stalled = new Set<() => void>();
  base = "";

  private constructor(replies: Reply[]) {
    this.replies = [...replies];
    this.server = createServer((request, response) => {
      void body(request).then((raw) => {
        this.requests.push({
          path: request.url ?? "",
          body: JSON.parse(raw.toString() || "{}"),
        });
        const reply = this.replies.shift();
        if (!reply) {
          response.writeHead(500).end();
          return;
        }
        if (reply.kind === "error") {
          response
            .writeHead(reply.status, { "content-type": "application/json" })
            .end(
              JSON.stringify({
                type: "error",
                error: { type: reply.type, message: `Scripted ${reply.type}` },
              }),
            );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (reply.kind === "text")
          return response.end(sse(textEvents(reply.pieces)));
        if (reply.kind === "tools")
          return response.end(sse(toolEvents(reply.calls)));
        const full = sse(textEvents([reply.text]));
        response.write(
          full.slice(0, full.indexOf("event: content_block_stop")),
        );
        const close = () => response.destroy();
        this.stalled.add(close);
        response.on("close", () => this.stalled.delete(close));
      });
    });
  }

  static async start(replies: Reply[]) {
    const model = new MockModel(replies);
    model.base = await listen(model.server);
    return model;
  }

  /** Queues more replies. */
  script(...replies: Reply[]) {
    this.replies.push(...replies);
  }

  /** The `messages` the model received, as one JSON text per request. */
  sent() {
    return this.requests.map((request) =>
      JSON.stringify(request.body.messages),
    );
  }

  async close() {
    for (const close of this.stalled) close();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/** Blame's API as far as the engine host uses it. */
export class FakeApi {
  readonly logs = new Map<string, unknown[]>();
  readonly blobs = new Map<string, { mediaType: string; bytes: Buffer }>();
  readonly searches: string[] = [];
  /** Project memories the API answers (`/projects/:id/agent-memories`). */
  memories: unknown[] = [];
  private readonly server: Server;
  url = "";
  token = "user-token";
  modelBase = "";

  private constructor() {
    this.server = createServer((request, response) => {
      void body(request).then((raw) => {
        const json = (status: number, value: unknown) =>
          response
            .writeHead(status, { "content-type": "application/json" })
            .end(JSON.stringify(value));
        if (request.headers.authorization !== `Bearer ${this.token}`)
          return json(401, { message: "Unauthorized" });
        const url = new URL(request.url ?? "/", "http://api");
        const path = url.pathname.replace(/^\/api\/v1/, "");
        const records = path.match(/^\/engine\/sessions\/([^/]+)\/records$/);
        const blob = path.match(/^\/engine\/blobs\/([0-9a-f]{64})$/);
        if (records && request.method === "POST") {
          const log = this.logs.get(records[1]!) ?? [];
          const pushed = (
            JSON.parse(raw.toString()) as { records: Array<{ seq: number }> }
          ).records;
          for (const record of pushed)
            if (record.seq === log.length + 1) log.push(record);
          this.logs.set(records[1]!, log);
          return json(200, { acked: log.length });
        }
        if (records && request.method === "GET") {
          const after = Number(url.searchParams.get("after") ?? 0);
          const log = (this.logs.get(records[1]!) ?? []) as Array<{
            seq: number;
          }>;
          return json(200, {
            records: log.filter((r) => r.seq > after),
            head: log.length,
            hasMore: false,
          });
        }
        if (blob && request.method === "PUT") {
          this.blobs.set(blob[1]!, {
            mediaType: url.searchParams.get("mediaType") ?? "",
            bytes: raw,
          });
          return json(201, { sha256: blob[1], size: raw.length });
        }
        if (blob && request.method === "GET") {
          const held = this.blobs.get(blob[1]!);
          if (!held) return json(404, { code: "E_ENGINE_BLOB_NOT_FOUND" });
          return response
            .writeHead(200, { "content-type": "application/octet-stream" })
            .end(held.bytes);
        }
        if (path === "/providers/credentials/resolve") {
          const { providerId } = JSON.parse(raw.toString()) as {
            providerId: string;
          };
          if (providerId !== "anthropic")
            return json(404, { message: "No credential" });
          return json(200, {
            data: {
              id: "c1",
              providerId,
              label: "Default",
              apiKey: "sk-test",
              baseUrl: this.modelBase,
            },
          });
        }
        const memories = path.match(/^\/projects\/([^/]+)\/agent-memories$/);
        if (memories && request.method === "GET")
          return json(200, { data: this.memories });
        if (path === "/web/search") {
          const { query } = JSON.parse(raw.toString()) as { query: string };
          this.searches.push(query);
          return json(200, {
            data: {
              query,
              sources: [
                {
                  id: "web_1",
                  url: "https://example.com/engine",
                  title: "The engine",
                  domain: "example.com",
                  snippet: "It runs agents.",
                  retrievedAt: "2026-11-20T00:00:00Z",
                },
              ],
              resultCount: 1,
              partial: false,
              unavailableEngines: [],
              retrievedAt: "2026-11-20T00:00:00Z",
            },
          });
        }
        json(404, { message: `No route ${request.method} ${path}` });
      });
    });
  }

  static async start() {
    const api = new FakeApi();
    api.url = `${await listen(api.server)}/api/v1`;
    return api;
  }

  connection() {
    return { url: this.url, token: this.token };
  }

  async close() {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
