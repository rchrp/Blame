// A story's client tools on the real `blame-engine`, with a scripted model
// server: a preview tool answered by a (faked) desktop service, a DevTools
// screenshot whose image reaches the model and is still there when the
// conversation reopens in a new engine, and an MCP tool of the user's own
// server (a local stdio test server). The tool set is wired as the engine
// host wires it: its policy, guards and blob storage.
// Skipped when the engine binary is not built (`cargo build -p blame-engine`).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EngineClient,
  localEngine,
  type SessionConfig,
  type SessionRecord,
  type ToolSpec,
} from "@blame/engine-client";
import { currentWorkspaceRevisionState } from "../harness/workspace-revisions.js";
import type { DesktopServices } from "./desktop-services.js";
import { MockModel, testModel, text, tools } from "./testing.js";
import { ToolSet } from "./tool.js";
import {
  ConversationTools,
  McpConnections,
  clientToolGuards,
  clientToolPolicy,
} from "./tools/index.js";
import { testPng } from "./tools/testing-mcp-server.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const binary =
  process.env.BLAME_ENGINE_BIN ?? join(root, "target/debug/blame-engine");
const mcpServer = fileURLToPath(
  new URL("./tools/testing-mcp-server.js", import.meta.url),
);
const session = "story-0193f5d2-7a1b-7c3e-9f00-000000000042";
const screenshotId = "c".repeat(64);

describe(
  "a story's client tools on the engine",
  { skip: !existsSync(binary) && "no engine binary" },
  () => {
    let model: MockModel;
    let workspace: string;
    let dataDir: string;
    let settingsPath: string;
    const desktopCalls: Array<{ method: string; input: unknown }> = [];
    const clients: EngineClient[] = [];
    const connections: McpConnections[] = [];

    // What the main process answers, for a ready preview.
    async function desktop(): Promise<DesktopServices> {
      const revisions = await currentWorkspaceRevisionState(workspace);
      const record = (method: string, input: unknown) => {
        const { signal, ...rest } = input as { signal?: AbortSignal };
        void signal;
        desktopCalls.push({ method, input: rest });
      };
      return {
        previewDevtools: async (input) => {
          record("previewDevtools", input);
          return {
            available: true,
            loading: false,
            message: "Ready",
            reason: "PREVIEW_BROWSER_READY",
            readiness: {
              browser_ready: true,
              container_ready: true,
              application_ready: true,
            },
            revisions,
            status: "ready",
          };
        },
        previewDevtoolsTools: async (input) => {
          record("previewDevtoolsTools", input);
          return [
            {
              name: "take_screenshot",
              description: "Takes a screenshot of the page.",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ];
        },
        previewDevtoolsCall: async (input) => {
          record("previewDevtoolsCall", input);
          return {
            content: [
              { type: "image", data: testPng, mimeType: "image/png" },
              {
                type: "text",
                text: `Screenshot saved as screenshot:${screenshotId}.`,
              },
            ],
            _meta: {
              blameScreenshots: [
                {
                  id: screenshotId,
                  mimeType: "image/png",
                  width: 1,
                  height: 1,
                  pageUrl: "http://localhost:3000/",
                },
              ],
            },
          };
        },
      };
    }

    // An engine and its tool set, as the engine host starts them.
    async function start() {
      const mcp = new McpConnections({ settingsPath: () => settingsPath });
      connections.push(mcp);
      // The tool set stores images through the engine it answers.
      const engine: { client?: EngineClient } = {};
      const toolSet = new ToolSet([], {
        policy: clientToolPolicy,
        guards: clientToolGuards,
        putBlob: (params, signal) => engine.client!.putBlob(params, { signal }),
      });
      const client = await EngineClient.start(
        localEngine(
          binary,
          { dataDir },
          {
            ...process.env,
            BLAME_ENGINE_LOG: "warn",
          },
        ),
        {
          clientName: "blame-test",
          clientVersion: "test",
          handlers: {
            tool: (params, context) => toolSet.handle(params, context),
            credential: () => ({
              type: "api_key",
              key: "sk-test",
              base_url: model.base,
            }),
            approval: () => ({ decision: "approved" }),
          },
        },
      );
      engine.client = client;
      clients.push(client);
      const conversations = new ConversationTools(toolSet, {
        ...(await desktop()),
        connection: () => undefined,
        mcp,
      });
      const listed = await conversations.ensure({
        session,
        kind: "story",
        workspaceRoot: workspace,
        preview: { scope: "story:42", worktree: workspace },
        skills: false,
      });
      return { client, ...listed };
    }

    const config = (specs: ToolSpec[]): SessionConfig => ({
      purpose: "story",
      workspace_root: workspace,
      model: { provider: "anthropic", model: testModel },
      system_prompt: "You build the story.",
      engine_tools: [],
      client_tools: specs,
      tool_options: {},
      limits: {},
      checkpoints: false,
    });

    async function records(client: EngineClient) {
      const all: SessionRecord[] = [];
      for (;;) {
        const page = await client.readRecords({
          session,
          after: all.at(-1)?.seq ?? 0,
          limit: 1000,
        });
        all.push(...page.records);
        if (!page.records.length || all.length >= page.head) return all;
      }
    }

    async function turn(client: EngineClient, message: string) {
      const ended = (await records(client)).filter(
        (record) => record.type === "turn_ended",
      ).length;
      await client.sendMessage({
        session,
        input: [{ type: "text", text: message }],
        delivery: "turn",
      });
      const deadline = Date.now() + 30_000;
      for (;;) {
        const now = (await records(client)).filter(
          (record) => record.type === "turn_ended",
        ).length;
        if (now > ended) return;
        if (Date.now() > deadline)
          throw new Error(`Timed out waiting for "${message}"`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    before(async () => {
      model = await MockModel.start([]);
      workspace = mkdtempSync(join(tmpdir(), "blame-tools-workspace-"));
      dataDir = mkdtempSync(join(tmpdir(), "blame-tools-data-"));
      settingsPath = join(dataDir, "mcp_settings.json");
      writeFileSync(
        settingsPath,
        JSON.stringify({
          mcpServers: {
            tests: {
              type: "stdio",
              command: process.execPath,
              args: [mcpServer],
            },
          },
        }),
      );
    });

    after(async () => {
      await Promise.allSettled(clients.map((client) => client.shutdown()));
      await Promise.allSettled(connections.map((mcp) => mcp.close()));
      await model.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    });

    it("calls the desktop, sends the screenshot to the model, keeps it on reopen and calls the user's MCP server", async () => {
      let engine = await start();
      const names = engine.specs.map((spec) => spec.name);
      for (const name of [
        "get_preview_devtools",
        "preview_devtools__take_screenshot",
        "tests__echo",
        "tests__picture",
      ])
        assert.ok(names.includes(name), `${name} is offered: ${names}`);
      const screenshot = engine.specs.find(
        (spec) => spec.name === "preview_devtools__take_screenshot",
      )!;
      assert.equal(screenshot.effect, "read_only");
      await engine.client.createSession({
        session,
        config: config(engine.specs),
      });

      // A preview tool the desktop answers, then a screenshot.
      model.script(
        tools({ name: "get_preview_devtools", input: {} }),
        tools({ name: "preview_devtools__take_screenshot", input: {} }),
        text("The page renders."),
      );
      await turn(engine.client, "check the page");
      assert.deepEqual(
        desktopCalls.map((call) => call.method),
        [
          "previewDevtoolsTools",
          "previewDevtools",
          "previewDevtools",
          "previewDevtoolsCall",
        ],
      );
      const devtoolsCall = desktopCalls.at(-1)!.input as Record<
        string,
        unknown
      >;
      assert.equal(devtoolsCall.sessionId, session);
      assert.equal(devtoolsCall.scope, "story:42");
      assert.equal(devtoolsCall.toolName, "take_screenshot");
      const readiness = model.sent()[1]!;
      assert.match(readiness, /preview_ready_evidence/);
      assert.match(readiness, /"status\\":\\"passed\\"/);
      const afterScreenshot = model.sent()[2]!;
      assert.ok(
        afterScreenshot.includes(testPng),
        "the model receives the screenshot itself",
      );
      assert.match(afterScreenshot, /"type":"image"/);
      assert.match(afterScreenshot, new RegExp(`screenshot:${screenshotId}`));
      const finished = (await records(engine.client)).find(
        (record) =>
          record.type === "tool_call_finished" &&
          record.content.some((block) => block.type === "image"),
      );
      assert.ok(finished, "the image is a blob of the tool result record");

      // Reopened in a new engine: the image is still in the conversation.
      await engine.client.shutdown();
      engine = await start();
      await engine.client.openSession({ session });
      model.script(text("Still there."));
      await turn(engine.client, "and now?");
      assert.ok(
        model.sent().at(-1)!.includes(testPng),
        "the reopened conversation still sends the screenshot",
      );

      // The user's own MCP server.
      model.script(
        tools({ name: "tests__echo", input: { text: "hello" } }),
        text("It echoed."),
      );
      await turn(engine.client, "echo hello");
      assert.match(model.sent().at(-1)!, /echo: hello/);
    });
  },
);
