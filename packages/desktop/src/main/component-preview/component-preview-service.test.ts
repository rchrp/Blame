import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { workspaceComponentPreviewHost } from "./component-preview-hosts.ts";
import { componentPreviewRequestAllowed } from "./component-preview-page-policy.ts";
import {
  ComponentPreviewService,
  type ComponentPreviewBrowser,
  type ComponentPreviewCapture,
  type ComponentPreviewDependencies,
  type ComponentPreviewPage,
} from "./component-preview-service.ts";

const png = Buffer.from("89504e470d0a1a0a", "hex");

type Emulation = { theme: "dark" | "light"; width: number };

// A browser with the story's preview page already open, as the agent's
// browser has. Component previews must get pages of their own.
type Render = typeof defaultRender;

class FakeBrowser implements ComponentPreviewBrowser {
  readonly pages: FakePage[] = [];
  readonly previewPage = new FakePage("http://localhost:5173/settings");
  private readonly render: Render;

  constructor(render: Render = defaultRender) {
    this.render = render;
    this.pages.push(this.previewPage);
  }

  async openPage(origin: string) {
    const page = new FakePage("about:blank", origin, this.render);
    this.pages.push(page);
    return page;
  }
}

class FakePage implements ComponentPreviewPage {
  closed = false;
  readonly emulations: Emulation[] = [];
  readonly origin?: string;
  url: string;
  readonly visited: string[] = [];
  private readonly render: Render;

  constructor(url: string, origin?: string, render: Render = defaultRender) {
    this.url = url;
    this.origin = origin;
    this.render = render;
  }

  async capture(input: {
    theme: "dark" | "light";
    timeoutMs: number;
    url: string;
    width: number;
  }): Promise<ComponentPreviewCapture> {
    assert.ok(this.origin && input.url.startsWith(this.origin));
    this.emulations.push({ theme: input.theme, width: input.width });
    this.url = input.url;
    this.visited.push(input.url);
    return this.render(input);
  }

  close() {
    this.closed = true;
  }
}

async function defaultRender(input: {
  url: string;
  width: number;
}): Promise<ComponentPreviewCapture> {
  return {
    consoleErrors: [],
    image: png,
    status: "ready",
    url: input.url,
    viewport: { height: 900, width: input.width },
  };
}

function fakeServer(origin = "http://127.0.0.1:41234") {
  const state = { stopped: false };
  return {
    state,
    server: {
      origin,
      pageUrl: (query: { file: string; state: string; theme: string }) =>
        `${origin}/__blame_component_preview__/t?file=${query.file}&state=${query.state}&theme=${query.theme}`,
      get running() {
        return !state.stopped;
      },
      stop: async () => {
        state.stopped = true;
      },
      viteVersion: "8.3.6",
    },
  };
}

function storeScreenshots(): ComponentPreviewDependencies["storeScreenshots"] {
  let count = 0;
  return async (result, context) => {
    count += 1;
    const id = String(count % 10).repeat(64);
    return {
      ...(result as object),
      content: [
        ...((result as { content: unknown[] }).content ?? []),
        { type: "text", text: `Screenshot saved as screenshot:${id}.` },
      ],
      _meta: {
        blameScreenshots: [
          {
            colorScheme: context.page?.colorScheme,
            id,
            sessionId: context.sessionId,
            viewport: context.page?.viewport,
          },
        ],
      },
    };
  };
}

function serviceWith(
  browser: FakeBrowser,
  overrides: Partial<ComponentPreviewDependencies> = {},
) {
  const starts: string[] = [];
  const servers: Array<ReturnType<typeof fakeServer>> = [];
  const service = new ComponentPreviewService({
    browser: async () => browser,
    locate: async () => ({
      host: {
        bindHost: "127.0.0.1",
        description: "the story's workspace",
        key: "workspace:/w",
        path: (path) => path,
        start: () => {
          throw new Error("unused");
        },
      },
      packageDir: "packages/app",
    }),
    startServer: async (input) => {
      starts.push(input.packageDir);
      const started = fakeServer();
      servers.push(started);
      return started.server;
    },
    storeScreenshots: storeScreenshots(),
    ...overrides,
  });
  return { servers, service, starts };
}

const request = {
  file: "packages/app/src/card.blame-preview.tsx",
  states: ["default", "empty"],
  themes: ["light", "dark"],
};

test("rendering leaves the story's preview page at its URL, with no emulation", async () => {
  const browser = new FakeBrowser();
  const { service } = serviceWith(browser);
  const result = (await service.render({
    request,
    scope: "story:1",
    sessionId: "s1",
    worktree: "/w",
  })) as { _meta: { blameScreenshots: unknown[] }; content: unknown[] };
  assert.equal(browser.previewPage.url, "http://localhost:5173/settings");
  assert.deepEqual(browser.previewPage.emulations, []);
  assert.deepEqual(browser.previewPage.visited, []);
  assert.equal(browser.pages.length, 2);
  const page = browser.pages[1]!;
  assert.deepEqual(page.emulations, [
    { theme: "light", width: 1280 },
    { theme: "dark", width: 1280 },
    { theme: "light", width: 1280 },
    { theme: "dark", width: 1280 },
  ]);
  assert.equal(result._meta.blameScreenshots.length, 4);
  await service.shutdown();
  assert.equal(page.closed, true);
  assert.equal(browser.previewPage.closed, false);
});

test("one server serves the session; each render reports its errors", async () => {
  const browser = new FakeBrowser(async (input) => ({
    consoleErrors: input.url.includes("state=empty")
      ? [
          "Warning: Each child in a list should have a unique key (src/card.tsx:4)",
        ]
      : [],
    ...(input.url.includes("theme=dark") && input.url.includes("state=empty")
      ? { message: 'The preview file exports no state named "empty".' }
      : {}),
    image: png,
    status:
      input.url.includes("theme=dark") && input.url.includes("state=empty")
        ? "error"
        : "ready",
    url: input.url,
    viewport: { height: 900, width: input.width },
  }));
  const { service, starts } = serviceWith(browser);
  const first = (await service.render({ request, worktree: "/w" })) as {
    content: Array<{ text?: string; type: string }>;
  };
  const second = (await service.render({
    request: { file: request.file },
    worktree: "/w",
  })) as { content: Array<{ text?: string; type: string }> };
  assert.deepEqual(starts, ["packages/app"]);
  const texts = first.content.flatMap((block) => block.text ?? []);
  assert.match(
    texts[0]!,
    /^Started a Vite 8\.3\.6 server in the story's workspace for packages\/app/u,
  );
  assert.match(second.content[0]!.text!, /^Reused a Vite 8\.3\.6 server/u);
  assert.ok(
    texts.includes(
      "Render 1/4 — default, light, 1280 px: rendered.\nError overlay: none.\nConsole errors: none.",
    ),
  );
  assert.ok(
    texts.includes(
      'Render 4/4 — empty, dark, 1280 px: the page reported an error: The preview file exports no state named "empty".\nError overlay: none.\nConsole errors:\n- Warning: Each child in a list should have a unique key (src/card.tsx:4)',
    ),
  );
  assert.equal(
    first.content.filter((block) => block.type === "image").length,
    4,
  );
  await service.shutdown();
});

test("a call over six renders or for a cloud preview starts nothing", async () => {
  const browser = new FakeBrowser();
  const { service, starts } = serviceWith(browser);
  const tooMany = (await service.render({
    request: { ...request, widths: [390, 1280] },
    worktree: "/w",
  })) as { isError: boolean };
  const cloud = (await service.render({
    request,
    workspaceMode: "cloud-mirror",
    worktree: "/w",
  })) as { isError: boolean };
  assert.equal(tooMany.isError, true);
  assert.equal(cloud.isError, true);
  assert.deepEqual(starts, []);
  assert.equal(browser.pages.length, 1);
});

test("a location problem is reported without starting a server", async () => {
  const { service, starts } = serviceWith(new FakeBrowser(), {
    locate: async () => ({ message: "packages/web has no vite.config.* file" }),
  });
  const result = (await service.render({ request, worktree: "/w" })) as {
    content: Array<{ text: string }>;
    isError: boolean;
  };
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0]!.text,
    "packages/web has no vite.config.* file",
  );
  assert.deepEqual(starts, []);
});

test("the server stops for its session, its worktree, or after the idle delay", async () => {
  const browser = new FakeBrowser();
  const { service, servers } = serviceWith(browser, { idleMs: 30 });
  await service.render({ request, sessionId: "s1", worktree: "/w" });
  assert.equal(await service.stop({ sessionId: "other" }), 0);
  assert.equal(await service.stop({ sessionId: "s1" }), 1);
  assert.equal(servers[0]!.state.stopped, true);
  await service.render({ request, worktree: "/w" });
  assert.equal(await service.stop({ worktree: "/w" }), 1);
  assert.equal(servers[1]!.state.stopped, true);
  await service.render({ request, worktree: "/w" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(servers[2]!.state.stopped, true);
  assert.equal(service.serving("/w"), false);
});

test("a server that exited is replaced on the next call", async () => {
  const { service, servers, starts } = serviceWith(new FakeBrowser());
  await service.render({ request, worktree: "/w" });
  servers[0]!.state.stopped = true;
  await service.render({ request, worktree: "/w" });
  assert.equal(starts.length, 2);
  await service.shutdown();
});

test("a component preview page only loads its own server", () => {
  const origins = new Set(["http://127.0.0.1:41234"]);
  for (const url of [
    "http://127.0.0.1:41234/__blame_component_preview__/t?file=a",
    "http://127.0.0.1:41234/node_modules/.vite/deps/react.js?v=1",
    "ws://127.0.0.1:41234/?token=x",
    "data:image/png;base64,AAAA",
    "blob:http://127.0.0.1:41234/6f1c",
    "about:blank",
  ])
    assert.equal(componentPreviewRequestAllowed(url, origins), true, url);
  for (const url of [
    "http://localhost:5173/settings",
    "http://127.0.0.1:41235/",
    "https://127.0.0.1:41234/",
    "http://user:pass@127.0.0.1:41234/",
    "https://fonts.googleapis.com/css2",
    "file:///etc/passwd",
    "not a url",
  ])
    assert.equal(componentPreviewRequestAllowed(url, origins), false, url);
});

// A small Vite + React project, rendered by the real temporary server.
const projectDependencies = resolveProjectDependencies();

test(
  "a Vite + React project: one call starts the server and renders two states in light and dark",
  {
    skip: projectDependencies
      ? false
      : "Vite and React are not installed for the desktop tests.",
    timeout: 120_000,
  },
  async () => {
    const worktree = await mkdtemp(join(tmpdir(), "blame-component-preview-"));
    const fetched: string[] = [];
    try {
      await writeFixture(worktree);
      const browser = new FakeBrowser(async (input) => {
        const html = await (await fetch(input.url)).text();
        assert.match(html, /\/@vite\/client/u);
        assert.match(html, /virtual:blame-component-preview/u);
        const preview = await (
          await fetch(new URL("/src/card.blame-preview.tsx", input.url))
        ).text();
        fetched.push(preview);
        return defaultRender(input);
      });
      const service = new ComponentPreviewService({
        browser: async () => browser,
        locate: async () => ({
          host: workspaceComponentPreviewHost(worktree),
          packageDir: "",
        }),
        storeScreenshots: storeScreenshots(),
      });
      const result = (await service.render({
        request: {
          file: "src/card.blame-preview.tsx",
          states: ["default", "empty"],
          themes: ["light", "dark"],
        },
        sessionId: "s1",
        worktree,
      })) as {
        _meta: { blameScreenshots: unknown[] };
        content: Array<{ text?: string; type: string }>;
        isError?: boolean;
      };
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      assert.equal(
        result.content.filter((block) => block.type === "image").length,
        4,
      );
      assert.equal(result._meta.blameScreenshots.length, 4);
      const origin = new URL(browser.pages[1]!.visited[0]!).origin;
      assert.deepEqual(
        browser.pages[1]!.visited.map((url) => {
          const query = new URL(url).searchParams;
          return `${query.get("file")}/${query.get("state")}/${query.get("theme")}`;
        }),
        [
          "src/card.blame-preview.tsx/default/light",
          "src/card.blame-preview.tsx/default/dark",
          "src/card.blame-preview.tsx/empty/light",
          "src/card.blame-preview.tsx/empty/dark",
        ],
      );
      // The package's own Vite config applies: its alias is resolved.
      assert.match(fetched[0]!, /from "\/src\/card\.ts"/u);
      // Edited between two calls, the component shows its change from the
      // same server.
      await writeFile(
        join(worktree, "src/card.blame-preview.tsx"),
        'import { createElement } from "react";\nimport { Card } from "@/card";\nexport default createElement(Card, { title: "Edited" });\n',
      );
      await service.render({
        request: { file: "src/card.blame-preview.tsx" },
        worktree,
      });
      assert.equal(new URL(browser.pages[1]!.visited.at(-1)!).origin, origin);
      assert.match(fetched.at(-1)!, /Edited/u);
      // finish_task stops the server: nothing answers on its port anymore.
      assert.equal(await service.stop({ worktree }), 1);
      await assert.rejects(
        fetch(`${origin}/`, { signal: AbortSignal.timeout(2_000) }),
      );
    } finally {
      await rm(worktree, { force: true, recursive: true });
    }
  },
);

async function writeFixture(worktree: string) {
  await mkdir(join(worktree, "src"), { recursive: true });
  await mkdir(join(worktree, "node_modules"), { recursive: true });
  for (const [name, directory] of Object.entries(projectDependencies!))
    await symlink(directory, join(worktree, "node_modules", name), "dir");
  await writeFile(
    join(worktree, "package.json"),
    '{ "name": "fixture", "private": true, "type": "module" }\n',
  );
  await writeFile(
    join(worktree, "vite.config.js"),
    [
      'import { fileURLToPath } from "node:url";',
      "export default {",
      '  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },',
      '  server: { port: 3000, proxy: { "/api": "http://127.0.0.1:9" } },',
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(worktree, "src/card.ts"),
    'import { createElement } from "react";\nexport function Card({ title }: { title: string }) {\n  return createElement("h1", null, title);\n}\n',
  );
  await writeFile(
    join(worktree, "src/card.blame-preview.tsx"),
    'import { createElement } from "react";\nimport { Card } from "@/card";\nexport default createElement(Card, { title: "Ready" });\nexport const empty = createElement(Card, { title: "" });\n',
  );
}

// Vite from the desktop package, React from the app package.
function resolveProjectDependencies() {
  const app = new URL("../../../../app/package.json", import.meta.url);
  const requirers = [
    ...(existsSync(app) ? [createRequire(app)] : []),
    createRequire(import.meta.url),
  ];
  const resolved: Record<string, string> = {};
  for (const name of ["vite", "react", "react-dom"]) {
    for (const requirer of requirers) {
      try {
        resolved[name] = dirname(requirer.resolve(`${name}/package.json`));
        break;
      } catch {
        // Try the next package.
      }
    }
    if (!resolved[name]) return undefined;
  }
  return resolved;
}
