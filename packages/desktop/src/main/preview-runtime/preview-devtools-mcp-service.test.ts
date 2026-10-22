import assert from "node:assert/strict";
import test from "node:test";
import {
  previewDevtoolsEnabledCapabilities,
  previewDevtoolsMcpVersion,
  previewDevtoolsServerArgs,
  previewDevtoolsUnavailableCapabilities,
} from "../preview-browser/preview-devtools-config.ts";
import {
  PreviewDevtoolsMcpService,
  previewDevtoolsLoader,
  scopeNavigation,
  scopedArtifactOutputPath,
  workspaceUploadRelativePath,
} from "./preview-devtools-mcp-service.ts";
import { defaultPreviewDevtoolsTools } from "@blame/agent-runtime";
import toolCatalog from "./preview-devtools-tool-catalog.json" with { type: "json" };

test("uses the verified Google MCP version and important compatible flags", () => {
  const args = previewDevtoolsServerArgs();

  assert.equal(previewDevtoolsMcpVersion, "1.8.0");
  assert.equal(
    args.some((arg) => /browser-url|browserUrl|wsEndpoint/u.test(arg)),
    false,
  );
  assert.ok(args.includes("--memory-debugging"));
  assert.ok(args.includes("--experimental-vision"));
  assert.ok(args.includes("--experimental-structured-content"));
  assert.ok(args.includes("--category-experimental-third-party"));
  // The proxy exposes one page, so tools need no page routing.
  assert.ok(args.includes("--no-page-id-routing"));
  assert.ok(args.includes("--redact-network-headers"));
  assert.ok(args.includes("--no-performance-crux"));
});

test("the default catalog keeps the twenty everyday tools", async () => {
  const service = new PreviewDevtoolsMcpService();
  const tools = await service.listTools();
  assert.deepEqual(
    tools.map(({ name }) => name).sort(),
    [...defaultPreviewDevtoolsTools].sort(),
  );
  const size = (list: unknown[]) => JSON.stringify(list).length;
  // The schemas sent with every request are at most half of the former
  // forty-tool catalog.
  assert.ok(
    size(tools) * 2 <= size(toolCatalog.tools),
    `${size(tools)} vs ${size(toolCatalog.tools)}`,
  );
  assert.ok(tools.every((item) => !("$schema" in item.inputSchema)));
});

test("catalog exposes every compatible scoped tool without page selection", async () => {
  const service = new PreviewDevtoolsMcpService();
  const tools = await service.listTools({ advanced: true });
  const names = new Set(tools.map(({ name }) => name));

  assert.equal(toolCatalog.source, "chrome-devtools-mcp");
  assert.equal(toolCatalog.license, "Apache-2.0");
  assert.equal(toolCatalog.version, previewDevtoolsMcpVersion);
  assert.equal(tools.length, 40);
  assert.ok(names.has("take_snapshot"));
  assert.ok(names.has("take_screenshot"));
  assert.ok(names.has("lighthouse_audit"));
  assert.ok(names.has("take_heapsnapshot"));
  assert.ok(names.has("click_at"));
  assert.ok(names.has("execute_3p_developer_tool"));
  assert.equal(names.has("list_pages"), false);
  assert.equal(names.has("select_page"), false);
  assert.equal(names.has("new_page"), false);
  assert.equal(names.has("close_page"), false);
  assert.ok(tools.every((tool) => !schemaHasPageId(tool.inputSchema)));
  assert.ok(tools.every((tool) => !schemaRequiresPageId(tool.inputSchema)));
});

test("hidden and unknown tools fail before opening an MCP connection", async () => {
  const service = new PreviewDevtoolsMcpService();
  const input = {
    currentUrl: "about:blank",
    openEndpoint: () => Promise.reject(new Error("must not connect")),
    scope: "test",
    worktree: process.cwd(),
  };

  await assert.rejects(
    service.call({ ...input, toolName: "list_pages" }),
    /tool is unavailable/,
  );
  await assert.rejects(
    service.call({ ...input, toolName: "unknown_tool" }),
    /tool is unavailable/,
  );
});

test("the loader reads the proxy endpoint from the environment, not argv", () => {
  const loader = previewDevtoolsLoader("/app/chrome-devtools-mcp.js");
  assert.match(loader, /process\.env\.BLAME_PREVIEW_CDP_ENDPOINT/u);
  assert.match(loader, /delete process\.env\.BLAME_PREVIEW_CDP_ENDPOINT/u);
  assert.match(loader, /"--wsEndpoint=" \+ endpoint/u);
  assert.doesNotMatch(loader, /ws:\/\//u);
});

test("navigation stays on the preview origin with a readable error", () => {
  const input = {
    currentUrl: "http://127.0.0.1:5173/board",
    previewOrigin: "http://127.0.0.1:5173",
  };
  const relative: Record<string, unknown> = { type: "url", url: "/settings" };
  scopeNavigation(input, relative);
  assert.equal(relative.url, "http://127.0.0.1:5173/settings");
  const blank: Record<string, unknown> = { url: "about:blank" };
  scopeNavigation(input, blank);
  assert.equal(blank.url, "about:blank");
  assert.throws(
    () => scopeNavigation(input, { type: "url", url: "https://example.com/" }),
    /can only open this story's preview \(http:\/\/127\.0\.0\.1:5173\)/u,
  );
  assert.throws(
    () => scopeNavigation(input, { type: "url", url: "file:///etc/passwd" }),
    /outside it/u,
  );
  scopeNavigation(input, { type: "reload" });
});

test("capability report distinguishes enabled and incompatible features", () => {
  const enabled = new Set(previewDevtoolsEnabledCapabilities);
  const unavailable = new Set(
    previewDevtoolsUnavailableCapabilities.map(({ capability }) => capability),
  );

  assert.ok(enabled.has("memory"));
  assert.ok(enabled.has("vision"));
  assert.ok(enabled.has("third-party"));
  assert.equal(enabled.has("page-id-routing"), false);
  assert.deepEqual(
    unavailable,
    new Set(["extensions", "pwa", "webmcp", "screencast"]),
  );
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
    /inside the workspace/,
  );
  assert.throws(
    () => workspaceUploadRelativePath(worktree, "/etc/passwd"),
    /inside the workspace/,
  );
});

test("DevTools output files remain inside the private artifact scope", () => {
  const artifacts = "/tmp/blame-preview-devtools-test";

  assert.equal(
    scopedArtifactOutputPath(artifacts, "reports/audit.json"),
    "/tmp/blame-preview-devtools-test/reports/audit.json",
  );
  assert.throws(
    () => scopedArtifactOutputPath(artifacts, "../outside.json"),
    /inside their scope/,
  );
  assert.throws(
    () => scopedArtifactOutputPath(artifacts, "/etc/hosts"),
    /inside their scope/,
  );
});

test("reuses one scoped connection across tools without page routing", async () => {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> =
    [];
  const service = previewServiceWithClient(async (request) => {
    calls.push(request);
    return { content: [{ type: "text", text: request.name }] };
  });
  const input = previewInput();

  await service.call({ ...input, toolName: "take_snapshot" });
  await service.call({ ...input, toolName: "list_console_messages" });

  assert.deepEqual(
    calls.map(({ name }) => name),
    ["take_snapshot", "list_console_messages"],
  );
  assert.ok(calls.every((call) => !("pageId" in (call.arguments ?? {}))));
  await service.dispose();
});

test("a completed tool signal does not own the persistent connection", async () => {
  let connectionSignal: AbortSignal | undefined;
  let connectionCount = 0;
  const service = previewServiceWithClient(
    async () => ({ content: [{ type: "text", text: "ok" }] }),
    (signal) => {
      connectionSignal = signal;
      connectionCount += 1;
    },
  );
  const first = new AbortController();

  await service.call({
    ...previewInput(),
    signal: first.signal,
    toolName: "take_snapshot",
  });
  first.abort();
  await service.call({
    ...previewInput(),
    toolName: "list_console_messages",
  });

  assert.equal(connectionSignal?.aborted, false);
  assert.equal(connectionCount, 1);
  await service.dispose();
});

test("a tool timeout resets the connection so the next call starts clean", async () => {
  let connectionCount = 0;
  let snapshots = 0;
  const service = previewServiceWithClient(
    async (request) => {
      if (request.name === "take_snapshot" && snapshots++ === 0) {
        throw Object.assign(new Error("MCP error -32001: Request timed out"), {
          code: -32001,
        });
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
    () => {
      connectionCount += 1;
    },
  );

  // chrome-devtools-mcp keeps running a tool its client gave up on, and
  // runs one tool at a time: reusing it would queue the next call.
  await assert.rejects(
    service.call({ ...previewInput(), toolName: "take_snapshot" }),
    /take_snapshot did not finish within 15 s\. The browser connection was reset/u,
  );
  const next = (await service.call({
    ...previewInput(),
    toolName: "list_console_messages",
  })) as { content: Array<{ text: string }> };

  assert.equal(connectionCount, 2);
  assert.match(
    next.content[0].text,
    /reconnected after the previous call ran out of time/u,
  );
  await service.dispose();
});

test("a call cancelled while running resets the connection", async () => {
  let connectionCount = 0;
  const service = previewServiceWithClient(
    (request, signal) =>
      request.name === "take_snapshot"
        ? new Promise((_resolve, reject) =>
            signal?.addEventListener("abort", () =>
              reject(new Error("This operation was aborted")),
            ),
          )
        : Promise.resolve({ content: [] }),
    () => {
      connectionCount += 1;
    },
  );
  const controller = new AbortController();
  const running = service.call({
    ...previewInput(),
    signal: controller.signal,
    toolName: "take_snapshot",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(running);
  await service.call({ ...previewInput(), toolName: "list_console_messages" });
  assert.equal(connectionCount, 2);
  await service.dispose();
});

test("waits the agent asks for and emulated slowdown stretch the call timeout", async () => {
  const calls: Array<{
    name: string;
    timeout: number;
    arguments?: Record<string, unknown>;
  }> = [];
  const service = previewServiceWithClient(
    async (request, _signal, timeout) => {
      calls.push({ ...request, timeout: timeout! });
      return { content: [] };
    },
    undefined,
    ["wait_for", "emulate", "click"],
  );
  await service.call({
    ...previewInput(),
    arguments: { text: ["Saved"], timeout: 40_000 },
    toolName: "wait_for",
  });
  await service.call({
    ...previewInput(),
    arguments: { text: ["Saved"], timeout: 3_600_000 },
    toolName: "wait_for",
  });
  await service.call({
    ...previewInput(),
    arguments: { cpuThrottlingRate: 4 },
    toolName: "emulate",
  });
  await service.call({ ...previewInput(), toolName: "click" });
  assert.equal(calls[0].timeout, 45_000);
  // A wait past the ceiling is shortened before it reaches the browser.
  assert.equal(calls[1].arguments?.timeout, 295_000);
  assert.equal(calls[1].timeout, 300_000);
  assert.equal(calls[3].timeout, 60_000);
  await service.dispose();
});

test("a new connection restores the viewport, emulation and page, then says so", async () => {
  const calls: Array<{
    connection: number;
    name: string;
    arguments?: Record<string, unknown>;
  }> = [];
  const connections: Array<{ closed: boolean; onClosed?: () => void }> = [];
  let pageUrl = "http://127.0.0.1:3000/";
  const service = new PreviewDevtoolsMcpService(async () => {
    const index = connections.length;
    const connection = {
      artifacts: "/tmp/blame-preview-devtools-test",
      client: {
        callTool: async (request: {
          name: string;
          arguments?: Record<string, unknown>;
        }) => {
          calls.push({ connection: index, ...request });
          if (request.name === "navigate_page")
            pageUrl = String(request.arguments?.url);
          return { content: [{ type: "text", text: request.name }] };
        },
      } as never,
      close: async () => undefined,
      closed: false,
      onClosed: undefined as (() => void) | undefined,
      pageUrl: () => pageUrl,
      tools: ["emulate", "resize_page", "navigate_page", "take_snapshot"].map(
        tool,
      ),
    };
    connections.push(connection);
    return connection;
  });
  const input = { ...previewInput(), previewOrigin: "http://127.0.0.1:3000" };
  await service.call({
    ...input,
    arguments: { width: 941, height: 620 },
    toolName: "resize_page",
  });
  await service.call({
    ...input,
    arguments: { colorScheme: "dark", extraHttpHeaders: '{"X-Test":"1"}' },
    toolName: "emulate",
  });
  // Headers persist when a later emulate omits them; the rest is replaced.
  await service.call({
    ...input,
    arguments: { colorScheme: "dark", cpuThrottlingRate: 2 },
    toolName: "emulate",
  });
  await service.call({
    ...input,
    arguments: { type: "url", url: "/settings" },
    toolName: "navigate_page",
  });
  const first = (await service.call({
    ...input,
    toolName: "take_snapshot",
  })) as {
    content: Array<{ text: string }>;
  };
  assert.equal(first.content.length, 1);

  // The browser reopens on the preview's home page.
  pageUrl = "http://127.0.0.1:3000/";
  connections[0].closed = true;
  connections[0].onClosed?.();
  const restored = (await service.call({
    ...input,
    toolName: "take_snapshot",
  })) as {
    content: Array<{ text: string }>;
  };
  assert.deepEqual(
    calls
      .filter(({ connection }) => connection === 1)
      .map(({ name, arguments: value }) => [name, value]),
    [
      ["resize_page", { width: 941, height: 620 }],
      [
        "emulate",
        {
          colorScheme: "dark",
          cpuThrottlingRate: 2,
          extraHttpHeaders: '{"X-Test":"1"}',
        },
      ],
      ["navigate_page", { type: "url", url: "http://127.0.0.1:3000/settings" }],
      ["take_snapshot", {}],
    ],
  );
  assert.match(
    restored.content[0].text,
    /^Note: the browser was reconnected because the preview browser closed .* Restored: viewport 941×620, emulation \(dark color scheme, CPU 2× slower, extra headers\), page \/settings\.$/u,
  );
  assert.equal(restored.content[1].text, "take_snapshot");
  // Only the first result after the reconnection carries the note.
  const later = (await service.call({
    ...input,
    toolName: "take_snapshot",
  })) as {
    content: Array<{ text: string }>;
  };
  assert.equal(later.content.length, 1);
  await service.dispose();
});

test("a failed emulate does not replace the emulation to restore", async () => {
  const calls: string[] = [];
  const connections: Array<{ closed: boolean; onClosed?: () => void }> = [];
  const service = new PreviewDevtoolsMcpService(async () => {
    const connection = {
      artifacts: "/tmp/blame-preview-devtools-test",
      client: {
        callTool: async (request: {
          name: string;
          arguments?: Record<string, unknown>;
        }) => {
          calls.push(`${request.name} ${JSON.stringify(request.arguments)}`);
          return request.arguments?.colorScheme === "sepia"
            ? { content: [{ type: "text", text: "invalid" }], isError: true }
            : { content: [] };
        },
      } as never,
      close: async () => undefined,
      closed: false,
      onClosed: undefined as (() => void) | undefined,
      tools: ["emulate", "take_snapshot"].map(tool),
    };
    connections.push(connection);
    return connection;
  });
  await service.call({
    ...previewInput(),
    arguments: { colorScheme: "dark" },
    toolName: "emulate",
  });
  await service.call({
    ...previewInput(),
    arguments: { colorScheme: "sepia" },
    toolName: "emulate",
  });
  connections[0].closed = true;
  connections[0].onClosed?.();
  await service.call({ ...previewInput(), toolName: "take_snapshot" });
  assert.equal(calls.at(-2), 'emulate {"colorScheme":"dark"}');
  await service.dispose();
});

test("recreates a scoped connection after the transport closes", async () => {
  let connectionCount = 0;
  const service = previewServiceWithClient(
    async () => {
      if (connectionCount === 1) throw new Error("Transport closed");
      return { content: [{ type: "text", text: "ok" }] };
    },
    () => {
      connectionCount += 1;
    },
  );

  await assert.rejects(
    service.call({ ...previewInput(), toolName: "take_snapshot" }),
    /Transport closed/u,
  );
  await service.call({ ...previewInput(), toolName: "take_snapshot" });

  assert.equal(connectionCount, 2);
  await service.dispose();
});

test("a closed proxy makes the next call reconnect", async () => {
  const connections: Array<{ closed: boolean; onClosed?: () => void }> = [];
  const service = new PreviewDevtoolsMcpService(async () => {
    const connection = {
      artifacts: "/tmp/blame-preview-devtools-test",
      client: {
        callTool: async () => ({ content: [] }),
      } as never,
      close: async () => undefined,
      closed: false,
      onClosed: undefined as (() => void) | undefined,
      tools: [tool("take_snapshot")],
    };
    connections.push(connection);
    return connection;
  });
  await service.call({ ...previewInput(), toolName: "take_snapshot" });
  connections[0].closed = true;
  connections[0].onClosed?.();
  await service.call({ ...previewInput(), toolName: "take_snapshot" });
  assert.equal(connections.length, 2);
  await service.dispose();
});

test("changing the preview page replaces the scoped connection", async (context) => {
  const connections: AbortSignal[] = [];
  const service = previewServiceWithClient(
    async () => ({ content: [] }),
    (signal) => {
      connections.push(signal!);
    },
  );
  context.after(() => service.dispose());
  await service.call({
    ...previewInput(),
    pageIdentity: "first",
    toolName: "take_snapshot",
  });
  await service.call({
    ...previewInput(),
    pageIdentity: "second",
    toolName: "take_snapshot",
  });
  assert.equal(connections.length, 2);
  assert.equal(connections[0].aborted, true);
  assert.equal(connections[1].aborted, false);
});

test("navigate_page outside the preview fails before reaching the browser", async () => {
  const calls: string[] = [];
  const service = previewServiceWithClient(
    async (request) => {
      calls.push(request.name);
      return { content: [] };
    },
    undefined,
    ["navigate_page"],
  );
  await assert.rejects(
    service.call({
      ...previewInput(),
      arguments: { type: "url", url: "https://example.com/" },
      previewOrigin: "http://127.0.0.1:3000",
      toolName: "navigate_page",
    }),
    /can only open this story's preview/u,
  );
  assert.deepEqual(calls, []);
  await service.dispose();
});

test("advanced tools need the project setting, before any connection", async () => {
  const service = new PreviewDevtoolsMcpService(async () => {
    throw new Error("must not connect");
  });
  for (const toolName of [
    "lighthouse_audit",
    "performance_start_trace",
    "take_heapsnapshot",
    "execute_3p_developer_tool",
  ])
    await assert.rejects(
      service.call({ ...previewInput(), toolName }),
      /advanced diagnostic.*Advanced browser diagnostics/u,
    );
  await assert.rejects(
    service.call({
      ...previewInput(),
      toolName: "not_in_catalog",
      advanced: true,
    }),
    /tool is unavailable/u,
  );
});

test("each tool gets its own timeout", async () => {
  const timeouts: Record<string, number> = {};
  const service = new PreviewDevtoolsMcpService(async () => ({
    artifacts: "/tmp/blame-preview-devtools-test",
    client: {
      callTool: async (
        request: { name: string },
        _schema: unknown,
        options: { timeout: number },
      ) => {
        timeouts[request.name] = options.timeout;
        return { content: [] };
      },
    } as never,
    close: async () => undefined,
    closed: false,
    tools: [
      "take_snapshot",
      "lighthouse_audit",
      "performance_stop_trace",
      "take_heapsnapshot",
    ].map(tool),
  }));
  for (const toolName of [
    "take_snapshot",
    "lighthouse_audit",
    "performance_stop_trace",
    "take_heapsnapshot",
  ])
    await service.call({ ...previewInput(), advanced: true, toolName });
  assert.deepEqual(timeouts, {
    take_snapshot: 15_000,
    lighthouse_audit: 120_000,
    performance_stop_trace: 120_000,
    take_heapsnapshot: 120_000,
  });
  await service.dispose();
});

function previewServiceWithClient(
  callTool: (
    request: {
      name: string;
      arguments?: Record<string, unknown>;
    },
    signal?: AbortSignal,
    timeout?: number,
  ) => Promise<unknown>,
  connected?: (signal: AbortSignal | undefined) => void,
  names = ["take_snapshot", "list_console_messages"],
) {
  return new PreviewDevtoolsMcpService(async (input) => {
    connected?.(input.signal);
    return {
      artifacts: "/tmp/blame-preview-devtools-test",
      client: {
        callTool: (
          request: { name: string; arguments?: Record<string, unknown> },
          _schema: unknown,
          options: { signal?: AbortSignal; timeout?: number } = {},
        ) => callTool(request, options.signal, options.timeout),
      } as never,
      close: async () => undefined,
      closed: false,
      tools: names.map(tool),
      workspace: process.cwd(),
    };
  });
}

function previewInput() {
  return {
    currentUrl: "http://127.0.0.1:3000/",
    openEndpoint: () => Promise.reject(new Error("unused in fake")),
    scope: "preview-scope",
    worktree: process.cwd(),
  };
}

function tool(name: string) {
  return { name, inputSchema: { type: "object", properties: {} } };
}

function schemaHasPageId(schema: Record<string, unknown>) {
  if (!schema.properties || typeof schema.properties !== "object") return false;
  return "pageId" in schema.properties;
}

function schemaRequiresPageId(schema: Record<string, unknown>) {
  return Array.isArray(schema.required) && schema.required.includes("pageId");
}

test("an error page is not remembered as the page to restore", async () => {
  const calls: string[] = [];
  const connections: Array<{ closed: boolean; onClosed?: () => void }> = [];
  let pageUrl = "http://127.0.0.1:3000/settings";
  const service = new PreviewDevtoolsMcpService(async () => {
    const connection = {
      artifacts: "/tmp/blame-preview-devtools-test",
      client: {
        callTool: async (request: { name: string }) => {
          calls.push(request.name);
          return { content: [] };
        },
      } as never,
      close: async () => undefined,
      closed: false,
      onClosed: undefined as (() => void) | undefined,
      pageUrl: () => pageUrl,
      tools: ["navigate_page", "take_snapshot"].map(tool),
    };
    connections.push(connection);
    return connection;
  });
  const input = { ...previewInput(), previewOrigin: "http://127.0.0.1:3000" };
  await service.call({ ...input, toolName: "take_snapshot" });
  pageUrl = "chrome-error://chromewebdata/";
  await service.call({ ...input, toolName: "take_snapshot" });
  pageUrl = "http://127.0.0.1:3000/";
  connections[0].closed = true;
  connections[0].onClosed?.();
  await service.call({ ...input, toolName: "take_snapshot" });
  assert.deepEqual(calls.slice(2), ["navigate_page", "take_snapshot"]);
  await service.dispose();
});
