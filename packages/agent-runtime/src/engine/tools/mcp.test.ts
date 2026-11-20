import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { listMcpOAuthStatuses, clearMcpOAuth } from "./mcp-oauth.js";
import { McpConnections, mcpToolName } from "./mcp.js";
import { enabledMcpServers, updateMcpOAuthState } from "./mcp-settings.js";
import { clientToolPolicy } from "./policy.js";
import { callThroughToolSet } from "./testing.js";
import { testPng } from "./testing-mcp-server.js";

const serverScript = fileURLToPath(
  new URL("./testing-mcp-server.js", import.meta.url),
);

describe("the user's MCP servers", () => {
  let folder: string;
  let settings: string;
  let connections: McpConnections;

  before(async () => {
    folder = await mkdtemp(join(tmpdir(), "blame-mcp-"));
    settings = join(folder, "cline_mcp_settings.json");
    await writeFile(
      settings,
      JSON.stringify({
        mcpServers: {
          "test server": {
            type: "stdio",
            command: process.execPath,
            args: [serverScript],
          },
          off: { type: "stdio", command: "false", disabled: true },
          cloud: {
            type: "stdio",
            command: "false",
            metadata: { blameCloudLocalSetupRequired: true },
          },
          // Blame names its own GitHub tools github__*.
          github: { type: "stdio", command: "false" },
          remote: {
            type: "streamableHttp",
            url: "https://mcp.example.com/mcp",
            disabled: true,
          },
        },
      }),
    );
    connections = new McpConnections({ settingsPath: () => settings });
  });

  after(async () => {
    await connections.close();
    await rm(folder, { recursive: true, force: true });
  });

  it("reads only the enabled servers", async () => {
    assert.deepEqual(
      (await enabledMcpServers(settings)).map((server) => server.name),
      ["test server", "github"],
    );
  });

  it("names tools safely for every provider", () => {
    assert.equal(mcpToolName("notes", "search"), "notes__search");
    assert.match(
      mcpToolName("test server", "echo"),
      /^test_server__echo_[0-9a-f]{8}$/,
    );
    assert.ok(mcpToolName("s", "x".repeat(100)).length <= 64);
  });

  it("turns a stdio server's tools into client tools that call it", async () => {
    const tools = await connections.clientTools();
    const names = tools.map((tool) => tool.name);
    const echo = tools.find((tool) =>
      tool.name.startsWith("test_server__echo"),
    )!;
    assert.equal(names.length, 4, names.join(", "));
    assert.equal(clientToolPolicy(echo).effect, "read_only");
    const leak = tools.find((tool) =>
      tool.name.startsWith("test_server__leak"),
    )!;
    assert.equal(clientToolPolicy(leak).effect, "external");

    const echoed = await callThroughToolSet(tools, echo.name, { text: "hi" });
    assert.deepEqual(echoed.content, [{ type: "text", text: "echo: hi" }]);
    const leaked = await callThroughToolSet(tools, leak.name, {});
    assert.doesNotMatch(JSON.stringify(leaked.content), /ghp_/);
    const picture = tools.find((tool) =>
      tool.name.startsWith("test_server__picture"),
    )!;
    const drawn = await callThroughToolSet(tools, picture.name, {});
    assert.equal(drawn.content[1]!.type, "image");
    assert.deepEqual(drawn.blobs, [{ media_type: "image/png", data: testPng }]);
    const failing = tools.find((tool) =>
      tool.name.startsWith("test_server__fail"),
    )!;
    const failed = await callThroughToolSet(tools, failing.name, {});
    assert.equal(failed.outcome, "failed");
    assert.match(JSON.stringify(failed.content), /It broke/);
  });

  it("keeps the OAuth state next to the server and reports it", async () => {
    assert.deepEqual(await listMcpOAuthStatuses(settings), [
      { serverName: "cloud", supported: false, configured: false },
      { serverName: "github", supported: false, configured: false },
      { serverName: "off", supported: false, configured: false },
      { serverName: "remote", supported: true, configured: false },
      { serverName: "test server", supported: false, configured: false },
    ]);
    await updateMcpOAuthState(
      "remote",
      () => ({
        tokens: { access_token: "at", token_type: "bearer" },
        lastAuthenticatedAt: 5,
      }),
      settings,
    );
    const remote = (await listMcpOAuthStatuses(settings)).find(
      (status) => status.serverName === "remote",
    );
    assert.deepEqual(remote, {
      serverName: "remote",
      supported: true,
      configured: true,
      lastAuthenticatedAt: 5,
    });
    clearMcpOAuth(settings, "remote");
    const file = JSON.parse(await readFile(settings, "utf8"));
    assert.equal(file.mcpServers.remote.oauth, undefined);
    assert.equal(file.mcpServers.remote.url, "https://mcp.example.com/mcp");
  });
});
