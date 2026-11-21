// The settings picked when a message is sent reach the engine before the
// turn runs, and only when they change: an unchanged config would add a
// record to every message and a rewritten prompt would lose the provider's
// cache. Against the real `blame-engine`; skipped when it is not built.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionConfig, SessionRecord } from "@blame/engine-client";
import { EngineHost } from "./host.js";
import type { EngineHostEvent, QuickChatSettings } from "./protocol.js";
import { FakeApi, MockModel, testModel, text } from "./testing.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const binary =
  process.env.BLAME_ENGINE_BIN ?? join(root, "target/debug/blame-engine");
const session = "qc-settings-0193f5d2-7a1b-7c3e-9f00-000000000002";
const day = 24 * 60 * 60 * 1000;

describe(
  "quick chat settings",
  { skip: !existsSync(binary) && "no engine binary" },
  () => {
    let model: MockModel;
    let api: FakeApi;
    let workspace: string;
    let dataDir: string;
    // Today: the engine stamps its records with the real clock, and a host
    // that reopens a conversation reads the prompt's day from them.
    let clock = Date.now();
    const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const firstDay = isoDay(clock);
    const laterDay = isoDay(clock + 3 * day);
    const hosts: EngineHost[] = [];
    const events: EngineHostEvent[] = [];

    function startHost() {
      const host = new EngineHost({
        binary,
        dataDir,
        clientVersion: "test",
        env: { ...process.env, BLAME_ENGINE_LOG: "warn" },
        now: () => new Date(clock),
        emit: (event) => events.push(event),
      });
      hosts.push(host);
      return host;
    }

    const settings = (
      change: Partial<QuickChatSettings> = {},
    ): { purpose: "quick-chat"; settings: QuickChatSettings } => ({
      purpose: "quick-chat",
      settings: {
        workspaceRoot: workspace,
        model: {
          providerId: "anthropic",
          modelId: testModel,
          reasoning: "medium",
        },
        maxContextTokens: 200_000,
        ...change,
      },
    });

    async function send(host: EngineHost, input: ReturnType<typeof settings>) {
      const ended = events.filter(
        (event) => event.type === "activity" && !event.running,
      ).length;
      model.script(text("Done."));
      await host.call("send", {
        session,
        message: { text: "go on" },
        delivery: "turn",
        settings: input,
      });
      const deadline = Date.now() + 30_000;
      while (
        events.filter((event) => event.type === "activity" && !event.running)
          .length <= ended
      ) {
        if (Date.now() > deadline) throw new Error("The turn did not end");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    async function configs(): Promise<SessionConfig[]> {
      // What the engine's log holds, as Blame's database got it.
      const deadline = Date.now() + 10_000;
      let log = (api.logs.get(session) ?? []) as SessionRecord[];
      while (log.at(-1)?.type !== "turn_ended" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        log = (api.logs.get(session) ?? []) as SessionRecord[];
      }
      return log.flatMap((record) =>
        record.type === "session_created" || record.type === "config_changed"
          ? [record.config]
          : [],
      );
    }

    before(async () => {
      model = await MockModel.start([]);
      api = await FakeApi.start();
      api.modelBase = model.base;
      workspace = mkdtempSync(join(tmpdir(), "blame-engine-settings-"));
      dataDir = mkdtempSync(join(tmpdir(), "blame-engine-settings-data-"));
    });

    after(async () => {
      await Promise.allSettled(hosts.map((host) => host.shutdown()));
      await model.close();
      await api.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    });

    it("applies a change before the turn and nothing when nothing changed", async () => {
      let host = startHost();
      await host.call("connect", { api: api.connection() });
      await host.call("createSession", { session, ...settings() });

      await send(host, settings());
      assert.equal((await configs()).length, 1, "unchanged: no record");

      // Only the reasoning level changes.
      const high = settings({
        model: {
          providerId: "anthropic",
          modelId: testModel,
          reasoning: "high",
        },
      });
      await send(host, high);
      let held = await configs();
      assert.equal(held.length, 2);
      assert.equal(held[1]!.reasoning, "high");
      assert.equal(held[1]!.system_prompt, held[0]!.system_prompt);

      // Days later, after the app restarted, the same settings change nothing:
      // the prompt keeps the day the conversation started.
      await host.shutdown();
      clock += 3 * day;
      host = startHost();
      await host.call("connect", { api: api.connection() });
      await send(host, high);
      assert.equal((await configs()).length, 2, "no record for a new day");
      assert.deepEqual(await host.call("configure", { session, ...high }), {
        changed: false,
      });

      // Only the context cap changes.
      const capped = {
        ...high,
        settings: { ...high.settings, maxContextTokens: 100_000 },
      };
      await send(host, capped);
      held = await configs();
      assert.equal(held.length, 3);
      assert.equal(held[2]!.limits.max_context_tokens, 100_000);

      // Personalization is part of the prompt: applied on the next message.
      const detailed = {
        ...capped,
        settings: {
          ...capped.settings,
          personalization: { responseStyle: "detailed" as const },
        },
      };
      await send(host, detailed);
      held = await configs();
      assert.equal(held.length, 4);
      assert.notEqual(held[3]!.system_prompt, held[2]!.system_prompt);
      assert.ok(held[3]!.system_prompt.includes(firstDay), "still the first day");

      // The model request of that turn used what was picked.
      const last = model.requests.at(-1)!.body as { system: unknown };
      assert.equal(JSON.stringify(last.system).includes(laterDay), false);
    });
  },
);
