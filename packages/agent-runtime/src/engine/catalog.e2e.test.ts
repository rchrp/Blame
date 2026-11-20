// A model nobody has heard of, published on models.dev, reaches the model
// pickers through the real engine and the host; picked, it is sent as
// listed; refused by the provider, the turn says so in words the person can
// act on, and the same conversation goes on with another model. Against the
// real `blame-engine`; skipped when it is not built.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionRecord } from "@blame/engine-client";
import { EngineHost } from "./host.js";
import type { EngineHostEvent, QuickChatSettings } from "./protocol.js";
import {
  FakeApi,
  MockModel,
  ModelsDev,
  modelsDevRow,
  refuse,
  testModel,
  text,
} from "./testing.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const binary =
  process.env.BLAME_ENGINE_BIN ?? join(root, "target/debug/blame-engine");
const session = "qc-catalog-0193f5d2-7a1b-7c3e-9f00-000000000003";
const brandNew = "claude-brand-new-1";

describe(
  "the models.dev catalog in the app",
  { skip: !existsSync(binary) && "no engine binary" },
  () => {
    let model: MockModel;
    let api: FakeApi;
    let modelsDev: ModelsDev;
    let host: EngineHost;
    let workspace: string;
    let dataDir: string;
    const events: EngineHostEvent[] = [];

    before(async () => {
      model = await MockModel.start([]);
      api = await FakeApi.start();
      api.modelBase = model.base;
      modelsDev = await ModelsDev.start({
        anthropic: {
          models: {
            [brandNew]: modelsDevRow("Claude Brand New 1", 77_777),
            [testModel]: modelsDevRow("Claude Sonnet 4.6"),
          },
        },
      });
      workspace = mkdtempSync(join(tmpdir(), "blame-engine-catalog-"));
      dataDir = mkdtempSync(join(tmpdir(), "blame-engine-catalog-data-"));
      host = new EngineHost({
        binary,
        dataDir,
        clientVersion: "test",
        catalogUrl: modelsDev.url,
        env: { ...process.env, BLAME_ENGINE_LOG: "warn" },
        emit: (event) => events.push(event),
      });
      await host.call("connect", { api: api.connection() });
    });

    after(async () => {
      await host.shutdown();
      await model.close();
      await api.close();
      await modelsDev.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    });

    const settings = (modelId: string) => ({
      purpose: "quick-chat" as const,
      settings: {
        workspaceRoot: workspace,
        model: { providerId: "anthropic", modelId, reasoning: "max" },
      } satisfies QuickChatSettings,
    });

    async function turn(message: string, modelId: string) {
      const ended = events.filter(
        (event) => event.type === "activity" && !event.running,
      ).length;
      await host.call("send", {
        session,
        message: { text: message },
        delivery: "turn",
        settings: settings(modelId),
      });
      const deadline = Date.now() + 30_000;
      while (
        events.filter((event) => event.type === "activity" && !event.running)
          .length <= ended
      ) {
        if (Date.now() > deadline) throw new Error("The turn did not end");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // The log as Blame's database holds it.
      const log = async () => (api.logs.get(session) ?? []) as SessionRecord[];
      while (Date.now() < deadline) {
        const ends = (await log()).filter((r) => r.type === "turn_ended");
        if (ends.length > ended) return ends.at(-1)!;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("The turn's end never reached the database");
    }

    it("lists, sends, refuses with a clear message, and continues on another model", async () => {
      // The pickers ask for a fresh list when they open.
      const list = await host.call("providers", { refresh: true });
      const anthropic = list.all.find(
        (provider) => provider.id === "anthropic",
      )!;
      const listed = anthropic.models[brandNew];
      assert.ok(listed, "the new model is offered");
      assert.equal(listed.maxTokens, 77_777);
      assert.ok(modelsDev.requests >= 1, "the engine asked models.dev");
      assert.deepEqual(list.connected, ["anthropic"]);

      await host.call("createSession", { session, ...settings(brandNew) });
      model.script(text("Hello from the new model."));
      const first = await turn("hi", brandNew);
      assert.deepEqual(first.type === "turn_ended" && first.outcome, {
        status: "completed",
      });
      const sent = model.requests.at(-1)!.body as {
        model: string;
        max_tokens: number;
      };
      assert.equal(sent.model, brandNew, "models.dev's id, as listed");
      assert.equal(sent.max_tokens, 77_777, "models.dev's output limit");

      // Withdrawn, or not on this account: the provider refuses it.
      model.script(
        refuse(404, {
          type: "error",
          error: { type: "not_found_error", message: `model: ${brandNew}` },
        }),
      );
      const refused = await turn("again", brandNew);
      assert.ok(
        refused.type === "turn_ended" && refused.outcome.status === "failed",
      );
      const error =
        refused.type === "turn_ended" && refused.outcome.status === "failed"
          ? refused.outcome.error
          : undefined;
      assert.equal(error?.kind, "model_unavailable");
      assert.equal(
        error?.message,
        `Anthropic does not offer the model \`${brandNew}\`. It answered: "model: ${brandNew} (HTTP 404)". Choose another model and send your message again.`,
      );

      // Another model, the same conversation.
      model.script(text("Hello from Sonnet."));
      const after = await turn("and now?", testModel);
      assert.deepEqual(after.type === "turn_ended" && after.outcome, {
        status: "completed",
      });
      const last = model.requests.at(-1)!.body as { model: string };
      assert.equal(last.model, testModel);
      assert.match(model.sent().at(-1)!, /Hello from the new model\./);
      assert.match(model.sent().at(-1)!, /and now\?/);
    });
  },
);
