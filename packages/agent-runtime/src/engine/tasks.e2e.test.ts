// Engine tasks through the engine host, against the real `blame-engine`
// and a mock Anthropic server: a title from its result tool, a rejected
// result corrected, a follow of the task from its first record, a cancel,
// what stays out of Blame's database, and a deleted session. Skipped when
// the binary is not built.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { FollowEvent, SessionRecord } from "@blame/engine-client";
import { EngineHost } from "./host.js";
import type { EngineHostEvent } from "./protocol.js";
import {
  FakeApi,
  MockModel,
  stall,
  testModel,
  text,
  tools,
} from "./testing.js";
import { EngineTaskError } from "./tasks/runner.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const binary =
  process.env.BLAME_ENGINE_BIN ?? join(root, "target/debug/blame-engine");
const model = { providerId: "anthropic", modelId: testModel };

describe(
  "engine tasks",
  { skip: !existsSync(binary) && "no engine binary" },
  () => {
    let mock: MockModel;
    let api: FakeApi;
    let host: EngineHost;
    let workspace: string;
    let dataDir: string;
    const events: EngineHostEvent[] = [];

    before(async () => {
      mock = await MockModel.start([]);
      api = await FakeApi.start();
      api.modelBase = mock.base;
      workspace = mkdtempSync(join(tmpdir(), "blame-engine-tasks-"));
      dataDir = mkdtempSync(join(tmpdir(), "blame-engine-tasks-data-"));
      host = new EngineHost({
        binary,
        dataDir,
        clientVersion: "test",
        env: { ...process.env, BLAME_ENGINE_LOG: "warn" },
        emit: (event) => events.push(event),
      });
      await host.call("connect", { api: api.connection() });
    });

    after(async () => {
      await host.shutdown();
      await mock.close();
      await api.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    });

    function records(subscription: string): SessionRecord[] {
      return events.flatMap((event) =>
        event.type === "follow" &&
        event.subscription === subscription &&
        event.event.type === "records"
          ? (event.event as Extract<FollowEvent, { type: "records" }>).records
          : [],
      );
    }

    it("gives a title from the validated result, after a refused one", async () => {
      mock.script(
        tools({
          name: "submit_title",
          input: { title: "Fix login", runConfigurationId: "nope" },
        }),
        tools({
          name: "submit_title",
          input: { title: "Fix login", runConfigurationId: "web" },
        }),
      );
      const task = "task-title-1";
      const result = await host.call("generateTitle", {
        task,
        model,
        context: "user-story",
        prompt: "The login page loses the password",
        workspace: { root: workspace },
        runConfigurations: [
          {
            id: "web",
            name: "Web",
            command: "pnpm dev",
            cwd: ".",
            default: true,
            category: "web",
            services: ["web"],
            scopes: ["web"],
          },
        ],
      });
      assert.deepEqual(result, {
        session: task,
        title: "Fix login",
        runConfigurationId: "web",
      });
      const sent = mock.requests.at(-1)!.body as {
        tools: Array<{ name: string }>;
      };
      assert.deepEqual(
        sent.tools.map((tool) => tool.name),
        ["submit_title"],
        "no tool but the result",
      );
      assert.match(
        JSON.stringify(mock.requests.at(-1)!.body.messages),
        /Not accepted/,
        "the model read why its first result was refused",
      );
      // Followed from its first record, like any session.
      await host.call("follow", { session: task, subscription: "follow-2" });
      const deadline = Date.now() + 10_000;
      while (!records("follow-2").some((r) => r.type === "turn_ended")) {
        if (Date.now() > deadline) throw new Error("no records");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const kinds = records("follow-2").map((r) => r.type);
      assert.deepEqual(kinds.slice(0, 2), ["session_created", "user_message"]);
      assert.ok(kinds.includes("result_rejected"));
      assert.ok(kinds.includes("result_accepted"));
      await host.call("unfollow", { subscription: "follow-2" });
      // A task stays on this machine: nothing reached Blame's database.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(api.logs.has(task), false);
    });

    it("fails as unmet when the model only answers in text", async () => {
      mock.script(text("Fix login"), text("Fix login"), text("Fix login"));
      await assert.rejects(
        host.call("optimizeUserStory", {
          model,
          prompt: "login broken",
          workspace: { root: workspace },
        }),
        (error: unknown) =>
          error instanceof EngineTaskError &&
          error.outcome.status === "failed" &&
          error.outcome.failure.kind === "contract_unmet" &&
          /never gave its result with `submit_user_story`/.test(error.message),
      );
    });

    it("stops a task the renderer cancels", async () => {
      mock.script(stall("Thinking"));
      const asked = mock.requests.length;
      const task = "task-cancel-1";
      const running = host.call("generateTitle", {
        task,
        model,
        context: "quick-chat",
        prompt: "Something long",
      });
      // Cancelled while the model is answering.
      const deadline = Date.now() + 10_000;
      while (mock.requests.length === asked) {
        if (Date.now() > deadline) throw new Error("never ran");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(await host.call("cancelTask", { session: task }), true);
      await assert.rejects(
        running,
        (error: unknown) =>
          error instanceof EngineTaskError &&
          error.outcome.status === "interrupted",
      );
      assert.equal(await host.call("cancelTask", { session: task }), false);
    });

    it("deletes a session from the engine, not from Blame's database", async () => {
      const session = "qc-delete-0193f5d2-7a1b-7c3e-9f00-000000000009";
      await host.call("createSession", {
        session,
        purpose: "quick-chat",
        settings: { workspaceRoot: workspace, model },
      });
      const local = () => {
        const db = new DatabaseSync(join(dataDir, "sessions.db"), {
          readOnly: true,
        });
        try {
          return (
            db
              .prepare("SELECT count(*) AS n FROM records WHERE session = ?")
              .get(session) as {
              n: number;
            }
          ).n;
        } finally {
          db.close();
        }
      };
      assert.equal(local(), 1);
      await host.call("deleteSession", { session });
      assert.equal(local(), 0);
    });
  },
);
