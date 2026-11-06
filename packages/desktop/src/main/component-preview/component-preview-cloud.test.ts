import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import test from "node:test";
import type {
  ComponentPreviewSandboxCursor,
  ComponentPreviewSandboxStart,
} from "@blame/preview-runtime";
import type { DesktopBridgeGrant } from "../preview-browser/preview-bridge-grant.ts";
import { PreviewRouteTable } from "../preview-browser/preview-route-table.ts";
import {
  cloudComponentPreviewHostFor,
  type CloudComponentPreviews,
} from "./component-preview-cloud-host.ts";
import { locateComponentPreview } from "./component-preview-location.ts";
import type { ComponentPreviewRelayTransport } from "./component-preview-relay.ts";
import {
  componentPreviewPagePath,
  componentPreviewReportPrefix,
} from "./component-preview-server-script.ts";
import {
  ComponentPreviewService,
  type ComponentPreviewBrowser,
  type ComponentPreviewCapture,
  type ComponentPreviewPage,
} from "./component-preview-service.ts";

// A story with a cloud preview: open_component_preview starts its server in
// the preview's sandbox, simulated here by the cloud API, a component
// preview gateway that checks capabilities like the sandbox's, and a small
// server in place of Vite. The real service, server, location, cloud host
// and relay run unchanged.

const png = Buffer.from("89504e470d0a1a0a", "hex");
const componentProvider = "sb-43900-story.vercel.run";
const previewProvider = "https://sb-43000-story.vercel.run/";
const cloudSessionId = "preview_0123456789abcdef0123456789abcdef";

function listen(server: Server) {
  return new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );
}

function close(server: Server | undefined) {
  if (!server?.listening) return Promise.resolve();
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function grant(
  route: {
    port: number;
    providerUrl: string;
    routeId: string;
    serviceId: string;
  },
  capability: string,
  lifetimeMs: number,
): DesktopBridgeGrant {
  return {
    sessionId: cloudSessionId,
    endpointRevision: 0,
    integratedPreviewRequired: false,
    primaryRouteId: route.routeId,
    routes: [
      {
        routeId: route.routeId,
        serviceId: route.serviceId,
        endpointId: "server",
        logicalHost: "localhost",
        logicalPort: route.port,
        protocol: "http",
        providerUrl: route.providerUrl,
        capability,
        capabilityExpiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
      },
    ],
  };
}

// The cloud API and the sandbox behind it.
class SimulatedSandbox implements CloudComponentPreviews {
  readonly calls: string[] = [];
  readonly capabilities = new Set<string>();
  readonly forwarded: Array<{
    capability: string;
    host: string;
    path: string;
  }> = [];
  readonly starts: ComponentPreviewSandboxStart[] = [];
  // The preview's own gateway, which the component preview never touches.
  readonly previewGateway = createServer((request, response) => {
    response.end(
      request.headers["x-blame-preview-capability"] === "preview-capability"
        ? "the story's app"
        : "unauthorized",
    );
  });
  componentGatewayPort = 0;
  private componentGateway?: Server;
  private issued = 0;
  private listening = false;
  private port = 0;
  private running = false;
  private server?: Server;
  // WebSocket connections, which closing a server does not end.
  private readonly upgraded = new Set<Duplex>();

  async findForUserStory(storyId: string) {
    this.calls.push(`find ${storyId}`);
    return {
      session: {
        id: cloudSessionId,
        state: {
          agent: "idle",
          engine: "running",
          host: "running",
          preview: "ready",
          sync: "clean",
        } as const,
      },
    };
  }

  async syncBarrier(worktree: string) {
    this.calls.push(`sync ${worktree}`);
  }

  async startComponentPreview(
    sessionId: string,
    input: ComponentPreviewSandboxStart,
  ) {
    assert.equal(sessionId, cloudSessionId);
    this.calls.push("start");
    this.starts.push(input);
    const options = input.nodeArguments.slice(
      input.nodeArguments.indexOf("--") + 1,
    );
    const [packageDir, host, port, token] = options;
    assert.equal(packageDir, "/workspace/packages/app");
    assert.equal(host, "0.0.0.0");
    assert.equal(Number(port), input.port);
    this.server = componentServer(token!, (socket) =>
      this.upgraded.add(socket),
    );
    const serverPort = await listen(this.server);
    this.componentGateway = this.gateway(serverPort);
    this.componentGatewayPort = await listen(this.componentGateway);
    this.port = input.port;
    this.running = true;
    // Close to its expiry: the relay renews it before its first request.
    return this.grant(10_000);
  }

  async componentPreviewOutput(
    sessionId: string,
    cursor: ComponentPreviewSandboxCursor,
  ) {
    assert.equal(sessionId, cloudSessionId);
    if (this.listening || !this.running)
      return { cursor, running: this.running, stderr: "", stdout: "" };
    this.listening = true;
    const stdout = `VITE ready\n${componentPreviewReportPrefix}${JSON.stringify({ event: "listening", port: this.port, react: true, vite: "8.3.5" })}\n`;
    return {
      cursor: { stderr: 0, stdout: cursor.stdout + stdout.length },
      running: true,
      stderr: "",
      stdout,
    };
  }

  async refreshComponentPreview(sessionId: string, port: number) {
    assert.equal(sessionId, cloudSessionId);
    assert.equal(port, this.port);
    this.calls.push("refresh");
    return this.grant(60_000);
  }

  async stopComponentPreview(sessionId: string) {
    assert.equal(sessionId, cloudSessionId);
    this.calls.push("stop");
    this.running = false;
    this.listening = false;
    for (const socket of this.upgraded) socket.destroy();
    this.upgraded.clear();
    await Promise.all([close(this.server), close(this.componentGateway)]);
    return { stopped: true };
  }

  // The relay's way to the provider, here the simulated gateway.
  transport(): ComponentPreviewRelayTransport {
    return {
      request: (target, options) => {
        assert.equal(target.hostname, componentProvider);
        return httpRequest({
          ...options,
          host: "127.0.0.1",
          path: `${target.pathname}${target.search}`,
          port: this.componentGatewayPort,
        });
      },
      connect: (target, ready) => {
        assert.equal(target.hostname, componentProvider);
        return net.connect(this.componentGatewayPort, "127.0.0.1", ready);
      },
    };
  }

  async shutdown() {
    await Promise.all([
      close(this.server),
      close(this.componentGateway),
      close(this.previewGateway),
    ]);
  }

  private grant(lifetimeMs: number) {
    this.issued += 1;
    const capability = `component-capability-${this.issued}`;
    this.capabilities.add(capability);
    return grant(
      {
        port: this.port,
        providerUrl: `https://${componentProvider}`,
        routeId: "c".repeat(40),
        serviceId: "blame-component-preview",
      },
      capability,
      lifetimeMs,
    );
  }

  // Like the sandbox's gateway: a request without a capability it issued
  // never reaches the server.
  private gateway(serverPort: number) {
    const authorized = (request: IncomingMessage) => {
      const capability = String(
        request.headers["x-blame-preview-capability"] ?? "",
      );
      this.forwarded.push({
        capability,
        host: String(request.headers.host),
        path: request.url ?? "",
      });
      return this.capabilities.has(capability);
    };
    const gateway = createServer((request, response) => {
      if (!authorized(request)) {
        response.writeHead(401).end("Unauthorized");
        return;
      }
      const upstream = httpRequest(
        {
          headers: request.headers,
          host: "127.0.0.1",
          method: request.method,
          path: request.url,
          port: serverPort,
        },
        (result) => {
          response.writeHead(result.statusCode ?? 502, result.headers);
          result.pipe(response);
        },
      );
      request.pipe(upstream);
    });
    gateway.on("upgrade", (request, socket: Duplex, head: Buffer) => {
      if (!authorized(request)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      this.upgraded.add(socket);
      const upstream = net.connect(serverPort, "127.0.0.1", () => {
        upstream.write(
          `GET ${request.url} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
        );
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      this.upgraded.add(upstream);
    });
    return gateway;
  }
}

// In place of Vite: the health check, the generated page and its HMR socket.
function componentServer(token: string, upgraded: (socket: Duplex) => void) {
  const base = `${componentPreviewPagePath}/${token}`;
  const server = createServer((request, response) => {
    if (request.url === `${base}/health`) {
      response.end(token);
      return;
    }
    if (request.url?.startsWith(`${base}?`)) {
      response.setHeader("content-type", "text/html");
      response.end(`<p>component preview page ${request.url}</p>`);
      return;
    }
    response.writeHead(404).end();
  });
  server.on("upgrade", (_request, socket: Duplex) => {
    upgraded(socket);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhmr-connected",
    );
  });
  return server;
}

class FakePage implements ComponentPreviewPage {
  closed = false;
  readonly emulations: Array<{ theme: string; width: number }> = [];
  url: string;
  readonly visited: string[] = [];
  readonly origin?: string;

  constructor(url: string, origin?: string) {
    this.origin = origin;
    this.url = url;
  }

  // Loads the page for real, through the relay.
  async capture(input: {
    theme: "dark" | "light";
    timeoutMs: number;
    url: string;
    width: number;
  }): Promise<ComponentPreviewCapture> {
    assert.ok(this.origin && input.url.startsWith(`${this.origin}/`));
    this.emulations.push({ theme: input.theme, width: input.width });
    this.url = input.url;
    this.visited.push(input.url);
    const response = await fetch(input.url);
    const body = await response.text();
    const ready = response.ok && body.includes("component preview page");
    return {
      consoleErrors: [],
      ...(ready ? { image: png } : { message: `HTTP ${response.status}` }),
      status: ready ? "ready" : "error",
      url: input.url,
      viewport: { height: 900, width: input.width },
    };
  }

  close() {
    this.closed = true;
  }
}

// The agent's browser, with the cloud preview's page already open.
class FakeBrowser implements ComponentPreviewBrowser {
  readonly pages: FakePage[] = [];
  readonly previewPage = new FakePage("http://localhost:5173/settings");

  async openPage(origin: string) {
    const page = new FakePage("about:blank", origin);
    this.pages.push(page);
    return page;
  }
}

async function cloudWorktree() {
  const worktree = await mkdtemp(join(tmpdir(), "component-preview-cloud-"));
  const app = join(worktree, "packages", "app");
  await mkdir(join(app, "src"), { recursive: true });
  await writeFile(join(app, "package.json"), '{"name":"app"}');
  await writeFile(join(app, "vite.config.ts"), "export default {}");
  await writeFile(
    join(app, "src", "card.blame-preview.tsx"),
    "export default null",
  );
  return worktree;
}

function cloudService(
  sandbox: SimulatedSandbox,
  browser: FakeBrowser,
  idleMs?: number,
) {
  return new ComponentPreviewService({
    browser: async () => browser,
    ...(idleMs ? { idleMs } : {}),
    locate: (target, file) =>
      locateComponentPreview(target, file, (cloudTarget) =>
        cloudComponentPreviewHostFor(sandbox, cloudTarget, {
          pollMs: { running: 20, starting: 5 },
          transport: sandbox.transport(),
        }),
      ),
    storeScreenshots: async (result, context) => {
      const id = String(context.page?.viewport.width ?? 0).padEnd(64, "0");
      return {
        ...(result as object),
        _meta: {
          blameScreenshots: [{ colorScheme: context.page?.colorScheme, id }],
        },
      };
    },
  });
}

const request = {
  file: "packages/app/src/card.blame-preview.tsx",
  states: ["default", "empty"],
  themes: ["light", "dark"],
};

function webSocketUpgrade(origin: string) {
  const { port } = new URL(origin);
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(Number(port), "127.0.0.1", () =>
      socket.write(
        "GET /?token=hmr HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      ),
    );
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes("hmr-connected")) {
        socket.destroy();
        resolve(received);
      }
    });
    socket.once("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error(`No WebSocket answer: ${received}`));
    }, 5_000).unref();
  });
}

test("a cloud preview renders its components from its sandbox, next to the preview's route", async () => {
  const worktree = await cloudWorktree();
  const sandbox = new SimulatedSandbox();
  const browser = new FakeBrowser();
  const service = cloudService(sandbox, browser);
  // The route the agent's browser holds for the story's preview.
  const previewGatewayPort = await listen(sandbox.previewGateway);
  const previewRoutes = new PreviewRouteTable();
  previewRoutes.replace(
    grant(
      {
        port: 5173,
        providerUrl: previewProvider,
        routeId: "p".repeat(40),
        serviceId: "web",
      },
      "preview-capability",
      60_000,
    ),
  );
  try {
    const input = {
      request,
      sessionId: "agent-session",
      storyId: "story-1",
      workspaceMode: "cloud-mirror" as const,
      worktree,
    };
    const first = (await service.render(input)) as {
      _meta: { blameScreenshots: unknown[] };
      content: Array<{ text?: string; type: string }>;
      isError?: boolean;
    };
    const texts = first.content.flatMap((block) => block.text ?? []);
    assert.equal(first.isError, undefined, texts.join("\n"));
    assert.match(
      texts[0]!,
      /^Started a Vite 8\.3\.5 server in the cloud preview's sandbox for packages\/app, at http:\/\/127\.0\.0\.1:\d+\. 4 renders of packages\/app\/src\/card\.blame-preview\.tsx:$/u,
    );
    assert.ok(
      texts.includes(
        "Render 4/4 — empty, dark, 1280 px: rendered.\nError overlay: none.\nConsole errors: none.",
      ),
    );
    assert.equal(first._meta.blameScreenshots.length, 4);
    // Every request reached the sandbox with a capability it issued, the
    // first one renewed before it expired.
    assert.ok(sandbox.forwarded.length >= 5);
    assert.ok(
      sandbox.forwarded.every(
        ({ capability, host }) =>
          sandbox.capabilities.has(capability) && host === componentProvider,
      ),
    );
    assert.ok(sandbox.calls.includes("refresh"));
    assert.ok(
      !sandbox.forwarded.some(
        ({ capability }) => capability === "component-capability-1",
      ),
    );
    // The relay carries the page's HMR WebSocket too.
    const page = browser.pages[0]!;
    assert.match(
      await webSocketUpgrade(page.origin!),
      /^HTTP\/1\.1 101 Switching Protocols/u,
    );

    const second = (await service.render({
      ...input,
      request: { file: request.file, widths: [390] },
    })) as { content: Array<{ text?: string }> };
    assert.match(
      second.content[0]!.text!,
      /^Reused a Vite 8\.3\.5 server in the cloud preview's sandbox/u,
    );
    assert.deepEqual(
      sandbox.calls.filter((call) => call !== "refresh"),
      [
        "find story-1",
        `sync ${worktree}`,
        "start",
        "find story-1",
        `sync ${worktree}`,
      ],
    );
    assert.equal(browser.pages.length, 1);
    assert.deepEqual(page.emulations.at(-1), { theme: "light", width: 390 });

    // The story's preview keeps its page and its route.
    assert.equal(browser.previewPage.url, "http://localhost:5173/settings");
    assert.deepEqual(browser.previewPage.emulations, []);
    assert.equal(browser.previewPage.closed, false);
    const preview = previewRoutes.resolve("http://localhost:5173/settings");
    assert.equal(preview.route.providerUrl, previewProvider);
    assert.equal(preview.route.capability, "preview-capability");
    assert.throws(
      () =>
        previewRoutes.resolve(`http://localhost:${sandbox.starts[0]!.port}/`),
      /not declared/u,
    );
    const app = await fetch(`http://127.0.0.1:${previewGatewayPort}/`, {
      headers: { "x-blame-preview-capability": "preview-capability" },
    });
    assert.equal(await app.text(), "the story's app");

    // finish_task: the server stops in the sandbox and the relay closes.
    assert.equal(await service.stop({ worktree }), 1);
    assert.equal(sandbox.calls.at(-1), "stop");
    assert.equal(page.closed, true);
    await assert.rejects(fetch(`${page.origin}/`));
    assert.equal(browser.previewPage.closed, false);
  } finally {
    await service.shutdown();
    await sandbox.shutdown();
    await rm(worktree, { force: true, recursive: true });
  }
});

test("a cloud server stops when its session is cancelled, and after the idle delay", async () => {
  const worktree = await cloudWorktree();
  const sandbox = new SimulatedSandbox();
  const service = cloudService(sandbox, new FakeBrowser(), 150);
  const input = {
    request: { file: request.file },
    sessionId: "agent-session",
    storyId: "story-1",
    workspaceMode: "cloud-mirror" as const,
    worktree,
  };
  try {
    await service.render(input);
    assert.equal(await service.stop({ sessionId: "agent-session" }), 1);
    assert.equal(sandbox.calls.filter((call) => call === "stop").length, 1);
    await service.render(input);
    assert.equal(sandbox.calls.filter((call) => call === "start").length, 2);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(service.serving(worktree), false);
    assert.equal(sandbox.calls.filter((call) => call === "stop").length, 2);
  } finally {
    await service.shutdown();
    await sandbox.shutdown();
    await rm(worktree, { force: true, recursive: true });
  }
});

test("a cloud preview that is not started gets no server", async () => {
  const worktree = await cloudWorktree();
  const sandbox = new SimulatedSandbox();
  sandbox.findForUserStory = async () => ({ session: null });
  const service = cloudService(sandbox, new FakeBrowser());
  try {
    const result = (await service.render({
      request: { file: request.file },
      storyId: "story-1",
      workspaceMode: "cloud-mirror",
      worktree,
    })) as { content: Array<{ text: string }>; isError: boolean };
    assert.equal(result.isError, true);
    assert.match(
      result.content[0]!.text,
      /^Start the story's cloud preview first/u,
    );
    assert.deepEqual(sandbox.starts, []);
  } finally {
    await service.shutdown();
    await sandbox.shutdown();
    await rm(worktree, { force: true, recursive: true });
  }
});
