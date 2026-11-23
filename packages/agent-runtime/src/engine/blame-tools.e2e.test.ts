// The self-repair tools on the real `blame-engine`, with a scripted model: an
// agent in a story finds an MCP server that fails, tests it, removes it (the
// person's approval is asked for that call alone), hands a step to the
// person, and a broken preview is restarted. The tool set is wired as the
// engine host wires it (policy, guards); the desktop is faked.
// Skipped when the engine binary is not built (`cargo build -p blame-engine`).

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EngineClient,
  localEngine,
  type SessionConfig,
  type SessionRecord,
} from "@blame/engine-client";
import { MockModel, testModel, text, tools } from "./testing.js";
import { ToolSet } from "./tool.js";
import {
  ConversationTools,
  McpConnections,
  clientToolGuards,
  clientToolPolicy,
} from "./tools/index.js";
import type { PreviewDevtoolsTarget } from "./tools/preview-types.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const binary =
  process.env.BLAME_ENGINE_BIN ?? join(root, "target/debug/blame-engine");
const session = "story-0193f5d2-7a1b-7c3e-9f00-0000000000b1";

describe(
  "the self-repair tools on the engine",
  { skip: !existsSync(binary) && "no engine binary" },
  () => {
    let model: MockModel;
    let workspace: string;
    let dataDir: string;
    let settingsPath: string;
    let client: EngineClient;
    let mcp: McpConnections;
    const approvals: Array<Record<string, unknown>> = [];
    const appRequests: Array<Record<string, unknown>> = [];
    let previewStatus: PreviewDevtoolsTarget["status"] = "failed";

    before(async () => {
      model = await MockModel.start([]);
      workspace = mkdtempSync(join(tmpdir(), "blame-self-workspace-"));
      dataDir = mkdtempSync(join(tmpdir(), "blame-self-data-"));
      settingsPath = join(dataDir, "mcp-settings.json");
      writeFileSync(
        settingsPath,
        JSON.stringify({
          mcpServers: {
            notes: { type: "stdio", command: "blame-no-such-program" },
          },
        }),
      );
      mcp = new McpConnections({ settingsPath: () => settingsPath });
      const toolSet = new ToolSet([], {
        policy: clientToolPolicy,
        guards: clientToolGuards,
      });
      client = await EngineClient.start(
        localEngine(
          binary,
          { dataDir },
          { ...process.env, BLAME_ENGINE_LOG: "warn" },
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
            approval: (params) => {
              approvals.push(params as unknown as Record<string, unknown>);
              return { decision: "approved" };
            },
          },
        },
      );
      const conversations = new ConversationTools(toolSet, {
        connection: () => undefined,
        mcp,
        mcpSettingsPath: () => settingsPath,
        home: join(dataDir, "home"),
        blameApp: async (input) => {
          appRequests.push(input as unknown as Record<string, unknown>);
          if (input.action === "restart_preview") {
            previewStatus = "ready";
            return { restarted: true };
          }
          return {};
        },
        previewDevtools: async () =>
          ({
            available: previewStatus === "ready",
            loading: false,
            message: previewStatus === "ready" ? "Ready" : "Setup failed.",
            reason: "PREVIEW",
            status: previewStatus,
          }) satisfies PreviewDevtoolsTarget,
        previewContainerLogs: async () => ({
          stdout: "Error: listen EADDRINUSE: address already in use :::3000",
        }),
      });
      const listed = await conversations.ensure({
        session,
        kind: "story",
        workspaceRoot: workspace,
        preview: {
          scope: "story:b1",
          worktree: workspace,
          workspaceMode: "local-container",
        },
        skills: false,
      });
      const names = listed.specs.map((spec) => spec.name);
      for (const name of ["blame_inspect", "blame_configure", "blame_repair"])
        assert.ok(names.includes(name), `${name} is offered: ${names}`);
      const configure = listed.specs.find(
        (spec) => spec.name === "blame_configure",
      )!;
      assert.equal(configure.needs_approval, true);
      assert.equal(
        listed.specs.find((spec) => spec.name === "blame_repair")!
          .needs_approval,
        false,
      );
      const config: SessionConfig = {
        purpose: "story",
        workspace_root: workspace,
        model: { provider: "anthropic", model: testModel },
        system_prompt: "You build the story.",
        engine_tools: [],
        client_tools: listed.specs,
        tool_options: {},
        limits: {},
        checkpoints: false,
      };
      await client.createSession({ session, config });
    });

    after(async () => {
      await client.shutdown().catch(() => undefined);
      await mcp.close();
      await model.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    });

    async function records() {
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

    async function turn(message: string) {
      const ended = (await records()).filter(
        (record) => record.type === "turn_ended",
      ).length;
      await client.sendMessage({
        session,
        input: [{ type: "text", text: message }],
        delivery: "turn",
      });
      const deadline = Date.now() + 30_000;
      for (;;) {
        const now = (await records()).filter(
          (record) => record.type === "turn_ended",
        ).length;
        if (now > ended) return;
        if (Date.now() > deadline) throw new Error(`Timed out: "${message}"`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    it("diagnoses a broken server and a broken preview, fixes what it may and asks for the rest", async () => {
      model.script(
        tools({ name: "blame_inspect", input: { area: "overview" } }),
        tools({
          name: "blame_repair",
          input: { action: "reconnect_mcp", name: "notes" },
        }),
        tools({ name: "blame_repair", input: { action: "restart_preview" } }),
        tools({
          name: "blame_configure",
          input: { action: "remove_mcp", name: "notes" },
        }),
        tools({
          name: "blame_repair",
          input: {
            action: "hand_over",
            where: "models",
            why: "sign in to a provider again",
          },
        }),
        text("Done."),
      );
      await turn("my preview and my notes server do not work");
      const sent = model.sent();
      // The overview names both problems and the next step.
      assert.match(sent[1]!, /2 areas to look at/);
      assert.match(sent[1]!, /area=preview|area=mcp/);
      // The reconnect says it still fails, with the cause.
      assert.match(sent[2]!, /still_failing/);
      assert.match(sent[2]!, /command is not installed/);
      // The preview restart reports before and after.
      assert.match(sent[3]!, /fixed/);
      assert.deepEqual(appRequests, [
        // The overview asks the app once; the restart is the repair.
        { action: "state" },
        {
          action: "restart_preview",
          worktree: workspace,
          workspaceMode: "local-container",
        },
      ]);
      // Only the configuration change asked for approval, and the file changed.
      assert.equal(approvals.length, 1);
      assert.match(JSON.stringify(approvals[0]), /blame_configure|remove_mcp/);
      assert.deepEqual(
        JSON.parse(readFileSync(settingsPath, "utf8")).mcpServers,
        {},
      );
      assert.match(sent[4]!, /removed/);
      // The hand-over names the exact Settings tab.
      assert.match(sent[5]!, /Settings → Models & Providers/);
      const calls = (await records()).filter(
        (record) => record.type === "tool_call_started",
      );
      assert.deepEqual(
        calls.map(
          (record) => record.type === "tool_call_started" && record.effect,
        ),
        ["read_only", "command", "command", "external", "command"],
      );
    });
  },
);
