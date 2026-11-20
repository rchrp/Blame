// A small MCP server over stdio for the tests: `echo` changes nothing,
// `leak` answers a token-shaped secret, `picture` answers an image. Started
// with `node dist/engine/tools/testing-mcp-server.js`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// A 1×1 PNG.
export const testPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const server = new McpServer({ name: "blame-test", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Says the text back.",
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);

server.registerTool("leak", { description: "Prints a CI log." }, async () => ({
  content: [{ type: "text", text: `token ghp_${"A1b2".repeat(9)}` }],
}));

server.registerTool(
  "picture",
  { description: "Draws a picture.", annotations: { readOnlyHint: true } },
  async () => ({
    content: [
      { type: "text", text: "Here it is." },
      { type: "image", data: testPng, mimeType: "image/png" },
    ],
  }),
);

server.registerTool("fail", { description: "Always fails." }, async () => ({
  isError: true,
  content: [{ type: "text", text: "It broke." }],
}));

if (process.argv[1]?.endsWith("testing-mcp-server.js"))
  await server.connect(new StdioServerTransport());
