// The orchestrator's loop with no window: the real `blame-engine` and
// `blame-harness`, real git, the local Blame API (SQLite, as "Continue
// without an account" runs it) and a scripted model that answers each
// request from what it asks (the orchestrator, a story by its title, a
// commit message). The scripted orchestrator creates two stories, one
// starting after the other, sleeps, is woken, approves, sleeps, is woken
// again, approves and finishes; then a story whose checks fail is refused,
// sent back with an escalated model and approved; then Blame quits while the
// orchestrator works and the wake comes once after it opens again.
//
// Skipped without the engine binaries (`cargo build -p blame-engine -p
// blame-harness`) or the API build (`pnpm --filter @blame/api build`).

import assert from "node:assert/strict";
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { EngineClient } from "@blame/engine-client";
import type { ModelRecommendations } from "../types.js";
import { EngineHost } from "./host.js";
import {
  orchestratorWakeText,
  parseOrchestratorWake,
  type EngineHostEvent,
  type EpicState,
  type OrchestratorSettings,
  type OrchestratorWake,
} from "./protocol.js";
import {
  ModelsDev,
  modelsDevRow,
  testHarnessCommand,
  testHarnessEnvironment,
} from "./testing.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const binary =
  process.env.BLAME_ENGINE_BIN ?? join(root, "target/debug/blame-engine");
const localApi = join(root, "packages/api/build/bin/local.js");
const skip = !existsSync(binary)
  ? "no engine binary"
  : !existsSync(localApi)
    ? "no API build (pnpm --filter @blame/api build)"
    : false;

// ------------------------------------------------------------- the model

type Reply =
  | { text: string }
  | { tool: string; input: unknown }
  /** The start of a reply, then nothing: the turn stays in flight. */
  | { stall: true };
type Step = Reply | ((body: Body) => Reply | Promise<Reply>);
type Body = {
  model: string;
  system?: string | Array<{ text?: string }>;
  tools?: Array<{ name: string }>;
  messages: Array<{
    role: string;
    content: string | Array<Record<string, unknown>>;
  }>;
};

function textOf(content: Body["messages"][number]["content"] | undefined) {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) =>
      typeof block.text === "string"
        ? block.text
        : typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? (block.content as Array<{ text?: string }>)
                .map((part) => part.text ?? "")
                .join("")
            : "",
    )
    .join("\n");
}

/** Anthropic's Messages API, answering each request from what it is. */
class ScriptedModel {
  readonly requests: Array<{ who: string; model: string; body: Body }> = [];
  readonly orchestrator: Step[] = [];
  readonly stories = new Map<string, Step[]>();
  readonly unscripted: string[] = [];
  /** The title of the epic whose orchestrator the script answers. */
  epic: string | undefined;
  private readonly stalled = new Set<() => void>();
  private readonly server: Server;
  base = "";

  constructor() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(
          Buffer.concat(chunks).toString() || "{}",
        ) as Body;
        const { who, step } = this.route(body);
        this.requests.push({ who, model: body.model, body });
        void Promise.resolve(
          typeof step === "function" ? step(body) : step,
        ).then((reply) => this.answer(response, reply));
      });
    });
  }

  private answer(response: ServerResponse, reply: Reply) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const events = sse(reply);
    if ("stall" in reply) {
      response.write(
        events.slice(0, events.indexOf("event: content_block_stop")),
      );
      const close = () => response.destroy();
      this.stalled.add(close);
      response.on("close", () => this.stalled.delete(close));
      return;
    }
    response.end(events);
  }

  private route(body: Body): { who: string; step: Step } {
    const tools = (body.tools ?? []).map((tool) => tool.name);
    const system =
      typeof body.system === "string"
        ? body.system
        : (body.system ?? []).map((part) => part.text ?? "").join("");
    if (tools.includes("submit_commit_message"))
      return {
        who: "commit",
        step: {
          tool: "submit_commit_message",
          input: { message: "feat: the story's work" },
        },
      };
    if (system.includes("Blame Orchestrator")) {
      // Another test's epic (left at work) never takes this test's script.
      const title = /<epic>\ntitle: (.*)\n/.exec(system)?.[1];
      if (this.epic && title !== this.epic)
        return { who: `orchestrator:${title}`, step: { stall: true } };
      const step = this.orchestrator.shift();
      if (step) return { who: "orchestrator", step };
      this.unscripted.push(
        `orchestrator: ${textOf(body.messages.at(-1)?.content).slice(0, 200)}`,
      );
      return { who: "orchestrator", step: { text: "(unscripted)" } };
    }
    if (tools.includes("finish_task")) {
      const first = textOf(
        body.messages.find((message) => message.role === "user")?.content,
      );
      const title = /Backlog item: (.*)/.exec(first)?.[1]?.trim() ?? "?";
      const step = this.stories.get(title)?.shift();
      return {
        who: `story:${title}`,
        step: step ?? { text: "I stopped there." },
      };
    }
    return { who: "other", step: { text: "Title" } };
  }

  /** The requests one side made, each with the model it ran on. */
  of(who: string) {
    return this.requests.filter((request) => request.who === who);
  }

  async start() {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
    const port = (this.server.address() as AddressInfo).port;
    // The API wants a host name; *.localhost is this computer.
    this.base = `http://orchestrator-mock.localhost:${port}`;
  }

  stopStalls() {
    for (const close of this.stalled) close();
  }

  async close() {
    this.stopStalls();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

function sse(reply: Reply) {
  const event = (name: string, data: unknown) =>
    `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const out = [
    event("message_start", {
      type: "message_start",
      message: {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: "scripted",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 1 },
      },
    }),
  ];
  if ("tool" in reply) {
    out.push(
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: `toolu_${randomUUID().replaceAll("-", "")}`,
          name: reply.tool,
          input: {},
        },
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(reply.input),
        },
      }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
    );
  } else {
    const text = "text" in reply ? reply.text : "Thinking about it";
    out.push(
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
    );
  }
  out.push(
    event("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: "tool" in reply ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 100 },
    }),
    event("message_stop", { type: "message_stop" }),
  );
  return out.join("");
}

const tool = (name: string, input: unknown): Reply => ({ tool: name, input });
const finish = (summary: string) => tool("finish_task", { summary });
const write = (path: string, content: string) =>
  tool("edit_code", { operations: [{ kind: "patch", path, patch: content }] });
const replace = (path: string, from: string, to: string) =>
  tool("edit_code", {
    operations: [
      {
        kind: "patch",
        patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n-${from}\n+${to}\n*** End Patch`,
      },
    ],
  });

// ------------------------------------------------------------- the account

/** The local Blame API on SQLite, as the desktop runs it without an account. */
async function startLocalApi(directory: string) {
  const child = spawn(process.execPath, [localApi], {
    cwd: join(root, "packages/api"),
    env: {
      ...process.env,
      APP_KEY: randomBytes(32).toString("base64url"),
      DB_SQLITE_FILE: join(directory, "blame.sqlite"),
      BLAME_LOCAL_STORAGE_DIRECTORY: join(directory, "objects"),
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ready = await new Promise<{ url: string; token: string }>(
    (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The local API did not start.")),
        60_000,
      );
      createInterface({ input: child.stdout! }).on("line", (line) => {
        try {
          const message = JSON.parse(line) as {
            type: string;
            url: string;
            token: string;
            message?: string;
          };
          clearTimeout(timer);
          if (message.type === "ready") resolve(message);
          else reject(new Error(message.message));
        } catch {
          // A log line.
        }
      });
      child.once("exit", (code) =>
        reject(new Error(`The local API exited with ${code}.`)),
      );
    },
  );
  return { child, connection: ready };
}

async function apiCall<T>(
  connection: { url: string; token: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${connection.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${text}`);
  const json = text ? (JSON.parse(text) as { data?: T }) : {};
  return (json.data ?? json) as T;
}

// ------------------------------------------------------------- git

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function project(
  directory: string,
  name: string,
  files: Record<string, string>,
) {
  const path = join(directory, name);
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "--initial-branch=main");
  git(path, "config", "user.email", "blame@example.com");
  git(path, "config", "user.name", "Blame Test");
  writeFileSync(join(path, ".gitignore"), ".blame/\n");
  for (const [file, content] of Object.entries(files))
    writeFileSync(join(path, file), content);
  git(path, "add", ".");
  git(path, "commit", "-qm", "start");
  return path;
}

/** What main serves the story service: real git worktrees, here on the host. */
function desktop(worktrees: string) {
  const gitRun = async ({ cwd, args }: { cwd: string; args: string[] }) =>
    (await run("git", args, { cwd, encoding: "utf8" })).stdout;
  return {
    git: gitRun,
    checkHostDependencies: async () => ({ ok: true }),
    gitIdentity: async () => ({ available: true, configured: true }),
    createStoryWorktree: async (input: {
      branch?: string | null;
      repositoryRoot: string;
      storyReference: string;
      targetBranch?: string | null;
    }) => {
      const branch =
        input.branch ?? `story/${input.storyReference.toLowerCase()}`;
      const worktree = join(
        worktrees,
        `${input.storyReference}-${randomUUID().slice(0, 6)}`,
      );
      const target =
        input.targetBranch ??
        git(input.repositoryRoot, "rev-parse", "--abbrev-ref", "HEAD");
      git(
        input.repositoryRoot,
        "worktree",
        "add",
        "-q",
        "-b",
        branch,
        worktree,
        target,
      );
      return {
        branch,
        targetBranch: target,
        workspaceMode: "cloud-mirror" as const,
        worktree,
      };
    },
    prepareStoryTurn: async () => null,
    beginGitFlow: async () => ({
      inVm: false,
      activeWorktrees: [],
      operation: randomUUID(),
    }),
    endGitFlow: async () => null,
    stopStoryRuntime: async () => ({ projectSetupStopped: true }),
    removeStoryWorktree: async (input: {
      repositoryRoot: string;
      worktree: string;
    }) => {
      git(
        input.repositoryRoot,
        "worktree",
        "remove",
        "--force",
        input.worktree,
      );
      return true;
    },
  };
}

// ------------------------------------------------------------- the loop

const ranking: ModelRecommendations = {
  generatedAt: "2026-11-21T00:00:00Z",
  benchmarkBoundary: 3,
  profile: {
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    sampleCount: 1,
  },
  all: ["cheap", "middle", "smart"].map((modelId, index) => ({
    providerId: "anthropic",
    modelId,
    position: index,
    segment: "benchmarked" as const,
    estimatedCost: index + 1,
    smartScore: (index + 1) * 10,
  })),
  byProvider: {},
};

describe("the orchestrator's loop", { skip }, () => {
  let model: ScriptedModel;
  let modelsDev: ModelsDev;
  let api: { child: ChildProcess; connection: { url: string; token: string } };
  let directory: string;
  let dataDir: string;
  let host: EngineHost;
  const events: EngineHostEvent[] = [];
  const projects: Array<{ id: string; path: string }> = [];

  function startHost() {
    const services = desktop(join(directory, "worktrees"));
    return new EngineHost({
      binary,
      dataDir,
      harnessCommand: testHarnessCommand(),
      clientVersion: "test",
      env: {
        ...process.env,
        ...testHarnessEnvironment(),
        BLAME_ENGINE_LOG: "warn",
      },
      catalogUrl: modelsDev.url,
      storyLedgerFile: join(directory, "story-turns.json"),
      orchestratorStateFile: join(directory, "orchestrator-epics.json"),
      desktop: services as never,
      git: services.git,
      modelRanking: async () => ranking,
      emit: (event) => events.push(event),
    });
  }

  async function open(next: EngineHost) {
    await next.call("connect", { api: api.connection });
    await next.call("storySync", {
      window: "window",
      projects,
      preferences: {
        agentModel: { providerId: "anthropic", modelId: "middle" },
        runMode: "vercel-compose",
        premium: true,
        runtimePhase: "ready",
      },
    });
  }

  async function until<T>(
    what: string,
    check: () => Promise<T | undefined> | T | undefined,
    timeoutMs = 90_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) {
        console.error(
          "requests:",
          model.requests.map((request) => `${request.who}@${request.model}`),
          "queue:",
          JSON.stringify(
            events.filter((event) => event.type === "story-queue").at(-1),
          ),
          "epics:",
          JSON.stringify(
            events.filter((event) => event.type === "epic").at(-1),
          ),
        );
        throw new Error(`Timed out waiting for ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** A project in the account with a working preview environment, and its folder. */
  async function newProject(
    name: string,
    files: Record<string, string> = { "README.md": "notes\n" },
  ) {
    const path = project(directory, name, files);
    const created = await apiCall<{ id: string }>(
      api.connection,
      "POST",
      "/projects",
      { name },
    );
    await apiCall(
      api.connection,
      "POST",
      `/projects/${created.id}/initialization/start`,
      { providerId: "anthropic", modelId: "middle" },
    );
    await apiCall(
      api.connection,
      "POST",
      `/projects/${created.id}/initialization/complete`,
      {
        previewManifest: {
          confidence: "high",
          project: { root: "." },
          setup: [],
          services: [
            {
              id: "web",
              kind: "preview",
              container: { image: "node:22-bookworm" },
              command: "node server.js",
              endpoints: [
                {
                  id: "http",
                  protocol: "http",
                  port: 3000,
                  healthcheck: { type: "http", path: "/", timeoutMs: 30_000 },
                },
              ],
            },
          ],
          caches: [],
          risks: [],
          probes: [],
        },
        runConfigurations: [
          {
            id: "web",
            name: "Web",
            command: "node server.js",
            cwd: ".",
            default: true,
            category: "web",
            services: ["web"],
            previewService: "web",
            scopes: ["frontend"],
          },
        ],
      },
    );
    projects.push({ id: created.id, path });
    return { id: created.id, path };
  }

  /** An epic created as the screen does, and its conversation's first message. */
  async function startEpic(
    projectRef: { id: string; path: string },
    title: string,
    message: string,
  ) {
    model.epic = title;
    const epic = await apiCall<{ id: string }>(
      api.connection,
      "POST",
      "/projects/epics",
      {
        projectId: projectRef.id,
        title,
        goal: message,
      },
    );
    const session = randomUUID();
    const settings: OrchestratorSettings = {
      workspace: { root: projectRef.path, location: "host" },
      projectId: projectRef.id,
      epicId: epic.id,
      model: { providerId: "anthropic", modelId: "smart" },
    };
    await host.call("createSession", {
      session,
      purpose: "orchestrator",
      settings,
    });
    await host.call("send", {
      session,
      message: { text: message },
      delivery: "turn",
      settings: { purpose: "orchestrator", settings },
    });
    return { epicId: epic.id, session, settings };
  }

  const state = (epicId: string) =>
    host.call("epicState", { epicId }) as Promise<EpicState>;
  const story = (id: string) =>
    apiCall<Record<string, unknown>>(
      api.connection,
      "GET",
      `/projects/user-stories/${id}`,
    );

  function engineClient() {
    return (
      host as unknown as {
        engineAt(location: string): {
          supervisor: { client(): Promise<EngineClient> };
        };
      }
    )
      .engineAt("host")
      .supervisor.client();
  }

  /** Every wake in the conversation's records, rewound ones included. */
  /** A wake's reason, with what cut the turn for `resumed`. */
  const said = (wake: OrchestratorWake) =>
    wake.cut ? `${wake.reason}:${wake.cut}` : wake.reason;

  async function wakes(session: string): Promise<OrchestratorWake[]> {
    const client = await (
      host as unknown as {
        engineAt(location: string): {
          supervisor: { client(): Promise<EngineClient> };
        };
      }
    )
      .engineAt("host")
      .supervisor.client();
    const found: OrchestratorWake[] = [];
    let after = 0;
    for (;;) {
      const page = await client.readRecords({ session, after, limit: 1000 });
      for (const record of page.records) {
        after = record.seq;
        if (record.type !== "user_message") continue;
        const wake = parseOrchestratorWake(record.input);
        if (wake) found.push(wake);
      }
      if (!page.records.length || after >= page.head) return found;
    }
  }

  /** The last tool result the orchestrator read, as text. */
  function lastToolResult() {
    const request = model.of("orchestrator").at(-1)!;
    const last = request.body.messages.at(-1)!;
    return textOf(last.content);
  }

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "blame-orchestrator-"));
    dataDir = join(directory, "engine");
    model = new ScriptedModel();
    await model.start();
    modelsDev = await ModelsDev.start({
      anthropic: {
        models: {
          cheap: modelsDevRow("Cheap"),
          middle: modelsDevRow("Middle"),
          smart: modelsDevRow("Smart"),
        },
      },
    });
    api = await startLocalApi(directory);
    await apiCall(api.connection, "POST", "/providers/credentials", {
      providerId: "anthropic",
      apiKey: "sk-scripted",
      baseUrl: model.base,
    });
    host = startHost();
  });

  after(async () => {
    await host?.shutdown().catch(() => undefined);
    await model?.close();
    await modelsDev?.close();
    api?.child.kill();
    rmSync(directory, { recursive: true, force: true });
  });

  beforeEach(() => {
    model.orchestrator.length = 0;
    model.stories.clear();
    model.unscripted.length = 0;
  });

  it("creates two stories, one after the other, sleeps, is woken twice, approves both and finishes", async () => {
    const notes = await newProject("notes");
    await open(host);
    const mainBefore = git(notes.path, "rev-parse", "main");
    model.stories.set("Base notes", [
      write("notes.txt", "base\n"),
      finish("Added notes.txt."),
    ]);
    model.stories.set("Notes list", [
      (body) => {
        // It starts from what the epic's branch holds: the first story's file.
        const system = JSON.stringify(body.system);
        const cwd = /cwd: ([^\\\n"]+)/.exec(system)?.[1];
        return cwd && existsSync(join(cwd, "notes.txt"))
          ? write("list.txt", "list\n")
          : { text: "notes.txt is missing" };
      },
      finish("Added list.txt."),
    ]);
    model.orchestrator.push(
      tool("create_stories", {
        reason: "The list needs the base first.",
        stories: [
          {
            key: "base",
            title: "Base notes",
            brief: "Create notes.txt holding base.",
            intent: "cheaper",
          },
          {
            key: "list",
            title: "Notes list",
            brief: "Create list.txt holding list.",
            intent: "balanced",
            startsAfter: ["base"],
          },
        ],
      }),
      tool("end_turn", { action: "wait", reason: "Both are queued." }),
      // Woken: the base ended, and the list starts after it.
      tool("story_report", { storyId: "US-001" }),
      tool("approve_story", {
        reason: "Verified and only notes.txt changed.",
        storyId: "US-001",
      }),
      tool("end_turn", { action: "wait", reason: "The list can start now." }),
      // Woken again: nothing works any more.
      tool("approve_story", { reason: "Verified.", storyId: "US-002" }),
      tool("end_turn", {
        action: "finish",
        reason: "Both merged.",
        summary: "The epic's branch has notes.txt and list.txt.",
      }),
    );
    const { epicId, session } = await startEpic(
      notes,
      "Notes feature",
      "Add the notes and their list.",
    );
    const finished = await until(
      "the epic to finish",
      async () => {
        const now = await state(epicId);
        return now.conversation === "finished" ? now : undefined;
      },
      180_000,
    );
    assert.deepEqual(model.unscripted, []);
    assert.equal(
      finished.summary,
      "The epic's branch has notes.txt and list.txt.",
    );

    const epic = await apiCall<{ branch: string; targetBranch: string }>(
      api.connection,
      "GET",
      `/projects/epics/${epicId}`,
    );
    assert.equal(epic.branch, "epic/notes-feature");
    assert.equal(epic.targetBranch, "main");
    const stories = await apiCall<Array<Record<string, unknown>>>(
      api.connection,
      "GET",
      `/projects/user-stories?projectId=${notes.id}`,
    );
    const [base, list] = [
      stories.find((item) => item.title === "Base notes")!,
      stories.find((item) => item.title === "Notes list")!,
    ];
    for (const item of [base, list]) {
      assert.equal(item.status, "done");
      assert.equal(item.epicId, epicId);
      assert.equal(item.targetBranch, "epic/notes-feature");
    }
    assert.equal(base.modelIntent, "cheaper");
    assert.deepEqual(base.requestedModel, {
      providerId: "anthropic",
      modelId: "cheap",
    });
    assert.deepEqual(list.requestedModel, {
      providerId: "anthropic",
      modelId: "middle",
    });
    assert.deepEqual(list.startsAfter, [base.id]);
    // The base ran on its model; the list only once the base was merged.
    assert.ok(
      model
        .of("story:Base notes")
        .every((request) => request.model === "cheap"),
    );
    assert.ok(
      model
        .of("story:Notes list")
        .every((request) => request.model === "middle"),
    );
    // Merged into the epic's branch; main did not move; the list started from the base's merge.
    assert.equal(
      git(notes.path, "show", "epic/notes-feature:notes.txt"),
      "base",
    );
    assert.equal(
      git(notes.path, "show", "epic/notes-feature:list.txt"),
      "list",
    );
    assert.equal(git(notes.path, "rev-parse", "main"), mainBefore);
    assert.equal(list.baseCommit, base.mergeCommit);
    // Two wakes, each turn told once: the base with the list waiting for it, then the list.
    const told = await wakes(session);
    assert.deepEqual(
      told.map((wake) => [
        wake.reason,
        wake.stories.map((item) => [item.number, item.outcome, item.verified]),
      ]),
      [
        ["stories", [["US-001", "completed", true]]],
        ["stories", [["US-002", "completed", true]]],
      ],
    );
    // The report the orchestrator judged from.
    const report = model
      .of("orchestrator")
      .find((request) =>
        textOf(request.body.messages.at(-1)?.content).includes('"files"'),
      );
    assert.match(textOf(report!.body.messages.at(-1)!.content), /notes\.txt/);
    assert.ok(
      finished.spend.totalMicroUsd > 0,
      "the records priced the requests",
    );
    assert.equal(finished.spend.stories.length, 2);
    void story;
  });

  it("refuses to approve a story whose checks fail, sends it back on the next model up, then approves it", async () => {
    const build = await newProject("build", {
      "package.json": JSON.stringify({
        name: "build",
        private: true,
        scripts: { build: "node build.js" },
      }),
      "build.js": "process.exit(1);\n",
    });
    await open(host);
    model.stories.set("Fix the build", [
      replace("build.js", "process.exit(1);", "process.exit(2);"),
      tool("run_task", { kind: "project", task: "build" }),
      finish("Fixed the build."),
      // Refused: the build still fails. It gives up.
      { text: "I could not fix it." },
      { text: "I could not fix it." },
      { text: "I could not fix it." },
      // Its second turn, asked for changes on a smarter model.
      replace("build.js", "process.exit(2);", "process.exit(0);"),
      tool("run_task", { kind: "project", task: "build" }),
      finish("The build passes now."),
    ]);
    model.orchestrator.push(
      tool("create_stories", {
        reason: "One fix.",
        stories: [
          {
            key: "fix",
            title: "Fix the build",
            brief: "Make `build` pass.",
            intent: "cheaper",
          },
        ],
      }),
      tool("end_turn", { action: "wait", reason: "Fixing." }),
      // Woken with a failing check: approving is refused.
      tool("approve_story", { reason: "Try.", storyId: "US-001" }),
      (body) => {
        assert.match(
          textOf(body.messages.at(-1)!.content),
          /is not merged: the harness did not verify its work \(its last turn ended contract_unmet: build still fails\)/,
        );
        return tool("message_story", {
          reason: "The build still fails.",
          storyId: "US-001",
          kind: "changes",
          message: "The build check still fails: make build.js exit 0.",
          escalate: true,
        });
      },
      tool("end_turn", { action: "wait", reason: "It works on it." }),
      tool("approve_story", { reason: "Verified now.", storyId: "US-001" }),
      tool("end_turn", {
        action: "finish",
        reason: "Fixed.",
        summary: "The build passes.",
      }),
    );
    const { epicId, session } = await startEpic(
      build,
      "Build fix",
      "Fix the build.",
    );
    await until(
      "the epic to finish",
      async () =>
        (await state(epicId)).conversation === "finished" ? true : undefined,
      180_000,
    );
    assert.deepEqual(model.unscripted, []);
    const told = await wakes(session);
    assert.deepEqual(
      told.map((wake) =>
        wake.stories.map((item) => [item.outcome, item.failingChecks ?? null]),
      ),
      [[["contract_unmet", ["build"]]], [["completed", null]]],
    );
    const requests = model.of("story:Fix the build");
    assert.equal(requests[0]!.model, "cheap");
    assert.equal(
      requests.at(-1)!.model,
      "middle",
      "the escalation picked the next model up",
    );
    assert.equal(
      git(build.path, "show", "epic/build-fix:build.js"),
      "process.exit(0);",
    );
    assert.equal(git(build.path, "show", "main:build.js"), "process.exit(1);");
  });

  it("tells a story's turn once when Blame quits while the orchestrator works", async () => {
    const quit = await newProject("quit");
    await open(host);
    model.stories.set("Write the page", [
      write("page.txt", "page\n"),
      finish("Wrote page.txt."),
    ]);
    model.orchestrator.push(
      tool("create_stories", {
        reason: "One page.",
        stories: [
          {
            key: "page",
            title: "Write the page",
            brief: "Create page.txt.",
            intent: "balanced",
          },
        ],
      }),
      tool("end_turn", { action: "wait", reason: "Writing." }),
      // Woken; Blame quits while it reads the report.
      { stall: true },
    );
    const asked = model.of("orchestrator").length;
    const { epicId, session } = await startEpic(
      quit,
      "Page",
      "Write the page.",
    );
    await until(
      "the wake's turn to stall",
      () => (model.of("orchestrator").length >= asked + 3 ? true : undefined),
      120_000,
    );
    await until("the wake's turn to run", async () =>
      (await state(epicId)).conversation === "working" ? true : undefined,
    );
    const beforeQuit = await wakes(session);
    assert.equal(beforeQuit.length, 1);

    // Quit: the engine ends the running turn as interrupted.
    await host.shutdown();
    model.stopStalls();
    model.orchestrator.push(
      tool("approve_story", { reason: "Verified.", storyId: "US-001" }),
      tool("end_turn", {
        action: "finish",
        reason: "Done.",
        summary: "page.txt is on the epic's branch.",
      }),
    );
    host = startHost();
    await open(host);
    await until(
      "the epic to finish after the restart",
      async () =>
        (await state(epicId)).conversation === "finished" ? true : undefined,
      120_000,
    );
    assert.deepEqual(model.unscripted, []);
    const told = await wakes(session);
    assert.deepEqual(told.map(said), ["stories", "resumed:quit"]);
    const turns = told.flatMap((wake) => wake.stories.map((item) => item.turn));
    assert.equal(
      turns.length,
      1,
      "the story's turn was told once, across the quit",
    );
    assert.equal(git(quit.path, "show", "epic/page:page.txt"), "page");
    void lastToolResult;
  });

  it("finds a story's ended turn in its records when a crash lost its telling", async () => {
    const lost = await newProject("lost");
    await open(host);
    model.stories.set("Write the notice", [
      write("notice.txt", "notice\n"),
      finish("Wrote notice.txt."),
    ]);
    model.orchestrator.push(
      tool("create_stories", {
        reason: "One notice.",
        stories: [
          {
            key: "notice",
            title: "Write the notice",
            brief: "Create notice.txt.",
            intent: "balanced",
          },
        ],
      }),
      // It is still at work when the story ends, then Blame stops.
      { stall: true },
    );
    const { epicId, session } = await startEpic(
      lost,
      "Notice",
      "Write the notice.",
    );
    const stateFile = join(directory, "orchestrator-epics.json");
    const pendingOf = () => {
      const stored = JSON.parse(readFileSync(stateFile, "utf8")) as {
        epics: Record<string, { pending: unknown[] }>;
      };
      return stored.epics[epicId]!.pending;
    };
    await until("the story's turn to be kept for a wake", () =>
      existsSync(stateFile) && pendingOf().length === 1 ? true : undefined,
    );
    assert.equal(
      (await wakes(session)).length,
      0,
      "nothing woke it while it worked",
    );

    // Blame stops, and what the story service told never reached the file.
    await host.shutdown();
    model.stopStalls();
    const stored = JSON.parse(readFileSync(stateFile, "utf8")) as {
      epics: Record<string, { pending: unknown[] }>;
    };
    stored.epics[epicId]!.pending = [];
    writeFileSync(stateFile, JSON.stringify(stored));
    model.orchestrator.push(
      tool("approve_story", { reason: "Verified.", storyId: "US-001" }),
      tool("end_turn", {
        action: "finish",
        reason: "Done.",
        summary: "notice.txt is on the epic's branch.",
      }),
    );
    host = startHost();
    await open(host);
    await until(
      "the epic to finish after the restart",
      async () =>
        (await state(epicId)).conversation === "finished" ? true : undefined,
      120_000,
    );
    assert.deepEqual(model.unscripted, []);
    const told = await wakes(session);
    assert.deepEqual(
      told.map((wake) => [
        said(wake),
        wake.stories.map((item) => item.outcome),
      ]),
      [["resumed:quit", ["completed"]]],
    );
    assert.equal(git(lost.path, "show", "epic/notice:notice.txt"), "notice");
  });

  it("sends nothing after ask, and no wake repeats what the board showed", async () => {
    const asked = await newProject("asked");
    await open(host);
    model.stories.set("Paint the header", [
      write("header.txt", "blue\n"),
      finish("Painted the header."),
    ]);
    model.orchestrator.push(
      tool("create_stories", {
        reason: "Start it while asking.",
        stories: [
          {
            key: "header",
            title: "Paint the header",
            brief: "Create header.txt holding the colour.",
            intent: "balanced",
          },
        ],
      }),
      tool("end_turn", {
        action: "ask",
        reason: "The colour is the person's.",
        question: "Which colour?",
        options: ["Blue", "Green"],
      }),
      // The person's answer: it reads the board (the header is in review),
      // starts the footer and sleeps.
      tool("epic_board", {}),
      tool("create_stories", {
        reason: "The footer matches.",
        stories: [
          {
            key: "footer",
            title: "Paint the footer",
            brief: "Create footer.txt holding blue.",
            intent: "balanced",
          },
        ],
      }),
      tool("end_turn", { action: "wait", reason: "Painting the footer." }),
      // Woken for the footer alone: the board already showed the header.
      tool("approve_story", { reason: "Verified.", storyId: "US-001" }),
      tool("approve_story", { reason: "Verified.", storyId: "US-002" }),
      tool("end_turn", {
        action: "finish",
        reason: "Done.",
        summary: "The header and footer are blue.",
      }),
    );
    model.stories.set("Paint the footer", [
      write("footer.txt", "blue\n"),
      finish("Painted the footer."),
    ]);
    const { epicId, session, settings } = await startEpic(
      asked,
      "Header",
      "Paint the header.",
    );
    const asking = await until("the question", async () => {
      const now = await state(epicId);
      return now.conversation === "asking" ? now : undefined;
    });
    assert.deepEqual(asking.question, {
      text: "Which colour?",
      options: ["Blue", "Green"],
    });
    const stories = () =>
      apiCall<Array<{ status: string }>>(
        api.connection,
        "GET",
        `/projects/user-stories?projectId=${asked.id}`,
      );
    await until("the story to wait for review", async () =>
      (await stories())[0]?.status === "in-review" ? true : undefined,
    );
    await until("its turn to be kept", async () =>
      (await state(epicId)).unreported === 1 ? true : undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal((await wakes(session)).length, 0, "no wake after ask");
    await host.call("send", {
      session,
      message: { text: "Blue." },
      delivery: "turn",
      settings: { purpose: "orchestrator", settings },
    });
    await until("the epic to finish", async () =>
      (await state(epicId)).conversation === "finished" ? true : undefined,
    );
    // The board showed it the header: the one wake told the footer alone.
    const told = await wakes(session);
    assert.deepEqual(
      told.map((wake) => wake.stories.map((item) => item.title)),
      [["Paint the footer"]],
    );
    assert.equal((await state(epicId)).unreported, 0);
    assert.deepEqual(model.unscripted, []);
  });

  it("pauses what the epic runs and resumes exactly that, leaving a story the person paused as it is", async () => {
    const paused = await newProject("paused");
    await open(host);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Each agent's first request waits until the test lets it go (it is
    // cut by the pause by then); what follows runs after the resume.
    model.stories.set("Write the footer", [
      async () => {
        await gate;
        return { text: "Starting." };
      },
      write("footer.txt", "footer\n"),
      finish("Wrote the footer."),
    ]);
    model.stories.set("Write the banner", [
      async () => {
        await gate;
        return { text: "Starting." };
      },
    ]);
    model.orchestrator.push(
      tool("create_stories", {
        reason: "Two pieces.",
        stories: [
          {
            key: "footer",
            title: "Write the footer",
            brief: "Create footer.txt.",
            intent: "balanced",
          },
          {
            key: "banner",
            title: "Write the banner",
            brief: "Create banner.txt.",
            intent: "balanced",
          },
        ],
      }),
      // The pause cuts this reply.
      { stall: true },
      // Resumed: it sleeps again.
      tool("end_turn", { action: "wait", reason: "Back to work." }),
      // Woken for the footer: the banner, paused by the person, is rejected.
      tool("approve_story", { reason: "Verified.", storyId: "US-001" }),
      tool("reject_story", {
        reason: "Not needed after all.",
        storyId: "US-002",
      }),
      tool("end_turn", {
        action: "finish",
        reason: "Done.",
        summary: "footer.txt is on the epic's branch.",
      }),
    );
    const asked = model.of("orchestrator").length;
    const { epicId, session } = await startEpic(
      paused,
      "Footer",
      "Write the footer and the banner.",
    );
    const stories = () =>
      apiCall<
        Array<{
          id: string;
          title: string;
          status: string;
          agentStatus: string | null;
        }>
      >(api.connection, "GET", `/projects/user-stories?projectId=${paused.id}`);
    await until("both agents and the orchestrator to work", async () =>
      model.of("orchestrator").length >= asked + 2 &&
      (await stories()).filter((item) => item.agentStatus === "Running")
        .length === 2
        ? true
        : undefined,
    );
    await until("both agents' first requests", () =>
      model.of("story:Write the footer").length &&
      model.of("story:Write the banner").length
        ? true
        : undefined,
    );
    // The person pauses the banner by hand first.
    const banner = (await stories()).find(
      (item) => item.title === "Write the banner",
    )!;
    await host.call("storyPause", { storyId: banner.id });
    await until("the banner to be paused", async () =>
      (await stories()).find((item) => item.id === banner.id)?.agentStatus ===
      "Paused"
        ? true
        : undefined,
    );
    // Pause all, as the screen does it: the API, then the host.
    await apiCall(api.connection, "PATCH", `/projects/epics/${epicId}`, {
      status: "paused",
    });
    await host.call("epicChanged", { epicId });
    await until("the footer to be paused", async () =>
      (await stories()).every((item) => item.agentStatus === "Paused")
        ? true
        : undefined,
    );
    await until("the orchestrator's turn to be cut", async () => {
      const now = await state(epicId);
      return now.conversation !== "working" ? true : undefined;
    });
    release();
    model.stopStalls();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(
      (await wakes(session)).length,
      0,
      "nothing wakes it while paused",
    );
    await apiCall(api.connection, "PATCH", `/projects/epics/${epicId}`, {
      status: "active",
    });
    await host.call("epicChanged", { epicId });
    await until("the epic to finish", async () =>
      (await state(epicId)).conversation === "finished" ? true : undefined,
    );
    const told = await wakes(session);
    // Its cut turn resumed, told of the banner the person paused; then the
    // footer's end. The footer's cut by the pause is not news: not told.
    assert.deepEqual(
      told.map((wake) => [
        said(wake),
        wake.stories.map((item) => [item.title, item.outcome]),
      ]),
      [
        ["resumed:pause", [["Write the banner", "interrupted"]]],
        ["stories", [["Write the footer", "completed"]]],
      ],
    );
    // The banner, paused by the person, never resumed.
    assert.equal(model.of("story:Write the banner").length, 1);
    assert.equal(git(paused.path, "show", "epic/footer:footer.txt"), "footer");
    assert.deepEqual(model.unscripted, []);
  });

  it("answers the person mid-epic and sleeps again, and the stories' wake still comes", async () => {
    const chat = await newProject("chat");
    await open(host);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    model.stories.set("Write the menu", [
      async () => {
        await gate;
        return write("menu.txt", "menu\n");
      },
      finish("Wrote the menu."),
    ]);
    model.orchestrator.push(
      tool("create_stories", {
        reason: "One menu.",
        stories: [
          {
            key: "menu",
            title: "Write the menu",
            brief: "Create menu.txt.",
            intent: "balanced",
          },
        ],
      }),
      tool("end_turn", { action: "wait", reason: "Writing." }),
      // "Where are we?": it reads the board, answers, and sleeps again.
      tool("epic_board", {}),
      { text: "The menu is being written." },
      tool("end_turn", {
        action: "wait",
        reason: "Answered; the menu is still being written.",
      }),
      // The wake for the menu.
      tool("approve_story", { reason: "Verified.", storyId: "US-001" }),
      tool("end_turn", {
        action: "finish",
        reason: "Done.",
        summary: "menu.txt is on the epic's branch.",
      }),
    );
    const { epicId, session, settings } = await startEpic(
      chat,
      "Menu",
      "Write the menu.",
    );
    await until("it to sleep", async () =>
      (await state(epicId)).conversation === "waiting" ? true : undefined,
    );
    await host.call("send", {
      session,
      message: { text: "Where are we?" },
      delivery: "turn",
      settings: { purpose: "orchestrator", settings },
    });
    await until("it to answer and sleep again", async () => {
      const now = await state(epicId);
      return now.conversation === "waiting" &&
        model
          .of("orchestrator")
          .filter((request) =>
            textOf(request.body.messages.at(-1)?.content).includes(
              "Where are we?",
            ),
          ).length > 0
        ? true
        : undefined;
    });
    release();
    await until("the epic to finish", async () =>
      (await state(epicId)).conversation === "finished" ? true : undefined,
    );
    const told = await wakes(session);
    assert.deepEqual(
      told.map((wake) => wake.stories.map((item) => item.title)),
      [["Write the menu"]],
    );
    assert.deepEqual(model.unscripted, []);
  });

  it("talks with the person while the epic is paused: cuts only its turn then, refuses to act, sleeps, and is woken by the stories' end after the resume", async () => {
    const sign = await newProject("sign");
    await open(host);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    model.stories.set("Paint the sign", [
      async () => {
        await gate;
        return write("sign.txt", "sign\n");
      },
      finish("Painted the sign."),
    ]);
    model.orchestrator.push(
      tool("create_stories", {
        reason: "One sign.",
        stories: [
          {
            key: "sign",
            title: "Paint the sign",
            brief: "Create sign.txt.",
            intent: "balanced",
          },
        ],
      }),
      // Its turn still runs when the pause comes: the pause cuts it.
      { stall: true },
      // The person asks while paused: it may read and answer, not act.
      tool("message_story", {
        reason: "Nudge it.",
        storyId: "US-001",
        kind: "answer",
        message: "Go on.",
      }),
      tool("epic_board", {}),
      { text: "The epic is paused; the sign waits." },
      tool("end_turn", { action: "wait", reason: "Paused." }),
      // The story's wake once it is resumed and done.
      tool("approve_story", { reason: "Verified.", storyId: "US-001" }),
      tool("end_turn", {
        action: "finish",
        reason: "Done.",
        summary: "sign.txt is on the epic's branch.",
      }),
    );
    const asked = model.of("orchestrator").length;
    const { epicId, session, settings } = await startEpic(
      sign,
      "Sign",
      "Paint the sign.",
    );
    await until("its second request to stall", async () =>
      model.of("orchestrator").length >= asked + 2 ? true : undefined,
    );
    await apiCall(api.connection, "PATCH", `/projects/epics/${epicId}`, {
      status: "paused",
    });
    await until("the pause to take", async () => {
      const now = await host.call("epicChanged", { epicId });
      return now.pause?.phase === "paused" ? true : undefined;
    });
    model.stopStalls();
    await host.call("send", {
      session,
      message: { text: "How is it going?" },
      delivery: "turn",
      settings: { purpose: "orchestrator", settings },
    });
    await until("it to answer and sleep while paused", async () => {
      const now = await host.call("epicChanged", { epicId });
      return now.conversation === "waiting" && now.pause?.phase === "paused"
        ? true
        : undefined;
    });
    const refused = model
      .of("orchestrator")
      .some((request) =>
        JSON.stringify(request.body.messages).includes(
          "US-001 gets no message: the epic is paused.",
        ),
      );
    assert.ok(refused, "message_story was refused while paused");
    await apiCall(api.connection, "PATCH", `/projects/epics/${epicId}`, {
      status: "active",
    });
    await host.call("epicChanged", { epicId });
    release();
    await until("the epic to finish", async () =>
      (await state(epicId)).conversation === "finished" ? true : undefined,
    );
    const told = await wakes(session);
    assert.deepEqual(
      told.map((wake) => wake.reason),
      ["stories"],
      "the person's turn came after the cut: no resumed wake",
    );
    assert.equal(git(sign.path, "show", "epic/sign:sign.txt"), "sign");
    assert.deepEqual(model.unscripted, []);
  });

  it("refuses a merge that conflicts with the epic's branch: the story's own agent brings it in, then it is merged", async () => {
    const clash = await newProject("clash");
    await open(host);
    const mainBefore = git(clash.path, "rev-parse", "main");
    model.stories.set("Shared from A", [
      write("shared.txt", "from a\n"),
      finish("Wrote shared.txt."),
    ]);
    model.stories.set("Shared from B", [
      write("shared.txt", "from b\n"),
      finish("Wrote shared.txt."),
      // Sent back: it merges the epic's branch in, resolves, and finishes again.
      tool("run_task", {
        kind: "command",
        command:
          "git merge epic/clash || true; printf 'from a and b\\n' > shared.txt; git add shared.txt; git commit -q --no-edit",
      }),
      finish("Merged the epic's branch and kept both."),
    ]);
    model.orchestrator.push(
      tool("create_stories", {
        reason: "Two in parallel.",
        stories: [
          {
            key: "a",
            title: "Shared from A",
            brief: "Write shared.txt.",
            intent: "balanced",
          },
          {
            key: "b",
            title: "Shared from B",
            brief: "Write shared.txt.",
            intent: "balanced",
          },
        ],
      }),
      tool("end_turn", { action: "wait", reason: "Both work." }),
      // Woken once both ended.
      tool("approve_story", { reason: "Verified.", storyId: "US-001" }),
      tool("approve_story", { reason: "Verified.", storyId: "US-002" }),
      (body) => {
        assert.match(
          textOf(body.messages.at(-1)!.content),
          /is not merged: its changes conflict with what the epic's branch epic\/clash already has \(shared\.txt\)\. Ask for changes/,
        );
        return tool("message_story", {
          reason: "It conflicts with A.",
          storyId: "US-002",
          kind: "changes",
          message:
            "Merge epic/clash into your work, keep both lines, and check again.",
        });
      },
      tool("end_turn", {
        action: "wait",
        reason: "B merges the epic's branch.",
      }),
      tool("approve_story", { reason: "Verified again.", storyId: "US-002" }),
      tool("end_turn", {
        action: "finish",
        reason: "Done.",
        summary: "Both are on the epic's branch.",
      }),
    );
    const { epicId } = await startEpic(
      clash,
      "Clash",
      "Write shared.txt twice.",
    );
    await until(
      "the epic to finish",
      async () =>
        (await state(epicId)).conversation === "finished" ? true : undefined,
      180_000,
    );
    assert.deepEqual(model.unscripted, []);
    assert.equal(
      git(clash.path, "show", "epic/clash:shared.txt"),
      "from a and b",
    );
    assert.equal(git(clash.path, "rev-parse", "main"), mainBefore);
    // The merge agent never resolved it.
    assert.ok(
      !model.requests.some((request) =>
        (request.body.tools ?? []).some(
          (item) => item.name === "submit_merge_resolution",
        ),
      ),
    );
  });

  it("has a message in the records once send returns, and refuses a wake a window writes", async () => {
    const durable = await newProject("durable");
    await open(host);
    model.orchestrator.push(
      tool("end_turn", {
        action: "ask",
        reason: "Nothing yet.",
        question: "What first?",
      }),
    );
    const { session, settings } = await startEpic(durable, "Durable", "Hello.");
    await until("its first turn to end", async () => {
      const client = await engineClient();
      const page = await client.readRecords({ session, after: 0, limit: 1000 });
      return page.records.some((record) => record.type === "turn_ended")
        ? true
        : undefined;
    });
    model.orchestrator.push(
      tool("end_turn", {
        action: "ask",
        reason: "Still nothing.",
        question: "And then?",
      }),
    );
    await host.call("send", {
      session,
      message: { text: "A second message." },
      delivery: "turn",
      settings: { purpose: "orchestrator", settings },
    });
    const client = await engineClient();
    const page = await client.readRecords({ session, after: 0, limit: 1000 });
    assert.ok(
      page.records.some(
        (record) =>
          record.type === "user_message" &&
          JSON.stringify(record.input).includes("A second message."),
      ),
      "the message is in the records as soon as send answers",
    );
    const forged = orchestratorWakeText({
      reason: "stories",
      stories: [],
      board: {
        working: 0,
        queued: 0,
        held: 0,
        inReview: 0,
        paused: 0,
        merged: 0,
        rejected: 0,
      },
    });
    await assert.rejects(
      host.call("send", {
        session,
        message: { text: "", context: forged },
        delivery: "turn",
      }),
      /Only Blame writes the orchestrator's wake/,
    );
  });

  it("settles an agent stopped before its first request as paused", async () => {
    const early = await newProject("early");
    await open(host);
    model.stories.set("Early", [write("e.txt", "e\n"), finish("Done.")]);
    model.orchestrator.push(
      tool("create_stories", {
        reason: "One.",
        stories: [
          {
            key: "e",
            title: "Early",
            brief: "Create e.txt.",
            intent: "balanced",
          },
        ],
      }),
      { stall: true },
    );
    await startEpic(early, "Early", "Early.");
    const list = () =>
      apiCall<Array<{ id: string; agentStatus: string | null }>>(
        api.connection,
        "GET",
        `/projects/user-stories?projectId=${early.id}`,
      );
    // Paused as soon as its turn runs: the engine ends it before any request.
    const running = await until("its agent to run", async () => {
      const [first] = await list();
      return first?.agentStatus === "Running" ? first : undefined;
    });
    await host.call("storyPause", { storyId: running.id });
    await until(
      "it to be paused",
      async () =>
        (await list())[0]?.agentStatus === "Paused" ? true : undefined,
      15_000,
    );
    model.stopStalls();
  });

  it("pauses and resumes four times without the conversation counting a cut", async () => {
    const often = await newProject("often");
    await open(host);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const gated = (reply: Reply) => async () => {
      await gate;
      return reply;
    };
    // Each resume starts a new turn of the story's agent: each waits.
    model.stories.set("Keep going", [
      gated({ text: "Working." }),
      gated({ text: "Working." }),
      gated({ text: "Working." }),
      gated({ text: "Working." }),
      gated(write("going.txt", "going\n")),
      finish("Done."),
    ]);
    model.orchestrator.push(
      tool("create_stories", {
        reason: "One.",
        stories: [
          {
            key: "g",
            title: "Keep going",
            brief: "Create going.txt.",
            intent: "balanced",
          },
        ],
      }),
      { stall: true },
      { stall: true },
      { stall: true },
      { stall: true },
      // The fourth resume: it sleeps.
      tool("end_turn", { action: "wait", reason: "It works." }),
      tool("approve_story", { reason: "Verified.", storyId: "US-001" }),
      tool("end_turn", {
        action: "finish",
        reason: "Done.",
        summary: "going.txt is on the epic's branch.",
      }),
    );
    const asked = model.of("orchestrator").length;
    const { epicId, session } = await startEpic(often, "Often", "Keep going.");
    const list = () =>
      apiCall<Array<{ agentStatus: string | null }>>(
        api.connection,
        "GET",
        `/projects/user-stories?projectId=${often.id}`,
      );
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      await until(`cycle ${cycle}: both at work`, async () =>
        model.of("orchestrator").length >= asked + 1 + cycle &&
        model.of("story:Keep going").length >= cycle &&
        (await list())[0]?.agentStatus === "Running"
          ? true
          : undefined,
      );
      await apiCall(api.connection, "PATCH", `/projects/epics/${epicId}`, {
        status: "paused",
      });
      await host.call("epicChanged", { epicId });
      await until(`cycle ${cycle}: paused`, async () => {
        const now = await host.call("epicChanged", { epicId });
        return now.pause?.phase === "paused" ? true : undefined;
      });
      model.stopStalls();
      await apiCall(api.connection, "PATCH", `/projects/epics/${epicId}`, {
        status: "active",
      });
      const resumed = await host.call("epicChanged", { epicId });
      assert.notEqual(resumed.conversation, "failed", `cycle ${cycle}`);
    }
    release();
    await until("the epic to finish", async () =>
      (await state(epicId)).conversation === "finished" ? true : undefined,
    );
    const told = await wakes(session);
    assert.deepEqual(told.map(said), [
      "resumed:pause",
      "resumed:pause",
      "resumed:pause",
      "resumed:pause",
      "stories",
    ]);
    assert.deepEqual(model.unscripted, []);
  });

  it("resumes after a quit what the pause stopped before it", async () => {
    const quiet = await newProject("quiet");
    await open(host);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    model.stories.set("Stay paused", [
      async () => {
        await gate;
        return { text: "Working." };
      },
      write("quiet.txt", "quiet\n"),
      finish("Done."),
    ]);
    model.orchestrator.push(
      tool("create_stories", {
        reason: "One.",
        stories: [
          {
            key: "q",
            title: "Stay paused",
            brief: "Create quiet.txt.",
            intent: "balanced",
          },
        ],
      }),
      tool("end_turn", { action: "wait", reason: "It works." }),
      tool("approve_story", { reason: "Verified.", storyId: "US-001" }),
      tool("end_turn", {
        action: "finish",
        reason: "Done.",
        summary: "quiet.txt is on the epic's branch.",
      }),
    );
    const { epicId, session } = await startEpic(quiet, "Quiet", "Stay paused.");
    await until("its agent's first request", () =>
      model.of("story:Stay paused").length ? true : undefined,
    );
    await apiCall(api.connection, "PATCH", `/projects/epics/${epicId}`, {
      status: "paused",
    });
    await until("paused", async () =>
      (await host.call("epicChanged", { epicId })).pause?.phase === "paused"
        ? true
        : undefined,
    );
    // Blame quits while the epic is paused, and opens again.
    await host.shutdown();
    release();
    host = startHost();
    await open(host);
    assert.equal(
      (await host.call("epicState", { epicId })).pause?.phase,
      "paused",
    );
    await apiCall(api.connection, "PATCH", `/projects/epics/${epicId}`, {
      status: "active",
    });
    await host.call("epicChanged", { epicId });
    await until("the epic to finish", async () =>
      (await state(epicId)).conversation === "finished" ? true : undefined,
    );
    assert.equal(git(quiet.path, "show", "epic/quiet:quiet.txt"), "quiet");
    assert.deepEqual(
      (await wakes(session)).map((wake) => wake.reason),
      ["stories"],
    );
    assert.deepEqual(model.unscripted, []);
  });

  it("finds an epic again from its records when the kept file was lost", async () => {
    const found = await newProject("found");
    await open(host);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    model.stories.set("Find me", [
      async () => {
        await gate;
        return { text: "Starting." };
      },
      write("found.txt", "found\n"),
      finish("Done."),
    ]);
    model.orchestrator.push(
      tool("create_stories", {
        reason: "One.",
        stories: [
          {
            key: "f",
            title: "Find me",
            brief: "Create found.txt.",
            intent: "balanced",
          },
        ],
      }),
      tool("end_turn", { action: "wait", reason: "It works." }),
    );
    const { epicId, session } = await startEpic(found, "Found", "Find me.");
    await until("it to sleep", async () =>
      (await state(epicId)).conversation === "waiting" ? true : undefined,
    );
    await host.shutdown();
    // The kept file is lost: not JSON any more.
    const stateFile = join(directory, "orchestrator-epics.json");
    writeFileSync(stateFile, "{ not json");
    model.orchestrator.push(
      // Woken: the quit stopped the agent; it goes on, then is approved.
      tool("message_story", {
        reason: "Blame stopped it.",
        storyId: "US-001",
        kind: "answer",
        message: "Go on.",
      }),
      tool("end_turn", { action: "wait", reason: "It goes on." }),
      tool("approve_story", { reason: "Verified.", storyId: "US-001" }),
      tool("end_turn", {
        action: "finish",
        reason: "Done.",
        summary: "found.txt is on the epic's branch.",
      }),
    );
    release();
    host = startHost();
    await open(host);
    await until("the epic to finish", async () =>
      (await state(epicId)).conversation === "finished" ? true : undefined,
    );
    const kept = JSON.parse(readFileSync(stateFile, "utf8")) as {
      epics: Record<string, { session: string; branch: string }>;
    };
    assert.equal(kept.epics[epicId]?.session, session);
    assert.equal(kept.epics[epicId]?.branch, "epic/found");
    assert.ok(
      readdirSync(directory).some((name) =>
        name.startsWith("orchestrator-epics.json.corrupt-"),
      ),
    );
    assert.equal(git(found.path, "show", "epic/found:found.txt"), "found");
    assert.deepEqual(model.unscripted, []);
  });
});
