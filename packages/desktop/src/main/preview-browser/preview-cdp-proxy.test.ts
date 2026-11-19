import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import {
  startPreviewCdpProxy,
  type CdpDebuggee,
  type PreviewCdpProxy,
} from "./preview-cdp-proxy.ts";
import { previewNavigationPolicy } from "./preview-navigation-policy.ts";

type Sent = { method: string; params: unknown; sessionId?: string };

function fakeDebuggee() {
  const sent: Sent[] = [];
  const listeners = new Set<
    (method: string, params: unknown, sessionId?: string) => void
  >();
  const detachListeners = new Set<() => void>();
  let detached = 0;
  const debuggee: CdpDebuggee = {
    attach: async () => ({ targetId: "PAGE-TARGET" }),
    detach: () => {
      detached += 1;
    },
    onDetach(listener) {
      detachListeners.add(listener);
      return () => detachListeners.delete(listener);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async sendCommand(method, params, sessionId) {
      sent.push({ method, params, sessionId });
      if (method === "Page.getNavigationHistory")
        return {
          currentIndex: 1,
          entries: [
            { id: 1, url: "https://example.com/" },
            { id: 2, url: "http://127.0.0.1:5173/" },
          ],
        };
      return { echoed: method };
    },
    title: () => "Preview",
    url: () => "http://127.0.0.1:5173/",
    userAgent: () => "Test",
    versions: { chrome: "146.0.0.0", v8: "14.6" },
  };
  return {
    debuggee,
    detachedCount: () => detached,
    emit(method: string, params: unknown, sessionId?: string) {
      listeners.forEach((listener) => listener(method, params, sessionId));
    },
    gone() {
      detachListeners.forEach((listener) => listener());
    },
    sent,
  };
}

class Client {
  private nextId = 1;
  private readonly pending = new Map<number, (message: any) => void>();
  readonly events: any[] = [];
  private readonly socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === "number") {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      } else this.events.push(message);
    });
  }

  static async open(url: string) {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("refused")), {
        once: true,
      });
    });
    return new Client(socket);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ) {
    const id = this.nextId++;
    this.socket.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
    return new Promise<any>((resolve) => this.pending.set(id, resolve));
  }

  close() {
    this.socket.close();
  }
}

// What agent-browser does: discover the targets, then attach to the page.
async function attachedClient(proxy: PreviewCdpProxy) {
  const client = await Client.open(proxy.wsEndpoint);
  await client.send("Target.setDiscoverTargets", { discover: true });
  const { result } = await client.send("Target.getTargets");
  const attached = await client.send("Target.attachToTarget", {
    flatten: true,
    targetId: result.targetInfos[0].targetId,
  });
  return { client, pageSession: attached.result.sessionId as string };
}

function startProxy(fake = fakeDebuggee()) {
  return startPreviewCdpProxy(
    fake.debuggee,
    previewNavigationPolicy("http://127.0.0.1:5173"),
  ).then((proxy) => ({ fake, proxy }));
}

function get(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ body: string; status: number }>((resolve, reject) => {
    request(url, { headers }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ body, status: response.statusCode! }));
    })
      .on("error", reject)
      .end();
  });
}

test("answers no HTTP discovery, even with the token", async () => {
  const { proxy } = await startProxy();
  try {
    const { port, pathname } = new URL(proxy.wsEndpoint);
    const token = pathname.split("/").at(-1);
    for (const path of ["/json", "/json/version", `/${token}/json/list`])
      assert.equal((await get(`http://127.0.0.1:${port}${path}`)).status, 404);
  } finally {
    await proxy.close();
  }
});

test("refuses a wrong token, a browser origin and a second client", async () => {
  const { proxy } = await startProxy();
  try {
    const wrong = proxy.wsEndpoint.replace(/[0-9a-f]{8}$/u, "00000000");
    await assert.rejects(Client.open(wrong), /refused/);
    const port = new URL(proxy.wsEndpoint).port;
    const upgrade = await new Promise<number>((resolve) => {
      const req = request(proxy.wsEndpoint.replace("ws:", "http:"), {
        headers: {
          Connection: "Upgrade",
          Origin: "https://evil.test",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
          Upgrade: "websocket",
          Host: `127.0.0.1:${port}`,
        },
      });
      req.on("upgrade", () => resolve(101));
      req.on("response", (response) => resolve(response.statusCode!));
      req.on("error", () => resolve(403));
      req.end();
    });
    assert.notEqual(upgrade, 101);
    const first = await Client.open(proxy.wsEndpoint);
    await assert.rejects(Client.open(proxy.wsEndpoint), /refused/);
    first.close();
  } finally {
    await proxy.close();
  }
});

test("presents one page, and relays page commands", async () => {
  const { fake, proxy } = await startProxy();
  try {
    const client = await Client.open(proxy.wsEndpoint);
    await client.send("Target.setDiscoverTargets", { discover: true });
    const created = client.events
      .filter((event) => event.method === "Target.targetCreated")
      .map((event) => event.params.targetInfo.type);
    assert.deepEqual(created, ["page"]);
    const version = await client.send("Browser.getVersion");
    assert.equal(version.result.product, "Chrome/146.0.0.0");

    client.close();
    await proxy.closed;
    const second = (await startProxy(fake)).proxy;
    const attached = await attachedClient(second);
    const reply = await attached.client.send(
      "Runtime.evaluate",
      { expression: "1" },
      attached.pageSession,
    );
    assert.equal(reply.sessionId, attached.pageSession);
    assert.deepEqual(reply.result, { echoed: "Runtime.evaluate" });
    assert.deepEqual(fake.sent.at(-1), {
      method: "Runtime.evaluate",
      params: { expression: "1" },
      sessionId: undefined,
    });

    fake.emit("Runtime.consoleAPICalled", { type: "log" });
    fake.emit("Target.attachedToTarget", { sessionId: "CHILD" });
    fake.emit("Runtime.executionContextCreated", { id: 2 }, "CHILD");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const relayed = attached.client.events.filter((event) =>
      ["Runtime.consoleAPICalled", "Runtime.executionContextCreated"].includes(
        event.method,
      ),
    );
    assert.deepEqual(
      relayed.map((event) => [event.method, event.sessionId]),
      [
        ["Runtime.consoleAPICalled", attached.pageSession],
        ["Runtime.executionContextCreated", "CHILD"],
      ],
    );
    await attached.client.send("DOM.enable", {}, "CHILD");
    assert.deepEqual(fake.sent.at(-1), {
      method: "DOM.enable",
      params: {},
      sessionId: "CHILD",
    });
    attached.client.close();
    await second.close();
  } finally {
    await proxy.close();
  }
});

test("refuses new targets, other targets and closing the page", async () => {
  const { fake, proxy } = await startProxy();
  try {
    const { client, pageSession } = await attachedClient(proxy);
    for (const [method, params, sessionId] of [
      ["Target.createTarget", { url: "about:blank" }],
      ["Browser.close", {}],
      ["Target.closeTarget", { targetId: "PAGE-TARGET" }],
      ["Target.attachToTarget", { targetId: "MAIN-WINDOW", flatten: true }],
      ["Target.createBrowserContext", {}],
      ["Target.getTargets", {}, pageSession],
      ["Target.attachToTarget", { targetId: "MAIN-WINDOW" }, pageSession],
      ["Page.close", {}, pageSession],
      ["Browser.setContentsSize", { width: 390, height: 844 }, pageSession],
      ["Browser.setWindowBounds", { windowId: 1, bounds: {} }],
    ] as const) {
      const reply = await client.send(method, params, sessionId);
      assert.ok(reply.error, `${method} should be refused`);
    }
    assert.equal(
      fake.sent.some(({ method }) => method.startsWith("Target.")),
      false,
    );
    const second = await client.send("Target.attachToTarget", {
      targetId: "PAGE-TARGET",
      flatten: true,
    });
    assert.match(second.result.sessionId, /^[0-9A-F]{32}$/u);
    fake.emit("Network.requestWillBeSent", { requestId: "1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Each session opened on the page gets its events.
    assert.deepEqual(
      client.events
        .filter((event) => event.method === "Network.requestWillBeSent")
        .map((event) => event.sessionId)
        .sort(),
      [pageSession, second.result.sessionId].sort(),
    );
    client.close();
  } finally {
    await proxy.close();
  }
});

test("blocks navigation outside the preview origin", async () => {
  const { fake, proxy } = await startProxy();
  try {
    const { client, pageSession } = await attachedClient(proxy);
    const blocked = await client.send(
      "Page.navigate",
      { url: "https://example.com/" },
      pageSession,
    );
    assert.match(blocked.error.message, /blocked/);
    const history = await client.send(
      "Page.navigateToHistoryEntry",
      { entryId: 1 },
      pageSession,
    );
    assert.match(history.error.message, /blocked/);
    for (const url of ["http://127.0.0.1:5173/settings", "about:blank"]) {
      const allowed = await client.send("Page.navigate", { url }, pageSession);
      assert.deepEqual(allowed.result, { echoed: "Page.navigate" });
    }
    assert.equal(
      fake.sent.filter(({ method }) => method === "Page.navigate").length,
      2,
    );
    client.close();
  } finally {
    await proxy.close();
  }
});

test("closes when the page goes away", async () => {
  const { fake, proxy } = await startProxy();
  const { client, pageSession } = await attachedClient(proxy);
  fake.gone();
  await proxy.closed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    client.events.some(
      (event) =>
        event.method === "Target.detachedFromTarget" &&
        event.params.sessionId === pageSession,
    ),
  );
  assert.ok(
    client.events.some((event) => event.method === "Target.targetDestroyed"),
  );
  assert.ok(fake.detachedCount() >= 1);
});
