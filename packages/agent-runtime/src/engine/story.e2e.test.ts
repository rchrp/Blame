// A development story through the engine host and the real `blame-engine`,
// with the real harness runner and a scripted model server: its first
// message, a file edit, a tool that needs approval, queueing and steering
// while a turn runs, an interrupt, a provider failure and its retry,
// compaction, the app quitting mid-turn then reopening (recovery from the
// records), and undoing a message with its files. Skipped when the engine
// binary is not built (`cargo build -p blame-engine`).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  TranscriptReducer,
  applyFollowEvent,
  type Transcript,
} from "@blame/engine-client";
import { EngineHost } from "./host.js";
import type { DevelopmentStorySettings, EngineHostEvent } from "./protocol.js";
import {
  FakeApi,
  MockModel,
  failure,
  stall,
  testModel,
  text,
  tools,
} from "./testing.js";
import { defineTool } from "./tool.js";

// A story's turn ends through the harness's `finish_task` (its contract).
const finish = (summary: string) =>
  tools({ name: "finish_task", input: { summary } });

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const binary =
  process.env.BLAME_ENGINE_BIN ?? join(root, "target/debug/blame-engine");
const runner = fileURLToPath(
  new URL("../harness/semantic-harness-runner.js", import.meta.url),
);

describe(
  "a development story on the engine",
  { skip: !existsSync(binary) && "no engine binary" },
  () => {
    let model: MockModel;
    let api: FakeApi;
    let worktree: string;
    let dataDir: string;
    const hosts: EngineHost[] = [];
    const events: EngineHostEvent[] = [];
    const views = new Map<string, TranscriptReducer>();
    let release: (() => void) | undefined;
    const deployed: string[] = [];

    // Stands in for a story tool that acts outside the worktree.
    const deploy = defineTool<{ target?: string }>({
      name: "deploy_preview",
      description: "Deploys the preview.",
      inputSchema: {
        type: "object",
        properties: { target: { type: "string" } },
      },
      effect: "external",
      needsApproval: true,
      run: ({ target }) => {
        deployed.push(target ?? "");
        return "deployed";
      },
    });
    // A tool that runs until the test lets it finish.
    const slow = defineTool({
      name: "wait_for_build",
      description: "Waits for the build.",
      inputSchema: { type: "object" },
      effect: "read_only",
      run: () =>
        new Promise<string>((resolve) => (release = () => resolve("built"))),
    });

    function startHost() {
      const host = new EngineHost({
        binary,
        dataDir,
        harnessCommand: [process.execPath, runner, "--serve"],
        clientVersion: "test",
        env: { ...process.env, BLAME_ENGINE_LOG: "warn" },
        extraTools: [deploy, slow],
        extraPurposeTools: {
          "development-story": ["deploy_preview", "wait_for_build"],
        },
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

    const settings = (
      session: string,
    ): {
      purpose: "development-story";
      settings: DevelopmentStorySettings;
    } => ({
      purpose: "development-story",
      settings: {
        workspace: { root: worktree, location: "host" },
        workspaceMode: "local-container",
        projectId: "0193f5d2-7a1b-7c3e-9f00-0000000000aa",
        storyId: `story-${session}`,
        title: "Add a greeting note",
        model: { providerId: "anthropic", modelId: testModel },
      },
    });

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

    const ended = (session: string) =>
      events.filter(
        (e) => e.type === "activity" && e.session === session && !e.running,
      ).length;
    const view = (subscription: string): Transcript =>
      views.get(subscription)!.snapshot();

    async function open(host: EngineHost, session: string) {
      await host.call("connect", { api: api.connection() });
      await host.call("createSession", { session, ...settings(session) });
      await host.call("follow", { session, subscription: session });
    }

    async function turn(host: EngineHost, session: string, message: string) {
      const before = ended(session);
      await host.call("send", {
        session,
        message: { text: message },
        delivery: "turn",
        settings: settings(session),
      });
      await until(`"${message}" to end`, () => ended(session) > before);
    }

    before(async () => {
      model = await MockModel.start([]);
      api = await FakeApi.start();
      api.modelBase = model.base;
      worktree = mkdtempSync(join(tmpdir(), "blame-engine-story-"));
      writeFileSync(join(worktree, "index.js"), "export const answer = 42\n");
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: worktree });
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
      dataDir = mkdtempSync(join(tmpdir(), "blame-engine-story-data-"));
    });

    after(async () => {
      release?.();
      await Promise.allSettled(hosts.map((host) => host.shutdown()));
      await model.close();
      await api.close();
      rmSync(worktree, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    });

    it("runs a story from its brief to an undone message", async () => {
      let host = startHost();
      const session = "story-a";
      await open(host, session);

      // The brief, then a harness edit in the worktree.
      model.script(
        tools({
          name: "edit_code",
          input: {
            operations: [{ kind: "patch", path: "note.txt", patch: "hello\n" }],
          },
        }),
        finish("Added the note."),
      );
      await turn(host, session, "Write hello into note.txt.");
      assert.equal(readFileSync(join(worktree, "note.txt"), "utf8"), "hello\n");
      const first = model.sent()[0]!;
      assert.match(first, /Backlog item: Add a greeting note/);
      assert.match(first, /Work in the current worktree/);
      const system = JSON.stringify(
        (model.requests[0]!.body as { system: unknown }).system,
      );
      assert.match(
        system,
        /current process permissions/,
        "a worktree story's environment",
      );
      const offered = (
        model.requests[0]!.body as { tools?: Array<{ name: string }> }
      ).tools?.map((tool) => tool.name);
      for (const name of ["propose_user_stories", "search_user_stories"])
        assert.ok(
          offered?.includes(name),
          `the story offers its conversation tool ${name}`,
        );

      // A tool that needs the person's approval: it waits, then runs once allowed.
      model.script(
        tools({ name: "deploy_preview", input: { target: "staging" } }),
        finish("Deployed."),
      );
      const beforeApproval = ended(session);
      await host.call("send", {
        session,
        message: { text: "Deploy it." },
        delivery: "turn",
      });
      await until(
        "the approval request",
        () => view(session).pendingApprovals.length === 1,
      );
      const pending = view(session).pendingApprovals[0]!;
      assert.equal(deployed.length, 0, "nothing runs before the answer");
      await host.call("resolveApproval", {
        session,
        call: pending.call,
        decision: "approved",
      });
      await until("the deploy turn", () => ended(session) > beforeApproval);
      assert.deepEqual(deployed, ["staging"]);

      // While a turn runs: a steer joins it, a second message waits its turn.
      model.script(
        tools({ name: "wait_for_build", input: {} }),
        finish("Built, and noted."),
        finish("Next one done."),
      );
      const beforeQueue = ended(session);
      await host.call("send", {
        session,
        message: { text: "Build it." },
        delivery: "turn",
      });
      await until("the slow tool", () => release !== undefined);
      const steer = await host.call("send", {
        session,
        message: { text: "Also mention the date." },
        delivery: "steer",
      });
      const queued = await host.call("send", {
        session,
        message: { text: "Then tidy up." },
        delivery: "turn",
      });
      assert.equal(queued.started, false, "queued behind the running turn");
      assert.ok(steer.turn);
      release!();
      await until(
        "both turns",
        () =>
          view(session).turns.at(-1)?.status === "completed" &&
          ended(session) > beforeQueue,
      );
      const afterBuild = model.sent().find((sent) => sent.includes("built"))!;
      assert.match(
        afterBuild,
        /Also mention the date\./,
        "the steer reached the running turn",
      );
      assert.match(model.sent().at(-1)!, /Then tidy up\./);

      // A provider failure is retried; the turn still completes.
      model.script(failure(529, "overloaded_error"), finish("Worked on retry."));
      await turn(host, session, "Once more.");
      const retried = view(session).items.find(
        (item) => item.kind === "request_failed",
      );
      assert.ok(retried?.kind === "request_failed" && retried.retried);
      assert.ok(
        view(session).items.some(
          (item) =>
            item.kind === "tool_call" &&
            JSON.stringify(item).includes("Worked on retry."),
        ),
      );

      // A reply that stops without finishing is corrected by the engine:
      // the story's turn ends only through an accepted finish_task.
      model.script(text("I think that is it."), finish("Finished for real."));
      await turn(host, session, "Wrap up.");
      assert.match(
        model.sent().at(-1)!,
        /`finish_task`/,
        "the engine asked the agent to finish",
      );
      assert.equal(view(session).turns.at(-1)?.status, "completed");
      assert.ok(
        view(session).items.some((item) => item.kind === "notice"),
        "the correction shows in the transcript",
      );

      // An interrupt ends the running turn as interrupted.
      model.script(stall("Thinking about"));
      await host.call("send", {
        session,
        message: { text: "Think hard." },
        delivery: "turn",
      });
      await until(
        "streaming",
        () => view(session).activity.state === "streaming",
      );
      await host.call("interrupt", { session });
      await until(
        "the interrupt",
        () => view(session).turns.at(-1)?.status === "interrupted",
      );

      // Compaction on request.
      model.script(text("Summary of the story so far."));
      await host.call("compact", { session });
      await until("the compaction", () =>
        view(session).items.some((item) => item.kind === "compaction"),
      );

      // The app quits mid-turn; reopened, the records say how it ended.
      model.script(stall("Working on"));
      await host.call("send", {
        session,
        message: { text: "Keep going." },
        delivery: "turn",
      });
      await until(
        "streaming again",
        () => view(session).activity.state === "streaming",
      );
      await host.shutdown();
      host = startHost();
      await host.call("connect", { api: api.connection() });
      const [status] = await host.call("status", { sessions: [session] });
      assert.equal(status!.running, false);
      assert.equal(status!.lastOutcome?.status, "interrupted");
      const [missing] = await host.call("status", {
        sessions: ["never-created"],
      });
      assert.equal(missing!.exists, false);
      await host.call("follow", { session, subscription: "reopened" });
      model.script(finish("Continued after the restart."));
      const beforeContinue = ended(session);
      await host.call("send", {
        session,
        message: { text: "Continue." },
        delivery: "turn",
        settings: settings(session),
      });
      await until("the continued turn", () => ended(session) > beforeContinue);
      assert.match(
        model.sent().at(-1)!,
        /Added the note\./,
        "the model has the story so far",
      );
      const [continued] = await host.call("status", { sessions: [session] });
      assert.equal(
        continued!.lastReply,
        "Continued after the restart.",
        "a pull request can describe the story with the agent's last reply",
      );

      // Undo the first message: the conversation and the note go back.
      const brief = view("reopened").items.find(
        (item) =>
          item.kind === "user" &&
          JSON.stringify(item.blocks).includes("Write hello"),
      );
      assert.ok(brief?.kind === "user" && brief.rewind?.workspace);
      await host.call("rewind", {
        session,
        to: brief.rewind.to,
        restoreWorkspace: true,
      });
      await until("the undo", () => view("reopened").turns.length === 0);
      assert.equal(existsSync(join(worktree, "note.txt")), false);
    });

    it("refuses a worktree inside the VM with a clear message", async () => {
      const host = startHost();
      const vm = settings("story-vm");
      vm.settings.workspace = {
        root: "/home/blame/worktrees/x",
        location: "vm",
      };
      await assert.rejects(
        host.call("createSession", { session: "story-vm", ...vm }),
        /inside the Blame Runtime VM/,
      );
    });
  },
);
