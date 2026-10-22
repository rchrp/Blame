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
  scopedPreviewPageId,
  workspaceUploadRelativePath,
} from "./preview-devtools-mcp-service.ts";
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
  assert.ok(args.includes("--page-id-routing"));
  assert.ok(args.includes("--redact-network-headers"));
  assert.ok(args.includes("--no-performance-crux"));
});

test("catalog exposes every compatible scoped tool without page selection", async () => {
  const service = new PreviewDevtoolsMcpService();
  const tools = await service.listTools();
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
  assert.ok(enabled.has("page-id-routing"));
  assert.deepEqual(
    unavailable,
    new Set(["extensions", "pwa", "webmcp", "screencast"]),
  );
});

test("page routing selects only the scoped preview target", () => {
  const pages = [
    { id: 1, url: "http://127.0.0.1:3000/#first" },
    { id: 2, url: "http://127.0.0.1:3000/#second" },
  ];

  assert.equal(scopedPreviewPageId(pages, "http://127.0.0.1:3000/#second"), 2);
  assert.throws(
    () => scopedPreviewPageId(pages, "http://127.0.0.1:3000/"),
    /Multiple DevTools pages/,
  );
  assert.throws(
    () => scopedPreviewPageId(pages, "http://127.0.0.1:4000/"),
    /no longer available/,
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

test("prepares and reuses one scoped page route across tools", async () => {
  const calls: string[] = [];
  const service = previewServiceWithClient(async (request) => {
    calls.push(request.name);
    if (request.name === "list_pages") return pagesResult();
    return { content: [{ type: "text", text: request.name }] };
  });
  const input = previewInput();

  await service.prepare(input);
  await service.call({ ...input, toolName: "take_snapshot" });
  await service.call({ ...input, toolName: "list_console_messages" });

  assert.deepEqual(calls, [
    "list_pages",
    "take_snapshot",
    "list_console_messages",
  ]);
  await service.dispose();
});

test("a completed tool signal does not own the persistent connection", async () => {
  let connectionSignal: AbortSignal | undefined;
  let connectionCount = 0;
  const service = previewServiceWithClient(
    async (request) =>
      request.name === "list_pages"
        ? pagesResult()
        : { content: [{ type: "text", text: "ok" }] },
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

test("refreshes a stale Google page id once", async () => {
  const calls: string[] = [];
  let snapshots = 0;
  const service = previewServiceWithClient(async (request) => {
    calls.push(request.name);
    if (request.name === "list_pages") return pagesResult();
    snapshots += 1;
    if (snapshots === 1) {
      return {
        content: [{ type: "text", text: "No page found" }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: "snapshot" }] };
  });

  const result = await service.call({
    ...previewInput(),
    toolName: "take_snapshot",
  });

  assert.deepEqual(calls, [
    "list_pages",
    "take_snapshot",
    "list_pages",
    "take_snapshot",
  ]);
  assert.equal((result as { isError?: boolean }).isError, undefined);
  await service.dispose();
});

test("keeps the scoped connection after a tool timeout", async () => {
  let connectionCount = 0;
  let snapshots = 0;
  const service = previewServiceWithClient(
    async (request) => {
      if (request.name === "list_pages") return pagesResult();
      if (request.name === "take_snapshot" && snapshots++ === 0) {
        throw new Error("Request timed out");
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
    () => {
      connectionCount += 1;
    },
  );

  await assert.rejects(
    service.call({ ...previewInput(), toolName: "take_snapshot" }),
    /take_snapshot failed: Request timed out/u,
  );
  await service.call({
    ...previewInput(),
    toolName: "list_console_messages",
  });

  assert.equal(connectionCount, 1);
  await service.dispose();
});

test("recreates a scoped connection after the transport closes", async () => {
  let connectionCount = 0;
  const service = previewServiceWithClient(
    async (request) => {
      if (request.name === "list_pages") return pagesResult();
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

function previewServiceWithClient(
  callTool: (request: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<unknown>,
  connected?: (signal: AbortSignal | undefined) => void,
) {
  return new PreviewDevtoolsMcpService(async (input) => {
    connected?.(input.signal);
    return {
      artifacts: "/tmp/blame-preview-devtools-test",
      client: { callTool } as never,
      close: async () => undefined,
      closed: false,
      tools: [pageTool("take_snapshot"), pageTool("list_console_messages")],
      workspace: process.cwd(),
    };
  });
}

test("does not replay a tool that loses its page during execution", async (context) => {
  const calls: string[] = [];
  const service = previewServiceWithClient(async (request) => {
    calls.push(request.name);
    if (request.name === "list_pages") return pagesResult();
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Connection closed. Most likely the page has been closed.",
        },
      ],
    };
  });
  context.after(() => service.dispose());
  const result = await service.call({
    ...previewInput(),
    toolName: "take_snapshot",
  });
  assert.equal((result as { isError: boolean }).isError, true);
  assert.deepEqual(calls, ["list_pages", "take_snapshot"]);
});

test("does not retry a discovery diagnostic as an unregistered page", async (context) => {
  let calls = 0;
  const service = previewServiceWithClient(async () => {
    calls += 1;
    return {
      isError: true,
      content: [{ type: "text", text: "Browser authentication failed" }],
    };
  });
  context.after(() => service.dispose());
  await assert.rejects(
    service.prepare(previewInput()),
    /discovery failed: Browser authentication failed/,
  );
  assert.equal(calls, 1);
});

function previewInput() {
  return {
    currentUrl: "http://127.0.0.1:3000/",
    openEndpoint: () => Promise.reject(new Error("unused in fake")),
    scope: "preview-scope",
    worktree: process.cwd(),
  };
}

function pageTool(name: string) {
  return {
    name,
    inputSchema: {
      type: "object",
      properties: { pageId: { type: "number" } },
    },
  };
}

function pagesResult() {
  return {
    content: [],
    structuredContent: {
      pages: [{ id: 7, url: "http://127.0.0.1:3000/" }],
    },
  };
}

function schemaHasPageId(schema: Record<string, unknown>) {
  if (!schema.properties || typeof schema.properties !== "object") return false;
  return "pageId" in schema.properties;
}

function schemaRequiresPageId(schema: Record<string, unknown>) {
  return Array.isArray(schema.required) && schema.required.includes("pageId");
}

test("waits for late page registration without executing the tool on another page", async (context) => {
  let discoveries = 0;
  const routed: unknown[] = [];
  const service = previewServiceWithClient(async (request) => {
    if (request.name === "list_pages") {
      discoveries += 1;
      return discoveries === 1
        ? {
            structuredContent: {
              pages: [{ id: 1, url: "https://unrelated.example/" }],
            },
          }
        : pagesResult();
    }
    routed.push(request.arguments?.pageId);
    return { content: [] };
  });
  context.after(() => service.dispose());
  await service.call({ ...previewInput(), toolName: "take_snapshot" });
  assert.equal(discoveries, 2);
  assert.deepEqual(routed, [7]);
});

test("a recreated browser invalidates the route even when its URL is unchanged", async (context) => {
  let discoveries = 0;
  const routed: unknown[] = [];
  const service = previewServiceWithClient(async (request) => {
    if (request.name === "list_pages") {
      const result = pagesResult();
      result.structuredContent.pages[0].id = ++discoveries;
      return result;
    }
    routed.push(request.arguments?.pageId);
    return { content: [] };
  });
  context.after(() => service.dispose());
  await service.prepare({ ...previewInput(), pageIdentity: "old-browser" });
  await service.call({
    ...previewInput(),
    pageIdentity: "new-browser",
    toolName: "take_snapshot",
  });
  assert.equal(discoveries, 2);
  assert.deepEqual(routed, [2]);
});

test("a missing page has a bounded discovery wait without destroying a healthy connection", async (context) => {
  let registered = false;
  let connections = 0;
  const service = previewServiceWithClient(
    async () =>
      registered ? pagesResult() : { structuredContent: { pages: [] } },
    () => {
      connections += 1;
    },
  );
  context.after(() => service.dispose());
  const started = Date.now();
  await assert.rejects(service.prepare(previewInput()), /no longer available/);
  assert.ok(Date.now() - started < 3_500);
  registered = true;
  await service.prepare(previewInput());
  assert.equal(connections, 1);
});

test("page discovery can be cancelled without cancelling the connection", async (context) => {
  const cancellation = new AbortController();
  let connectionSignal: AbortSignal | undefined;
  const service = previewServiceWithClient(
    async () => {
      cancellation.abort(new Error("cancel discovery"));
      return { structuredContent: { pages: [] } };
    },
    (signal) => {
      connectionSignal = signal;
    },
  );
  context.after(() => service.dispose());
  await assert.rejects(
    service.prepare({ ...previewInput(), signal: cancellation.signal }),
    /abort|cancel discovery/i,
  );
  assert.equal(connectionSignal?.aborted, false);
});

test("changing the preview page replaces the scoped connection", async (context) => {
  const connections: AbortSignal[] = [];
  const service = previewServiceWithClient(
    async () => pagesResult(),
    (signal) => {
      connections.push(signal!);
    },
  );
  context.after(() => service.dispose());
  await service.prepare({ ...previewInput(), pageIdentity: "first" });
  await service.prepare({ ...previewInput(), pageIdentity: "second" });
  assert.equal(connections.length, 2);
  assert.equal(connections[0].aborted, true);
  assert.equal(connections[1].aborted, false);
});
