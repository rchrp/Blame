import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentBrowserError,
  type AgentBrowserRun,
} from "./agent-browser-cli.ts";
import {
  PreviewDevtoolsService,
  type PreviewDevtoolsCall,
  type PreviewDevtoolsEndpoint,
} from "./preview-devtools-service.ts";
import { workspaceUploadRelativePath } from "./preview-devtools-uploads.ts";

type Answer = (
  run: AgentBrowserRun,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

function harness(answer: Answer = () => ({})) {
  const runs: AgentBrowserRun[] = [];
  const endpoints: Array<PreviewDevtoolsEndpoint & { end(): void }> = [];
  let pageUrl = "http://127.0.0.1:5173/";
  const service = new PreviewDevtoolsService(async (run) => {
    runs.push(run);
    if (run.args[0] === "get" && run.args[1] === "url") return { url: pageUrl };
    if (run.args[0] === "open") pageUrl = run.args[1]!;
    return answer(run);
  });
  const input = (
    toolName: string,
    args: Record<string, unknown> = {},
  ): PreviewDevtoolsCall => ({
    arguments: args,
    currentUrl: "http://127.0.0.1:5173/",
    async openEndpoint() {
      let end!: () => void;
      const closed = new Promise<void>((resolve) => (end = resolve));
      const endpoint = {
        close: async () => end(),
        closed,
        end: () => end(),
        pageUrl: () => pageUrl,
        viewport: { height: 900, width: 1440 },
        wsEndpoint: `ws://127.0.0.1:1/devtools/browser/token-${endpoints.length + 1}`,
      };
      endpoints.push(endpoint);
      return endpoint;
    },
    pageIdentity: "page-1",
    previewOrigin: "http://127.0.0.1:5173",
    scope: "story-1",
    toolName,
    worktree: "/tmp/blame-preview-devtools-test",
  });
  const commands = () => runs.map((run) => run.args.join(" "));
  return {
    commands,
    endpoints,
    input,
    runs,
    service,
    setUrl: (url: string) => (pageUrl = url),
  };
}

function text(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

test("the agent sees a small, closed set of tools", async () => {
  const tools = await new PreviewDevtoolsService(async () => ({})).listTools();
  assert.equal(new Set(tools.map(({ name }) => name)).size, tools.length);
  assert.ok(tools.length <= 20, `${tools.length} tools`);
  for (const tool of tools)
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  // Sent with every request: chrome-devtools-mcp's twenty took 14.5k chars.
  const size = JSON.stringify(tools).length;
  assert.ok(size < 7_500, `tool schemas take ${size} chars`);
});

test("one session attaches once, then runs each tool as an agent-browser command", async () => {
  const { commands, endpoints, input, runs, service } = harness((run) =>
    run.args[0] === "snapshot"
      ? {
          origin: "http://127.0.0.1:5173/",
          snapshot: '- button "Save" [ref=e1]',
        }
      : {},
  );
  const snapshot = await service.call(input("take_snapshot"));
  assert.match(text(snapshot), /button "Save" \[ref=e1\]/u);
  await service.call(input("click", { target: "@e1" }));
  await service.call(input("fill", { target: "#name", value: "" }));
  await service.call(input("press_key", { key: "Enter" }));
  await service.call(input("drag", { from: "@e1", to: "@e2" }));
  assert.deepEqual(commands(), [
    "get url",
    "snapshot -i",
    "click @e1",
    "fill #name ",
    "press Enter",
    "drag @e1 @e2",
  ]);
  assert.equal(endpoints.length, 1);
  assert.equal(new Set(runs.map(({ session }) => session)).size, 1);
  // The token reaches agent-browser through its endpoint, never its arguments.
  assert.ok(
    runs.every(({ endpoint }) => endpoint === endpoints[0]!.wsEndpoint),
  );
  assert.ok(runs.every(({ args }) => !args.join(" ").includes("token-")));
  await service.dispose();
  assert.equal(commands().at(-1), "close");
});

test("unknown tools fail before any browser connection", async () => {
  const { endpoints, input, service } = harness();
  await assert.rejects(
    service.call(input("lighthouse_audit")),
    /unavailable: lighthouse_audit/u,
  );
  assert.equal(endpoints.length, 0);
});

test("navigation stays on the preview and accepts a path", async () => {
  const { commands, input, service } = harness();
  const outside = await service.call(
    input("navigate_page", { type: "url", url: "https://example.com/" }),
  );
  assert.equal(outside.isError, true);
  assert.match(
    text(outside),
    /can only open this story's preview \(http:\/\/127\.0\.0\.1:5173\)/u,
  );
  await service.call(input("navigate_page", { url: "/settings?tab=2" }));
  await service.call(input("navigate_page", { type: "back" }));
  // The page being left takes its console messages with it.
  assert.deepEqual(commands().slice(1), [
    "console --clear",
    "errors --clear",
    "open http://127.0.0.1:5173/settings?tab=2",
    "console --clear",
    "errors --clear",
    "back",
  ]);
  await service.dispose();
});

test("a page's answer is a tool error and keeps the connection", async () => {
  const { endpoints, input, service } = harness((run) => {
    if (run.args[0] === "click")
      throw new AgentBrowserError("Element not found: #nope.");
    return {};
  });
  const result = await service.call(input("click", { target: "#nope" }));
  assert.equal(result.isError, true);
  assert.match(text(result), /Element not found/u);
  await service.call(input("hover", { target: "#ok" }));
  assert.equal(endpoints.length, 1);
  await service.dispose();
});

test("a command that never answers resets the connection, and the next call restores the page", async () => {
  let stuck = true;
  const { commands, endpoints, input, runs, service, setUrl } = harness(
    (run) => {
      if (run.args[0] === "eval" && stuck) {
        stuck = false;
        throw new AgentBrowserError(
          "agent-browser did not answer within 13 s.",
          {
            unanswered: true,
          },
        );
      }
      return {};
    },
  );
  await service.call(
    input("emulate", {
      colorScheme: "dark",
      viewport: { width: 941, height: 620 },
    }),
  );
  await service.call(input("navigate_page", { url: "/second" }));
  await assert.rejects(
    service.call(
      input("evaluate_script", { expression: "new Promise(() => {})" }),
    ),
    /evaluate_script did not finish within 15 s\. The browser connection was reset/u,
  );
  const firstSession = runs[0]!.session;
  // The new browser page starts again from the preview's address.
  setUrl("http://127.0.0.1:5173/");
  const next = await service.call(input("take_snapshot", { mode: "text" }));
  assert.match(
    text(next),
    /reconnected after the previous call ran out of time.*Restored: emulation \(viewport 941×620, dark color scheme\), page \/second/u,
  );
  assert.equal(endpoints.length, 2);
  assert.ok(commands().includes("close"), "the stuck session is closed");
  const after = runs.slice(
    runs.findIndex(({ args }) => args[0] === "close") + 1,
  );
  assert.ok(after.every(({ session }) => session !== firstSession));
  assert.deepEqual(
    after.map(({ args }) => args.join(" ")),
    [
      "get url",
      "set viewport 941 620",
      "set media dark",
      "open http://127.0.0.1:5173/second",
      "read",
    ],
  );
  await service.dispose();
});

test("a closed endpoint makes the next call reconnect and say why", async () => {
  const { endpoints, input, service } = harness();
  await service.call(input("take_snapshot"));
  endpoints[0]!.end();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const next = await service.call(input("take_snapshot"));
  assert.equal(endpoints.length, 2);
  assert.match(text(next), /reconnected because the preview browser closed/u);
  await service.dispose();
});

test("a lost browser connection is a transient error", async () => {
  let fail = true;
  const { endpoints, input, service } = harness((run) => {
    if (run.args[0] === "snapshot" && fail) {
      fail = false;
      throw new AgentBrowserError("CDP connection failed: Connection refused");
    }
    return { snapshot: "" };
  });
  await assert.rejects(
    service.call(input("take_snapshot")),
    /connection closed.*next call reconnects/u,
  );
  await service.call(input("take_snapshot"));
  assert.equal(endpoints.length, 2);
  await service.dispose();
});

test("a different preview page replaces the connection", async () => {
  const { endpoints, input, service } = harness();
  await service.call(input("take_snapshot"));
  const next = await service.call({
    ...input("take_snapshot"),
    pageIdentity: "page-2",
  });
  assert.equal(endpoints.length, 2);
  assert.match(text(next), /because the preview page changed/u);
  await service.dispose();
});

test("waits the agent asks for set agent-browser's limit inside the call's", async () => {
  const { input, runs, service } = harness();
  await service.call(input("wait_for", { text: "Saved", timeout: 30_000 }));
  await service.call(input("click", { target: "@e1" }));
  await service.call(input("wait_for", { text: "Saved", timeout: 3_600_000 }));
  const wait = runs.filter(({ args }) => args[0] === "wait");
  assert.deepEqual(wait[0]!.args, [
    "wait",
    "--text",
    "Saved",
    "--timeout",
    "30000",
  ]);
  assert.equal(wait[0]!.timeoutMs, 30_000);
  assert.equal(runs.find(({ args }) => args[0] === "click")!.timeoutMs, 10_000);
  // Past the ceiling, the wait is shortened so the browser gives up first.
  assert.deepEqual(wait[1]!.args.slice(-1), ["295000"]);
  await service.dispose();
});

test("console, network and request details stay short and hide credentials", async () => {
  const { input, service } = harness((run) => {
    if (run.args[0] === "console")
      return {
        messages: [
          { text: "ready", type: "log" },
          { text: "bad", type: "error" },
        ],
      };
    if (run.args[0] === "errors")
      return {
        errors: [
          { line: 3, text: "Error: boom", url: "http://127.0.0.1:5173/app.js" },
        ],
      };
    if (run.args[1] === "requests")
      return {
        requests: [
          {
            method: "GET",
            requestId: "1.1",
            resourceType: "Document",
            status: 200,
            url: "http://127.0.0.1:5173/",
          },
          {
            method: "GET",
            requestId: "2.1",
            resourceType: "Document",
            status: 200,
            url: "http://127.0.0.1:5173/board",
          },
          {
            headers: { Authorization: "Bearer secret" },
            method: "POST",
            requestId: "42.1",
            resourceType: "Fetch",
            status: 201,
            url: "http://127.0.0.1:5173/api/save",
          },
        ],
      };
    if (run.args[1] === "request")
      return {
        headers: { Authorization: "Bearer secret", Accept: "*/*" },
        lifecycle: { reused: true },
        responseHeaders: { "Set-Cookie": "sid=1" },
        url: "http://127.0.0.1:5173/api/save",
      };
    return {};
  });
  assert.equal(
    text(await service.call(input("list_console_messages"))),
    "[log] ready\n[error] bad\n[page error] Error: boom (http://127.0.0.1:5173/app.js:3)",
  );
  const list = text(await service.call(input("list_network_requests")));
  assert.equal(
    list,
    [
      "1 request of earlier pages not shown.",
      "[2.1] GET http://127.0.0.1:5173/board 200 (Document)",
      "[42.1] POST /api/save 201 (Fetch)",
    ].join("\n"),
  );
  const detail = text(
    await service.call(input("get_network_request", { id: "42.1" })),
  );
  assert.doesNotMatch(detail, /secret|sid=1|lifecycle/u);
  assert.match(detail, /"Accept": "\*\/\*"/u);
  await service.dispose();
});

test("emulate refuses an empty or out-of-range setting before reaching the browser", async () => {
  const { commands, input, service } = harness();
  for (const args of [{}, { viewport: { width: 10, height: 10 } }]) {
    const result = await service.call(input("emulate", args));
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.deepEqual(commands(), ["get url"]);
  await service.dispose();
});

test("runtime upload staging cannot escape the scoped worktree", () => {
  const worktree = "/home/blame/runtime/worktrees/story";
  assert.equal(
    workspaceUploadRelativePath(worktree, "fixtures/avatar.png"),
    "fixtures/avatar.png",
  );
  assert.equal(
    workspaceUploadRelativePath(
      worktree,
      "/home/blame/runtime/worktrees/story/data/input.csv",
    ),
    "data/input.csv",
  );
  assert.throws(
    () => workspaceUploadRelativePath(worktree, "../secret.txt"),
    /inside the workspace/u,
  );
  assert.throws(
    () => workspaceUploadRelativePath(worktree, "/etc/passwd"),
    /inside the workspace/u,
  );
});
