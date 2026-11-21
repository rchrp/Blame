// A quick chat through the engine host and the real `blame-engine`, with the
// real harness runner, a scripted model server and a stand-in for Blame's
// API: a client tool call, the app quitting mid-turn, the conversation
// continued after it reopens, and a message undone with its files.
// Skipped when the engine binary is not built (`cargo build -p blame-engine`).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  TranscriptReducer,
  applyFollowEvent,
  type Transcript,
} from "@blame/engine-client";
import { EngineHost } from "./host.js";
import type { EngineHostEvent, QuickChatSettings } from "./protocol.js";
import {
  FakeApi,
  MockModel,
  stall,
  testModel,
  text,
  tools,
} from "./testing.js";
import { testHarnessCommand, testHarnessEnvironment } from "./testing.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const binary =
  process.env.BLAME_ENGINE_BIN ?? join(root, "target/debug/blame-engine");
const session = "qc-0193f5d2-7a1b-7c3e-9f00-000000000001";
// A 1×1 PNG.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe(
  "a quick chat on the engine",
  { skip: !existsSync(binary) && "no engine binary" },
  () => {
    let model: MockModel;
    let api: FakeApi;
    let workspace: string;
    let dataDir: string;
    const events: EngineHostEvent[] = [];
    const views = new Map<string, TranscriptReducer>();
    // Stopped at the end whatever happened, so a failure never leaves an engine running.
    const hosts: EngineHost[] = [];

    function startHost() {
      const host = new EngineHost({
        binary,
        dataDir,
        harnessCommand: testHarnessCommand(),
        clientVersion: "test",
        env: { ...process.env, ...testHarnessEnvironment(), BLAME_ENGINE_LOG: "warn" },
        emit: (event) => {
          events.push(event);
          if (event.type !== "follow") return;
          let view = views.get(event.subscription);
          if (!view)
            views.set(event.subscription, (view = new TranscriptReducer()));
          applyFollowEvent(view, event.event);
        },
      });
      hosts.push(host);
      return host;
    }

    const settings = (): QuickChatSettings => ({
      workspaceRoot: workspace,
      projectId: "0193f5d2-7a1b-7c3e-9f00-0000000000aa",
      model: { providerId: "anthropic", modelId: testModel },
    });

    function idleEvents() {
      return events.filter(
        (event): event is Extract<EngineHostEvent, { type: "activity" }> =>
          event.type === "activity" &&
          event.session === session &&
          !event.running,
      ).length;
    }

    async function until(
      what: string,
      ready: () => boolean,
      timeoutMs = 30_000,
    ) {
      const deadline = Date.now() + timeoutMs;
      while (!ready()) {
        if (Date.now() > deadline)
          throw new Error(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    async function turn(
      host: EngineHost,
      message: string,
      attachments?: { name: string; mediaType: string; data: string }[],
    ) {
      const ended = idleEvents();
      await host.call("send", {
        session,
        message: { text: message, attachments },
        delivery: "turn",
      });
      await until(`the turn "${message}" to end`, () => idleEvents() > ended);
    }

    const view = (subscription: string): Transcript =>
      views.get(subscription)!.snapshot();

    before(async () => {
      model = await MockModel.start([]);
      api = await FakeApi.start();
      api.modelBase = model.base;
      workspace = mkdtempSync(join(tmpdir(), "blame-engine-host-workspace-"));
      dataDir = mkdtempSync(join(tmpdir(), "blame-engine-host-data-"));
    });

    after(async () => {
      await Promise.allSettled(hosts.map((host) => host.shutdown()));
      await model.close();
      await api.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    });

    it("runs, survives the app quitting, continues and undoes a message with its files", async () => {
      let host = startHost();
      await host.call("connect", { api: api.connection() });
      await host.call("createSession", {
        session,
        purpose: "quick-chat",
        settings: settings(),
      });
      await host.call("follow", { session, subscription: "window-1" });

      // A client tool: the quick chat's web search, through Blame's API.
      model.script(
        tools({ name: "search_web", input: { query: "blame engine" } }),
        text("Found ", "it."),
      );
      await turn(host, "find the engine");
      assert.deepEqual(api.searches, ["blame engine"]);
      let transcript = view("window-1");
      const search = transcript.items.find((item) => item.kind === "tool_call");
      assert.equal(search?.kind === "tool_call" && search.name, "search_web");
      assert.equal(search?.kind === "tool_call" && search.state, "completed");
      assert.match(
        JSON.stringify(search?.kind === "tool_call" && search.result),
        /The engine/,
      );
      assert.ok(
        transcript.items.some(
          (item) => item.kind === "text" && item.text === "Found it.",
        ),
      );
      const firstRequest = model.requests[0]!.body as {
        tools: Array<{ name: string }>;
        system: unknown;
      };
      const offered = firstRequest.tools.map((tool) => tool.name).sort();
      for (const name of [
        "edit_code",
        "read_code",
        "read_web_page",
        "run_task",
        "search_code",
        "search_web",
      ])
        assert.ok(offered.includes(name), `${name} is offered: ${offered}`);
      assert.match(JSON.stringify(firstRequest.system), /project folder/);

      // The harness runs inside the engine and writes the workspace.
      model.script(
        tools({
          name: "edit_code",
          input: {
            operations: [
              {
                kind: "patch",
                path: "note.txt",
                patch: "hello from the agent\n",
              },
            ],
          },
        }),
        text("Wrote it."),
      );
      await turn(host, "write a note");
      assert.equal(
        readFileSync(join(workspace, "note.txt"), "utf8"),
        "hello from the agent\n",
      );

      // The app quits while a reply streams: the turn ends as interrupted.
      model.script(stall("Working on"));
      await host.call("send", {
        session,
        message: { text: "keep going" },
        delivery: "turn",
      });
      await until(
        "the reply to stream",
        () => view("window-1").activity.state === "streaming",
      );
      assert.deepEqual(await host.call("running", undefined), [session]);
      await host.shutdown();

      // Reopened: the same conversation, and it goes on.
      host = startHost();
      await host.call("connect", { api: api.connection() });
      await host.call("follow", { session, subscription: "window-2" });
      await until(
        "the reopened conversation",
        () => view("window-2").turns.length === 3,
      );
      transcript = view("window-2");
      assert.deepEqual(
        transcript.turns.map((t) => t.status),
        ["completed", "completed", "interrupted"],
      );
      model.script(text("Continued."));
      await turn(host, "continue", [
        { name: "pixel.png", mediaType: "image/png", data: png },
      ]);
      const continued = model.sent().at(-1)!;
      assert.match(continued, /Found it\./, "the model has the history");
      assert.match(continued, /Wrote it\./);
      assert.ok(continued.includes(png), "and the attached image");
      await until("the image to reach the API", () =>
        [...api.blobs.values()].some(
          (blob) => blob.bytes.toString("base64") === png,
        ),
      );

      // Undo "write a note": the conversation and the file go back.
      transcript = view("window-2");
      const note = transcript.items.find(
        (item) =>
          item.kind === "user" &&
          JSON.stringify(item.blocks).includes("write a note"),
      );
      assert.ok(
        note?.kind === "user" && note.rewind?.workspace,
        "it can be undone with its files",
      );
      await host.call("rewind", {
        session,
        to: note.kind === "user" ? note.rewind!.to : 0,
        restoreWorkspace: true,
      });
      await until(
        "the rewind to show",
        () => view("window-2").turns.length === 1,
      );
      assert.equal(existsSync(join(workspace, "note.txt")), false);
      assert.ok(
        view("window-2").items.some(
          (item) => item.kind === "text" && item.text === "Found it.",
        ),
      );

      // Every record is in Blame's database, as the engine stored it.
      const head = view("window-2").lastSeq;
      await until(
        "the log to reach the API",
        () => (api.logs.get(session)?.length ?? 0) === head,
      );
      await host.shutdown();
    });

    it("starts helper agents only for a message that asked for ultra mode", async () => {
      const ultraSession = "qc-0193f5d2-7a1b-7c3e-9f00-000000000002";
      const host = startHost();
      await host.call("connect", { api: api.connection() });
      await host.call("createSession", {
        session: ultraSession,
        purpose: "quick-chat",
        settings: settings(),
      });
      await host.call("follow", { session: ultraSession, subscription: "ultra" });
      const ended = () =>
        events.filter(
          (event) =>
            event.type === "activity" &&
            event.session === ultraSession &&
            !event.running,
        ).length;
      const send = async (message: string, ultra: boolean) => {
        const before = ended();
        await host.call("send", {
          session: ultraSession,
          message: { text: message, ...(ultra ? { ultra } : {}) },
          delivery: "turn",
        });
        await until(`"${message}" to end`, () => ended() > before);
      };
      const helperAsk = {
        agents: [
          {
            role: "research",
            title: "Look it up",
            brief: "Search the web for the blame engine.",
          },
        ],
      };

      // Ultra mode on: the lead asks, a helper searches and reports.
      model.script(
        tools({ name: "run_agents", input: helperAsk }),
        tools({ name: "search_web", input: { query: "helper blame engine" } }),
        tools({
          name: "report",
          input: {
            summary: "It is the Blame engine.",
            references: [{ ref: "https://example.com/engine", note: "the page" }],
          },
        }),
        text("The helper found it."),
      );
      const before = model.requests.length;
      await send("look it up with helpers", true);
      const first = model.requests[before]!.body as {
        tools: Array<{ name: string }>;
      };
      assert.ok(
        first.tools.some((tool) => tool.name === "run_agents"),
        "the lead is offered the helpers' tool",
      );
      let transcript = view("ultra");
      const opening = transcript.items.find((item) => item.kind === "user");
      assert.ok(
        opening?.kind === "user" &&
          opening.blocks.some((block) => block.type === "ultra"),
        "the message records that ultra mode was on",
      );
      const call = transcript.items.find(
        (item) => item.kind === "tool_call" && item.name === "run_agents",
      );
      assert.equal(call?.kind === "tool_call" && call.state, "completed");
      const result = JSON.parse(
        call?.kind === "tool_call" && call.result?.[0]?.type === "text"
          ? call.result[0].text
          : "{}",
      ) as {
        agents: Array<{ status: string; session: string; report?: { summary: string } }>;
      };
      assert.equal(result.agents[0]?.status, "completed");
      assert.equal(result.agents[0]?.report?.summary, "It is the Blame engine.");
      assert.ok(
        api.searches.includes("helper blame engine"),
        "the helper's web search went through the app, like the lead's",
      );
      const [{ exists }] = await host.call("status", {
        sessions: [result.agents[0]!.session],
      });
      assert.ok(exists, "the helper is a session of its own");

      // The next message does not ask for it: the same call is refused.
      model.script(
        tools({ name: "run_agents", input: helperAsk }),
        text("I will do it myself."),
      );
      const requests = model.requests.length;
      await send("and again, without", false);
      transcript = view("ultra");
      const refused = [...transcript.items]
        .reverse()
        .find((item) => item.kind === "tool_call" && item.name === "run_agents");
      assert.equal(refused?.kind === "tool_call" && refused.state, "denied");
      assert.match(
        JSON.stringify(refused?.kind === "tool_call" && refused.result),
        /ultra mode is off for this message/,
      );
      const second = model.requests[requests]!.body as {
        tools: Array<{ name: string }>;
      };
      assert.deepEqual(
        second.tools.map((tool) => tool.name),
        first.tools.map((tool) => tool.name),
        "toggling does not change the tool list the provider caches",
      );
      await host.shutdown();
    });
  },
);
