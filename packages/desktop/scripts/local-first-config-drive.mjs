// Drives the built desktop app through the local-first configuration work, in
// isolated profiles, against a mock Blame API and a mock OpenAI-compatible
// model: MCP servers that survive syncs, updates, unreadable files, sign-outs
// and account switches; the per-server "sync / this device only" choice; and
// provider keys kept in this computer's keychain, used with the API stopped.
//
//   cargo build -p blame-engine -p blame-harness
//   VITE_CLOUD_API_URL=http://127.0.0.1:47833/api/v1 pnpm --filter @blame/desktop exec electron-vite build
//   node scripts/local-first-config-drive.mjs --root /tmp/lfc --out /tmp/lfc-shots [--only M1,M2] [--keep]
//
// The renderer reads the account API's address at build time
// (VITE_CLOUD_API_URL): the drive needs a build pointed at its mock, and a
// normal build afterwards. The mock answers what the scenarios are about
// itself (profile, billing, MCP configurations, sign-out) and passes every
// other request to the local API the desktop runs in the profile, so the rest
// of the app (projects, AI preferences, provider credentials) behaves as with
// a real account. Every request it receives is recorded: that record is the
// evidence that what stays on this device never reaches the API.
//
// Profiles live under --root and are kept between runs (`--only M2` goes on
// from the profile M1 left), with the mock's state next to them. Scenarios:
// M1..M5 share one profile, M6 has its own (no account), P1..P4 another.
//
// Nothing may reach the person's screen or keychain: HOME is left alone, the
// on-screen windows are watched for a system dialog (the run stops at one),
// the app's keychain item must stay unmodified, and the app is killed on every
// way out (it also quits by itself when the drive is gone).
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const here = fileURLToPath(new URL(".", import.meta.url));
const application = resolve(here, "..");

const apiPort = 47833;
const modelPort = 47834;
const modelBase = `http://lfc-model.localhost:${modelPort}/v1`;

// Fake secrets only: each one is grepped for where it must not be.
const secrets = {
  mcpToken: "fake-mcp-token-1234",
  oauthAccess: "fake-oauth-access-5678",
  sentryToken: "fake-sentry-token-9999",
  deviceKey: "sk-fake-device-key-abcd1234",
  accountKey: "sk-fake-account-key-efgh5678",
  secondDeviceKey: "sk-ant-fake-device-key-wxyz1234",
  seedKey: "sk-fake-seed-key-0000",
};

const users = {
  A: { id: "a0000000-0000-4000-8000-00000000000a", email: "ada@example.com", fullName: "Ada Mock", initials: "AM" },
  B: { id: "b0000000-0000-4000-8000-00000000000b", email: "bob@example.com", fullName: "Bob Mock", initials: "BM" },
  C: { id: "c0000000-0000-4000-8000-00000000000c", email: "cy@example.com", fullName: "Cy Mock", initials: "CM" },
};
const tokenOf = (key) => `mock-token-${key}`;
const sessionOf = (key) => ({
  token: tokenOf(key),
  user: { ...users[key], createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
});

// ------------------------------------------------------------------ mock API

class MockApi {
  requests = [];
  local = undefined;
  server = undefined;

  constructor(root) {
    this.stateFile = join(root, "mock-api-state.json");
    this.logFile = join(root, "mock-api-requests.jsonl");
    this.state = existsSync(this.stateFile) ? JSON.parse(readFileSync(this.stateFile, "utf8")) : { mcp: {} };
  }

  async save() {
    await writeFile(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  /** The account's MCP configuration: what the API stores, secrets apart. */
  mcpOf(userId) {
    return this.state.mcp[userId];
  }

  async setMcp(userId, servers) {
    if (servers === null) delete this.state.mcp[userId];
    else {
      const stored = { createdAt: new Date().toISOString(), updatedAt: null, servers: [], secrets: {} };
      for (const { secrets: given, secretsSynced, ...server } of servers) {
        stored.servers.push(server);
        if (given && secretsSynced !== false) stored.secrets[server.name] = given;
      }
      this.state.mcp[userId] = stored;
    }
    await this.save();
  }

  presentMcp(userId) {
    const stored = this.state.mcp[userId];
    if (!stored) return null;
    return {
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      servers: stored.servers.map((server) =>
        stored.secrets[server.name] ? { ...server, secrets: stored.secrets[server.name], secretsSynced: true } : server,
      ),
    };
  }

  /** The API's semantics: sent secrets replace, absent ones are kept, `secretsSynced: false` forgets. */
  async putMcp(userId, servers) {
    const previous = this.state.mcp[userId];
    const kept = {};
    const stored = [];
    for (const { secrets: given, secretsSynced, ...server } of servers) {
      stored.push(server);
      if (secretsSynced === false) continue;
      const value = given ?? previous?.secrets?.[server.name];
      if (value) kept[server.name] = value;
    }
    this.state.mcp[userId] = {
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      servers: stored,
      secrets: kept,
    };
    await this.save();
  }

  mark() {
    return this.requests.length;
  }

  since(mark, filter = () => true) {
    return this.requests.slice(mark).filter(filter);
  }

  async start() {
    if (this.server) return;
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise((done, fail) => {
      this.server.once("error", fail);
      this.server.listen(apiPort, "127.0.0.1", done);
    });
  }

  /** "The API is down": nothing listens any more. */
  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }

  async handle(request, response) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(request.url, "http://mock");
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    const user = Object.entries(users).find(([key]) => tokenOf(key) === token)?.[1];
    const entry = { at: new Date().toISOString(), method: request.method, path, search: url.search, user: user?.email ?? null, body };
    this.requests.push(entry);
    const reply = (status, value) => {
      entry.status = status;
      void appendFile(this.logFile, `${JSON.stringify(entry)}\n`);
      response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
      response.end(value === undefined ? "" : JSON.stringify(value));
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      });
      return response.end();
    }
    if (path === "/account/profile" && request.method === "GET") {
      if (!user) return reply(401, { message: "Unauthorized" });
      return reply(200, { data: sessionOf(Object.keys(users).find((key) => users[key] === user)).user });
    }
    if (path === "/billing" && request.method === "GET")
      return reply(200, { data: { licensed: true, status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false } });
    if (path === "/account/mcp-configurations") {
      if (!user) return reply(401, { message: "Unauthorized" });
      if (request.method === "GET") return reply(200, { data: this.presentMcp(user.id) });
      if (request.method === "PUT") {
        const servers = JSON.parse(body).servers;
        await this.putMcp(user.id, servers);
        return reply(200, { data: this.presentMcp(user.id) });
      }
    }
    if (path === "/account/logout" || path === "/auth/sign-out") return reply(200, { data: null });
    if (path === "/providers/recommendations") return reply(503, { message: "Not in this mock" });
    // Everything else: the local API in the profile, as this user.
    const startedAt = Date.now();
    while (!this.local && Date.now() - startedAt < 60_000) await delay(100);
    if (!this.local) return reply(503, { message: "The local API is not known yet" });
    try {
      const forwarded = await fetch(`${this.local.url.replace(/\/$/, "")}${path}${url.search}`, {
        method: request.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.local.token}`,
          ...(body ? { "content-type": request.headers["content-type"] ?? "application/json" } : {}),
        },
        body: body && request.method !== "GET" && request.method !== "HEAD" ? body : undefined,
      });
      const text = await forwarded.text();
      entry.status = forwarded.status;
      void appendFile(this.logFile, `${JSON.stringify(entry)}\n`);
      response.writeHead(forwarded.status, { "content-type": forwarded.headers.get("content-type") ?? "application/json" });
      response.end(text);
    } catch (error) {
      reply(502, { message: String(error) });
    }
  }
}

// ---------------------------------------------------------------- the model

/** An OpenAI-compatible model that records the key it is called with. */
class MockModel {
  requests = [];
  async start() {
    this.server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch {
        // Not JSON.
      }
      this.requests.push({ at: new Date().toISOString(), method: request.method, path: request.url, authorization: request.headers.authorization ?? null, model: body.model ?? null, stream: body.stream ?? null });
      if (request.url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ object: "list", data: [{ id: "lfc-mock-model", object: "model", owned_by: "mock" }] }));
      }
      const text = "Hello from the local-first mock model.";
      const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }));
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish, extra = {}) =>
        `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      response.write(chunk({ role: "assistant", content: "" }, null));
      response.write(chunk({ content: text }, null));
      response.write(chunk({}, "stop", { usage }));
      response.end("data: [DONE]\n\n");
    });
    await new Promise((done) => this.server.listen(modelPort, "127.0.0.1", done));
  }
  close() {
    this.server?.closeAllConnections();
    this.server?.close();
  }
}

// ------------------------------------------------------------ the screen

// The system's security and alert agents: a window of theirs on screen is a
// dialog the person would have to answer (a keychain prompt, an alert).
const dialogOwners = /^(SecurityAgent|UserNotificationCenter|coreauthd|CoreServicesUIAgent|universalAccessAuthWarn|Keychain Access|Trousseaux d.accès)$/;
const windowListScript = `ObjC.import("CoreGraphics");
const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0));
const out = [];
for (let i = 0; i < list.count; i++) {
  const w = list.objectAtIndex(i);
  const bounds = ObjC.deepUnwrap(w.objectForKey("kCGWindowBounds")) || {};
  out.push([w.objectForKey("kCGWindowOwnerName"), w.objectForKey("kCGWindowNumber"), w.objectForKey("kCGWindowOwnerPID"), w.objectForKey("kCGWindowLayer")].map((v) => ObjC.unwrap(v)).concat([bounds.Width || 0, bounds.Height || 0]).join("\\t"));
}
out.join("\\n");`;

async function screenWindows() {
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", windowListScript]);
  return stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [owner, number, pid, layer, width, height] = line.split("\t");
    return { owner, number, pid: Number(pid), layer: Number(layer), width: Number(width), height: Number(height) };
  });
}

// Stops the run at the first dialog on screen: one of the system's agents',
// or a window of the app's own process that is not one of its BrowserWindows.
class DialogWatch {
  found = [];
  appPid = undefined;
  appWindows = new Set();
  async start(onFound) {
    if (process.platform !== "darwin") return;
    const before = new Set((await screenWindows()).map((window) => window.number));
    watchedDialogs = this;
    let suspects = new Set();
    this.timer = setInterval(async () => {
      if (this.found.length) return;
      const windows = await screenWindows().catch(() => []);
      const system = windows.filter((window) => !before.has(window.number) && dialogOwners.test(window.owner));
      const own = windows.filter(
        (window) => this.appPid && window.pid === this.appPid && !this.appWindows.has(window.number) && window.height >= 80,
      );
      const seen = new Set(own.map((window) => window.number));
      const repeated = own.filter((window) => suspects.has(window.number));
      suspects = seen;
      const dialogs = [...system, ...repeated];
      if (!dialogs.length) return;
      this.found = dialogs.map((window) => `${window.owner} (window ${window.number}, ${window.width}x${window.height})`);
      onFound();
    }, 1000);
  }
  follow(pid, output) {
    this.appPid = pid;
    const line = output.slice(output.lastIndexOf("DRIVE_WINDOWS ")).split("\n")[0];
    if (line.startsWith("DRIVE_WINDOWS "))
      this.appWindows = new Set(line.slice("DRIVE_WINDOWS ".length).split(",").filter(Boolean));
  }
  stop() {
    clearInterval(this.timer);
  }
}

/** When the app's keychain item last changed; read without asking for its secret. */
function keychainItemDate() {
  if (process.platform !== "darwin") return "n/a";
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", "Blame Dev Safe Storage"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return /"mdat"<timedate>=\S+\s+"([^"]+)"/.exec(out)?.[1]?.replace("\\000", "") ?? "unreadable";
  } catch {
    return "absent";
  }
}

let watchedDialogs;
async function until(condition, timeoutMs, what) {
  const startedAt = Date.now();
  while (!(await condition())) {
    if (watchedDialogs?.found.length) throw new Error(`A system dialog appeared: ${watchedDialogs.found.join(", ")}`);
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await delay(200);
  }
}

const pageTarget = (entry) => entry.type === "page" && !entry.url.startsWith("devtools") && !entry.url.includes("view=backlog-status-pip");

/**
 * The app's window over the DevTools protocol. The sign-in screen is a small
 * window of its own and the workspace another: `retarget` moves to the
 * workspace window when there is one (the compact one otherwise), and every
 * call goes to the window currently followed.
 */
async function connect(port, consoleErrors) {
  let socket;
  let currentId;
  let next = 0;
  const pending = new Map();
  const best = async () => {
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(pageTarget);
    return targets.find((entry) => !entry.url.includes("window-role=compact")) ?? targets[0];
  };
  const open = async (target) => {
    socket?.close();
    for (const entry of pending.values()) entry.reject(new Error("The window changed"));
    pending.clear();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    currentId = target.id;
    await new Promise((done) => socket.addEventListener("open", done, { once: true }));
    const opened = socket;
    // A window that goes away answers nothing: its pending calls fail.
    opened.addEventListener("close", () => {
      if (socket !== opened) return;
      for (const entry of pending.values()) entry.reject(new Error("The DevTools connection is closed (window gone)"));
      pending.clear();
    });
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === "Runtime.exceptionThrown")
        consoleErrors.push(`exception: ${message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text}`.slice(0, 600));
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error")
        consoleErrors.push(`console.error: ${message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ")}`.slice(0, 600));
      if (message.method === "Log.entryAdded" && message.params.entry.level === "error")
        consoleErrors.push(`log: ${message.params.entry.text} ${message.params.entry.url ?? ""}`.slice(0, 600));
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false }).catch(() => undefined);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return reject(new Error(`The DevTools connection is closed (${method}, state ${socket?.readyState})`));
      const id = ++next;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`The DevTools connection is closed (no answer to ${method})`));
      }, 30_000);
      pending.set(id, { resolve: (value) => (clearTimeout(timer), resolve(value)), reject: (error) => (clearTimeout(timer), reject(error)) });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluateOnce = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed");
    return result.result.value;
  };
  // A window that reloads or closes under a call: follow it and try again.
  const evaluate = async (expression) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await evaluateOnce(expression);
      } catch (error) {
        const transient = /closed|changed|context|Target/i.test(error.message);
        if (!transient || attempt >= 4) throw error;
        await delay(700);
        await cdp.retarget().catch(() => undefined);
      }
    }
  };
  let seen = "nothing";
  let first;
  await until(async () => {
    try {
      first = await best();
      seen = first?.url ?? "no page";
      return Boolean(first);
    } catch (error) {
      seen = String(error);
      return false;
    }
  }, 30_000, "the debugging port").catch((error) => {
    throw new Error(`${error.message} (port ${port}: ${seen})`);
  });
  await open(first);
  // Calls other than input: followed to the current window like evaluate.
  const sendFollowing = async (method, params = {}) => {
    if (method.startsWith("Input.")) {
      // Refused before it left (the socket was closed): safe to send again.
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.log(`  (reconnecting before ${method}: socket state ${socket?.readyState})`);
        await cdp.retarget(true).catch((error) => console.log(`  retarget failed: ${error.message}`));
      }
      return send(method, params);
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send(method, params);
      } catch (error) {
        if (!/closed|changed|Target/i.test(error.message) || attempt >= 4) throw error;
        await delay(700);
        await cdp.retarget().catch(() => undefined);
      }
    }
  };
  const cdp = {
    send: sendFollowing,
    evaluate,
    close: () => socket?.close(),
    url: async () => (await best())?.url,
    /** Follows the workspace window once it exists; true when it moved. */
    async retarget(force = false) {
      const target = await best().catch(() => undefined);
      if (!target || (!force && target.id === currentId && socket?.readyState === WebSocket.OPEN)) return false;
      await open(target);
      return true;
    },
  };
  return cdp;
}

// ------------------------------------------------------------------ the UI

function uiOf(cdp, out) {
  const { send, evaluate } = cdp;
  const visible = `(element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden"; }`;
  const ui = {
    cdp,
    send: cdp.send,
    evaluate,
    async shot(name) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(join(out, `${name}.png`), Buffer.from(data, "base64"));
      console.log(`  shot ${join(out, `${name}.png`)}`);
    },
    async text(scope = "body") {
      await cdp.retarget();
      return evaluate(`(document.querySelector(${JSON.stringify(scope)})?.innerText ?? "").replace(/\\s+/g, " ")`).catch(() => "");
    },
    async has(value, scope) {
      return (await ui.text(scope)).includes(value);
    },
    waitText: (value, ms = 20_000, scope) => until(() => ui.has(value, scope), ms, `"${value}" on screen`),
    async press(key, code, keyCode, modifiers = 0, text) {
      await cdp.retarget();
      for (const type of ["keyDown", "keyUp"])
        await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(type === "keyDown" && text ? { text } : {}) });
    },
    async clickAt(point) {
      await cdp.retarget();
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      // A click that closes its window (signing out) loses the release's answer.
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 }).catch(() => undefined);
    },
    /** Clicks the visible control whose text or aria-label is `label` (the `index`-th one). */
    async click(label, { index = 0, scope = "body", selector = "button, [role=radio], [role=checkbox], [role=switch], [role=menuitem], [role=option], a" } = {}) {
      const point = await evaluate(`(() => {
        const isVisible = ${visible};
        const root = document.querySelector(${JSON.stringify(scope)}) ?? document.body;
        const label = ${JSON.stringify(label)};
        // A button's text without its keyboard hint ("Continue ↵").
        const named = (element) => {
          const text = (element.innerText ?? "").replace(/\\s+/g, " ").trim();
          return text.startsWith(label + " ") && text.length - label.length <= 5 ? label : text;
        };
        const matches = [...root.querySelectorAll(${JSON.stringify(selector)})].filter((element) =>
          isVisible(element) && (named(element) === label || element.getAttribute("aria-label") === label));
        const element = matches[${index}];
        if (!element) return null;
        element.scrollIntoView({ block: "center" });
        const box = element.getBoundingClientRect();
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, disabled: element.disabled === true };
        // Covered (a toast over it): the click goes to the control itself.
        const top = document.elementFromPoint(point.x, point.y);
        if (!point.disabled && top && !element.contains(top)) { element.click(); point.clicked = true; }
        return point;
      })()`);
      if (!point) {
        const labels = await evaluate(`[...document.querySelectorAll("button")].filter(${visible}).map((b) => (b.innerText.trim() || b.getAttribute("aria-label") || "").slice(0, 40)).filter(Boolean).join(" | ")`);
        throw new Error(`No visible control "${label}". Buttons: ${labels}`);
      }
      if (point.disabled) throw new Error(`The control "${label}" is disabled`);
      if (!point.clicked) await ui.clickAt(point);
      await delay(250);
    },
    async clickSelector(selector, index = 0) {
      const point = await evaluate(`(() => {
        const element = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(${visible})[${index}];
        if (!element) return null;
        element.scrollIntoView({ block: "center" });
        const box = element.getBoundingClientRect();
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const top = document.elementFromPoint(point.x, point.y);
        if (top && !element.contains(top)) { element.click(); point.clicked = true; }
        return point;
      })()`);
      if (!point) throw new Error(`Nothing visible matches ${selector}`);
      if (!point.clicked) await ui.clickAt(point);
      await delay(250);
    },
    /** Types into an input like a person: focus, select what is there, type over it. */
    async fill(selector, value, index = 0) {
      const found = await evaluate(`(() => {
        const element = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(${visible})[${index}];
        if (!element) return false;
        element.scrollIntoView({ block: "center" });
        element.focus();
        element.select?.();
        return true;
      })()`);
      if (!found) throw new Error(`No visible input ${selector}`);
      if (value) await send("Input.insertText", { text: value });
      else await ui.press("Backspace", "Backspace", 8);
      await delay(120);
    },
    async radioChecked(label, scope = "body") {
      return evaluate(`[...document.querySelector(${JSON.stringify(scope)}).querySelectorAll("[role=radio]")].find((r) => r.innerText.trim() === ${JSON.stringify(label)})?.getAttribute("aria-checked") ?? null`);
    },
    async openSettings(section) {
      await dismissOffers(ui);
      await evaluate(`history.pushState({}, "", "/settings"); dispatchEvent(new PopStateEvent("popstate"))`);
      await until(() => evaluate(`Boolean(document.querySelector("[role=dialog]"))`), 15_000, "the settings dialog");
      await delay(400);
      await ui.click(section, { scope: "[role=dialog] aside" });
      await delay(600);
    },
    async closeSettings() {
      await ui.press("Escape", "Escape", 27);
      await delay(500);
    },
    /** The MCP panel's rows. */
    mcpRows: () =>
      evaluate(`[...document.querySelectorAll('[role=dialog] button[aria-label^="Remove "]')].map((remove) => {
        const row = remove.parentElement.parentElement;
        const name = remove.getAttribute("aria-label").slice("Remove ".length);
        const toggle = row.querySelector("[role=switch]");
        return {
          name,
          text: row.innerText.replace(/\\s+/g, " "),
          enabled: toggle?.getAttribute("aria-checked") === "true" || toggle?.dataset.state === "checked",
          addOnDevice: [...row.querySelectorAll("button")].some((b) => b.innerText.includes("Add on this device")),
          alarm: [...row.querySelectorAll("*")].some((e) => /amber|yellow|orange|warning/.test(String(e.className))),
        };
      })`),
  };
  return ui;
}

// ------------------------------------------------------------------ results

const results = [];
function record(id, pass, evidence) {
  results.push({ id, pass, evidence });
  console.log(`${pass === true ? "PASS" : pass === false ? "FAIL" : "NOTE"} ${id}: ${evidence}`);
}
const check = (id, condition, evidence) => record(id, Boolean(condition), evidence);

// -------------------------------------------------------------------- driver

async function drive() {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.root, { recursive: true });
  await mkdir(options.out, { recursive: true });
  const api = new MockApi(options.root);
  await api.start();
  const model = new MockModel();
  await model.start();
  const project = join(options.root, "project");
  await prepareProject(project);
  const electron = createRequire(import.meta.url)("electron");
  const debugPort = 9400 + Math.floor(Math.random() * 400);
  process.env.DRIVE_PORT_FOR_DEBUG = String(debugPort);
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_RENDERER_URL;
  delete environment.BLAME_RUNTIME_BIN_DIR;
  Object.assign(environment, {
    DRIVE_PROJECT: project,
    DRIVE_PORT: String(debugPort),
    DRIVE_PARENT_PID: String(process.pid),
    BLAME_ENGINE_LOG: "warn",
  });
  const keychainBefore = keychainItemDate();
  const dialogs = new DialogWatch();
  let app;
  let launching;
  const consoleErrors = [];
  const killApp = () => {
    for (const state of [app, launching]) {
      try {
        state?.child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  };
  await dialogs.start(() => {
    console.error(`FAIL a system dialog appeared on screen: ${dialogs.found.join(", ")}; the app is stopped`);
    process.exitCode = 1;
    killApp();
  });
  process.once("exit", killApp);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.once(signal, () => {
      killApp();
      process.exit(130);
    });
  const deadline = setTimeout(() => {
    console.error("FAIL the drive took longer than 40 minutes");
    killApp();
    process.exit(1);
  }, 40 * 60_000);

  const launch = async (profile) => {
    await mkdir(profile, { recursive: true });
    const child = spawn(electron, [fileURLToPath(import.meta.url), profile], {
      env: {
        ...environment,
        BLAME_CLOUD_WORKTREE_ROOT: join(profile, "cloud-worktrees"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const state = { child, output: "", profile };
    launching = state;
    child.stdout.on("data", (data) => {
      state.output += data;
      dialogs.follow(child.pid, state.output);
    });
    child.stderr.on("data", (data) => (state.output += data));
    await until(() => state.output.includes("DRIVE_READY") || child.exitCode !== null, 120_000, "the app to show a window");
    if (child.exitCode !== null) throw new Error(`The app exited at launch:\n${state.output.slice(-3000)}`);
    state.cdp = await connect(debugPort, consoleErrors);
    state.ui = uiOf(state.cdp, options.out);
    // The local API this launch runs: the mock passes requests to it.
    const local = await state.cdp.evaluate(`window.blame.localApi.session()`);
    api.local = local;
    state.local = local;
    state.index = await state.cdp.evaluate(`performance.getEntriesByType("navigation")[0]?.name ?? location.href`);
    return state;
  };
  const quit = async () => {
    if (!app) return;
    const { child } = app;
    app.cdp.close();
    child.kill("SIGTERM");
    let timer;
    await Promise.race([
      new Promise((done) => (child.exitCode !== null ? done() : child.once("exit", done))),
      new Promise((done) => (timer = setTimeout(() => (child.kill("SIGKILL"), done()), 20_000))),
    ]);
    clearTimeout(timer);
    app = undefined;
    api.local = undefined;
    await delay(800);
  };
  const context = {
    api,
    model,
    project,
    options,
    consoleErrors,
    get app() {
      return app;
    },
    async launch(profile) {
      await quit();
      app = await launch(profile);
      return app;
    },
    quit,
  };
  try {
    for (const [id, run] of scenarios) {
      if (options.only && !options.only.has(id)) continue;
      console.log(`--- ${id}`);
      const errorsBefore = consoleErrors.length;
      try {
        await run(context);
      } catch (error) {
        record(id, false, `stopped: ${error.message} ${(error.stack ?? "").split("\n").slice(1, 12).join(" ")}`);
        console.log((app ?? launching)?.output?.split("\n").filter((line) => !line.startsWith("DRIVE_WINDOWS ")).join("\n").slice(-3000));
        if (dialogs.found.length) break;
      }
      if (consoleErrors.length > errorsBefore)
        record(`${id} console`, undefined, `renderer errors: ${JSON.stringify(consoleErrors.slice(errorsBefore).slice(0, 8))}`);
    }
    const keychainAfter = keychainItemDate();
    check("keychain item unmodified", keychainAfter === keychainBefore, `${keychainBefore} -> ${keychainAfter}`);
    check("no system dialog", dialogs.found.length === 0, dialogs.found.join(", ") || "none seen");
    if (options.keep && app) {
      console.log(`DRIVE_KEEP port=${debugPort}`);
      await new Promise((done) => process.once("SIGTERM", done));
    }
  } catch (error) {
    console.error(app?.output?.split("\n").filter((line) => !line.startsWith("DRIVE_WINDOWS ")).join("\n").slice(-6000));
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    dialogs.stop();
    await quit().catch(() => killApp());
    killApp();
    await api.stop();
    model.close();
    await writeFile(join(options.root, "results.json"), JSON.stringify({ results, consoleErrors, modelRequests: model.requests }, null, 2));
    const failed = results.filter((result) => result.pass === false).length;
    console.log(`${results.filter((result) => result.pass === true).length} passed, ${failed} failed; requests in ${api.logFile}`);
    if (failed) process.exitCode = 1;
    process.exit(process.exitCode ?? 0);
  }
}

function parseOptions(argv) {
  const options = { keep: false, out: resolve("local-first-shots"), root: resolve("local-first-drive"), only: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") options.out = resolve(argv[++index]);
    else if (argv[index] === "--root") options.root = resolve(argv[++index]);
    else if (argv[index] === "--keep") options.keep = true;
    else if (argv[index] === "--only") options.only = new Set(argv[++index].split(","));
  }
  return options;
}

async function prepareProject(directory) {
  if (existsSync(join(directory, ".git"))) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ name: "lfc-demo", private: true, type: "module" }, null, 2)}\n`);
  await writeFile(join(directory, "README.md"), "A demo project.\n");
  const git = (...args) => execFileAsync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", ...args], { cwd: directory });
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "-m", "Initial commit");
}

// ---------------------------------------------------------------- profiles

const profiles = (root) => ({ mcp: join(root, "profile-mcp"), local: join(root, "profile-local"), providers: join(root, "profile-providers") });

/** The folder the app keeps its data in, inside a profile. */
function userDataOf(profile) {
  for (const name of ["dev.blame.desktop.development", "Blame Dev", "Blame"]) {
    const candidate = join(profile, name);
    if (existsSync(join(candidate, "mcp-settings.json")) || existsSync(join(candidate, "local-api"))) return candidate;
  }
  return profile;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function localApi(local, path, method = "GET", body) {
  const response = await fetch(`${local.url.replace(/\/$/, "")}${path}`, {
    method,
    headers: { accept: "application/json", authorization: `Bearer ${local.token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/**
 * A fresh profile signed in to an account of the mock: the session the
 * sign-in would have stored, then the app opened on it. With `seed`, the
 * account already has a model chosen (no onboarding).
 */
async function signIn(context, key, { seed }) {
  const { app } = context;
  if (seed) {
    await localApi(app.local, "/providers/credentials", "POST", {
      providerId: "openai-compatible",
      label: "Seeded",
      apiKey: secrets.seedKey,
      baseUrl: modelBase,
      modelIds: ["lfc-mock-model"],
    }).catch((error) => console.log(`  seed credential: ${error.message}`));
    const choice = { providerId: "openai-compatible", modelId: "lfc-mock-model", credentialLabel: "Seeded", reasoningEffort: null };
    await localApi(app.local, "/account/ai-preferences", "PUT", { agentModel: choice, alternativeModel: choice });
  }
  await app.cdp.evaluate(`(() => {
    localStorage.setItem("blame.app.cloud-session.v1", ${JSON.stringify(JSON.stringify(sessionOf(key)))});
    localStorage.setItem("blame.runtime-offer-done.v1", "true");
    localStorage.setItem("blame.runtime-preference.v1", JSON.stringify({ profile: "direct", source: "account-default" }));
  })()`);
  await app.cdp.retarget();
  const href = await app.cdp.evaluate("location.href");
  if (href.includes("index.html")) await app.cdp.send("Page.reload", {});
  else await app.cdp.send("Page.navigate", { url: app.index });
  await delay(2500);
  await app.cdp.retarget();
}

/** Opens the drive's project from the welcome screen, when it shows. */
async function openProjectIfAsked(context) {
  const { ui } = context.app;
  await until(async () => {
    const text = await ui.text();
    return text.includes("Open Project") || text.includes("Agent Queue") || text.includes("Connect your AI provider") || text.includes("Continue without an account") || text.includes("Skip for now");
  }, 60_000, "the workspace or the welcome screen");
  // The runtime offer of a first launch: not for this drive.
  if (await ui.has("Skip for now")) {
    await ui.click("Skip for now");
    await until(async () => {
      const text = await ui.text();
      return text.includes("Open Project") || text.includes("Agent Queue");
    }, 60_000, "the welcome screen");
  }
  if (await ui.has("Agent Queue")) return;
  if (await ui.has("Open Project")) {
    await ui.click("Open Project", { selector: "button" }).catch(async () => {
      await ui.evaluate(`[...document.querySelectorAll("button")].find((b) => b.innerText.trim().startsWith("Open Project")).click()`);
    });
    await ui.waitText("Agent Queue", 60_000);
  }
  // The preview offer comes a moment after the project opens.
  for (let tries = 0; tries < 15 && !(await dismissOffers(ui)); tries += 1) await delay(200);
}

/** The model steps of the onboarding, with the mock model. */
async function finishOnboarding(ui) {
  for (let step = 0; step < 4; step += 1) {
    if (await ui.has("No model selected")) await ui.clickSelector("[cmdk-item]");
    await delay(400);
    if (await ui.has("Finish setup")) {
      await ui.click("Finish setup");
      break;
    }
    await ui.click("Continue");
    await delay(1200);
  }
}

/** The first visit of a project offers to set up previews: not for this drive. */
async function dismissOffers(ui) {
  if (!(await ui.has("Set up previews for"))) return false;
  await ui.evaluate(`(() => {
    const dialog = [...document.querySelectorAll("[role=alertdialog], [role=dialog]")].find((d) => d.innerText.includes("Set up previews for"));
    const box = dialog?.querySelector("[role=checkbox]");
    if (box && box.getAttribute("aria-checked") !== "true") box.click();
  })()`);
  await delay(200);
  await ui.click("Not now");
  await delay(600);
  return true;
}

async function openMcp(context) {
  const { ui } = context.app;
  await ui.openSettings("MCP Servers");
  await until(async () => !(await ui.has("Loading servers", "[role=dialog]")), 20_000, "the MCP servers to load");
  await delay(800);
}

const settingsFile = (context) => join(userDataOf(context.app?.profile ?? profiles(context.options.root).mcp), "mcp-settings.json");

function lastPut(context, mark) {
  const puts = context.api.since(mark, (request) => request.method === "PUT" && request.path === "/account/mcp-configurations");
  return puts.at(-1);
}

function setupLabelsIn(text) {
  return ["Setup required", "Needs setup", "Setup Required"].filter((label) => text.includes(label));
}

// ---------------------------------------------------------------- scenarios

const scenarios = [
  [
    "M1",
    async (context) => {
      const { api } = context;
      const profile = profiles(context.options.root).mcp;
      await rm(profile, { force: true, recursive: true });
      await api.setMcp(users.A.id, null);
      await api.setMcp(users.B.id, null);
      let app = await context.launch(profile);
      await signIn(context, "A", { seed: true });
      await openProjectIfAsked(context);
      const firstMark = api.mark();
      await openMcp(context);
      await app.ui.shot("M1-01-empty-panel");
      const first = lastPut(context, 0);
      record("M1 first sync", first ? true : undefined, first ? `PUT ${first.body}` : "no first-sync PUT (the account had no configuration)");
      await app.ui.click("Add server", { scope: "[role=dialog] main" });
      await app.ui.fill('[role=dialog] form input[placeholder="GitHub"]', "Dokploy");
      await app.ui.fill('[role=dialog] form input[placeholder="npx"]', "npx");
      await app.ui.click("Advanced options");
      await app.ui.fill('[role=dialog] form input[placeholder="-y @modelcontextprotocol/server-github"]', "-y @dokploy/mcp");
      await app.ui.click("Add entry");
      await app.ui.fill('[role=dialog] form input[aria-label="Environment variables key 1"]', "DOKPLOY_TOKEN");
      await app.ui.fill('[role=dialog] form input[aria-label="Environment variables value 1"]', secrets.mcpToken);
      const syncDefault = await app.ui.radioChecked("Sync to my account", "[role=dialog] form");
      const secretsDefault = await app.ui.evaluate(`document.querySelector('[role=dialog] form [role=checkbox]')?.getAttribute("aria-checked")`);
      const valueType = await app.ui.evaluate(`document.querySelector('[role=dialog] form input[aria-label="Environment variables value 1"]').type`);
      check("M1 form defaults", syncDefault === "true" && secretsDefault === "false", `"Sync to my account" aria-checked=${syncDefault}; "Also sync its arguments and secrets" aria-checked=${secretsDefault}; env value input type=${valueType}`);
      await app.ui.shot("M1-02-add-form");
      const mark = api.mark();
      await app.ui.clickSelector("[role=dialog] form button[type=submit]");
      await until(async () => (await app.ui.mcpRows()).some((row) => row.name === "Dokploy"), 15_000, "the Dokploy row");
      await delay(1500);
      const rows = await app.ui.mcpRows();
      const dokploy = rows.find((row) => row.name === "Dokploy");
      await app.ui.shot("M1-03-added-synced");
      check("M1 badge Synced", dokploy.text.includes("Synced") && !dokploy.text.includes("From your account"), `row: ${dokploy.text}`);
      const put = lastPut(context, mark);
      const sent = put && JSON.parse(put.body).servers.find((server) => server.name === "Dokploy");
      check(
        "M1 PUT shape only",
        sent && sent.command === "npx" && sent.localParts?.args === true && JSON.stringify(sent.localParts?.env) === '["DOKPLOY_TOKEN"]' && !put.body.includes(secrets.mcpToken) && !put.body.includes("@dokploy") && !("args" in sent) && !("env" in sent),
        put ? `PUT body: ${put.body}` : "no PUT",
      );
      const before = await readJson(settingsFile(context));
      check("M1 file has args and env", JSON.stringify(before?.mcpServers?.Dokploy?.args) === '["-y","@dokploy/mcp"]' && before?.mcpServers?.Dokploy?.env?.DOKPLOY_TOKEN === secrets.mcpToken, `file Dokploy: ${JSON.stringify(before?.mcpServers?.Dokploy)}`);
      void firstMark;
      // A graceful quit and a relaunch on the same profile: the next merge.
      app = await context.launch(profile);
      await openProjectIfAsked(context);
      await openMcp(context);
      await delay(1500);
      const after = (await app.ui.mcpRows()).find((row) => row.name === "Dokploy");
      const panel = await app.ui.text("[role=dialog]");
      await app.ui.shot("M1-04-after-relaunch");
      check("M1 after relaunch row normal", after && after.enabled && after.text.includes("Synced") && !after.text.includes("From your account") && !after.addOnDevice && !setupLabelsIn(panel).length && !panel.includes("to finish setting up"), `row: ${after?.text}; enabled=${after?.enabled}`);
      const file = await readJson(settingsFile(context));
      const server = file?.mcpServers?.Dokploy;
      check("M1 after relaunch file intact", JSON.stringify(server?.args) === '["-y","@dokploy/mcp"]' && server?.env?.DOKPLOY_TOKEN === secrets.mcpToken && server?.metadata?.blameCloudLocalSetupRequired !== true && server?.disabled !== true, `file Dokploy: ${JSON.stringify(server)}`);
    },
  ],
  [
    "M2",
    async (context) => {
      const { api } = context;
      const profile = profiles(context.options.root).mcp;
      await context.quit();
      const path = join(userDataOf(profile), "mcp-settings.json");
      await rm(join(userDataOf(profile), "mcp-settings-backups"), { force: true, recursive: true });
      const oldFile = {
        mcpServers: {
          Dokploy: {
            args: ["-y", "@dokploy/mcp"],
            command: "npx",
            disabled: false,
            env: { DOKPLOY_TOKEN: secrets.mcpToken },
            metadata: { blameCloudUserId: users.A.id },
            oauth: { tokens: { access_token: secrets.oauthAccess } },
            type: "stdio",
          },
          Linear: {
            disabled: true,
            metadata: { blameCloudUserId: users.A.id, blameCloudLocalSetupRequired: true, blameCloudDisabled: false },
            type: "streamableHttp",
            url: "https://mcp.linear.example/mcp",
          },
          ByHand: { command: "node", args: ["/opt/tools/by-hand-server.js"] },
        },
      };
      await writeFile(path, JSON.stringify(oldFile, null, 2));
      // What older versions saved to the account: shapes only, no localParts.
      await api.setMcp(users.A.id, [
        { name: "Dokploy", transport: "stdio", command: "npx", disabled: false },
        { name: "Linear", transport: "streamableHttp", url: "https://mcp.linear.example/mcp", disabled: false },
      ]);
      const app = await context.launch(profile);
      await openProjectIfAsked(context);
      await openMcp(context);
      await delay(1500);
      const rows = await app.ui.mcpRows();
      await app.ui.shot("M2-01-after-update");
      const file = await readJson(path);
      const dokploy = file?.mcpServers?.Dokploy;
      const linear = file?.mcpServers?.Linear;
      const byHand = file?.mcpServers?.ByHand;
      check("M2 Dokploy intact", JSON.stringify(dokploy?.args) === JSON.stringify(oldFile.mcpServers.Dokploy.args) && dokploy?.env?.DOKPLOY_TOKEN === secrets.mcpToken && dokploy?.oauth?.tokens?.access_token === secrets.oauthAccess && dokploy?.disabled === false && dokploy?.metadata?.blameCloudLocalSetupRequired !== true, `file Dokploy: ${JSON.stringify(dokploy)}`);
      const linearRow = rows.find((row) => row.name === "Linear");
      check("M2 placeholder still flagged and says what to add", linear?.metadata?.blameCloudLocalSetupRequired === true && linearRow?.text.includes("To use it on this device, add") && linearRow?.addOnDevice, `file Linear: ${JSON.stringify(linear)}; row: ${linearRow?.text}`);
      check("M2 by-hand untouched", byHand?.command === "node" && JSON.stringify(byHand?.args) === JSON.stringify(oldFile.mcpServers.ByHand.args) && !byHand?.metadata?.blameCloudLocalSetupRequired && byHand?.disabled !== true, `file ByHand: ${JSON.stringify(byHand)}; row: ${rows.find((row) => row.name === "ByHand")?.text}`);
      const backups = await readdir(join(userDataOf(profile), "mcp-settings-backups")).catch(() => null);
      check("M2 backup folder", backups && backups.length > 0, `mcp-settings-backups: ${JSON.stringify(backups)}`);
      const panel = await app.ui.text("[role=dialog]");
      record("M2 rows", undefined, rows.map((row) => `${row.name}: ${row.text}`).join(" || ") + ` || setup labels: ${JSON.stringify(setupLabelsIn(panel))}`);
    },
  ],
  [
    "M3",
    async (context) => {
      const profile = profiles(context.options.root).mcp;
      await context.quit();
      const directory = userDataOf(profile);
      const path = join(directory, "mcp-settings.json");
      const broken = '{ "mcpServers": { "Dokploy": { "command": "npx", ';
      await writeFile(path, broken);
      const app = await context.launch(profile);
      await openProjectIfAsked(context);
      await openMcp(context);
      await delay(1000);
      const panel = await app.ui.text("[role=dialog]");
      await app.ui.shot("M3-01-unreadable-notice");
      const files = await readdir(directory);
      const aside = files.filter((name) => name.startsWith("mcp-settings.json.unreadable-"));
      const asideContent = aside.length ? await readFile(join(directory, aside.at(-1)), "utf8") : "";
      check("M3 notice", panel.includes("Your saved servers file could not be read"), `panel: ${panel.slice(0, 400)}`);
      check("M3 file kept aside", aside.length > 0 && asideContent === broken, `aside: ${JSON.stringify(aside)}; content equal: ${asideContent === broken}`);
      const file = await readJson(path);
      const rows = await app.ui.mcpRows();
      check("M3 servers came back, never an empty list", file && Object.keys(file.mcpServers ?? {}).length > 0 && rows.length > 0, `file servers: ${JSON.stringify(Object.keys(file?.mcpServers ?? {}))}; rows: ${rows.map((row) => row.name).join(", ")}`);
      await app.ui.click("Got it");
      await delay(600);
      const dismissed = !(await app.ui.has("could not be read", "[role=dialog]"));
      await app.ui.shot("M3-02-dismissed");
      check("M3 Got it dismisses", dismissed, `notice gone: ${dismissed}`);
    },
  ],
  [
    "M4",
    async (context) => {
      const { api } = context;
      const profile = profiles(context.options.root).mcp;
      // Start from a known file: Dokploy configured here and synced for A.
      await context.quit();
      const path = join(userDataOf(profile), "mcp-settings.json");
      const current = (await readJson(path)) ?? { mcpServers: {} };
      current.mcpServers.Dokploy = {
        ...(current.mcpServers.Dokploy ?? {}),
        type: "stdio",
        command: "npx",
        args: ["-y", "@dokploy/mcp"],
        env: { DOKPLOY_TOKEN: secrets.mcpToken },
        disabled: false,
      };
      await writeFile(path, JSON.stringify(current, null, 2));
      await api.setMcp(users.B.id, [{ name: "Dokploy", transport: "stdio", command: "uvx", disabled: false, localParts: { args: true, env: ["DOKPLOY_B_TOKEN"] } }]);
      let app = await context.launch(profile);
      await openProjectIfAsked(context);
      await openMcp(context);
      await delay(1200);
      const fileOk = async (step) => {
        const file = await readJson(path);
        const server = file?.mcpServers?.Dokploy;
        const ok = JSON.stringify(server?.args) === '["-y","@dokploy/mcp"]' && server?.env?.DOKPLOY_TOKEN === secrets.mcpToken && server?.metadata?.blameCloudLocalSetupRequired !== true;
        check(`M4 ${step}: file intact`, ok, `Dokploy: ${JSON.stringify(server)}`);
        return server;
      };
      const rowsOk = async (step) => {
        await openMcp(context);
        await delay(1500);
        const rows = await app.ui.mcpRows();
        const dokploy = rows.find((row) => row.name === "Dokploy");
        const panel = await app.ui.text("[role=dialog]");
        record(`M4 ${step}: badge and account`, undefined, `Dokploy row: ${dokploy?.text}; A's account lists: ${JSON.stringify(api.mcpOf(users.A.id)?.servers.map((server) => server.name))}; B's: ${JSON.stringify(api.mcpOf(users.B.id)?.servers.map((server) => server.name))}`);
        check(`M4 ${step}: no setup label on Dokploy`, dokploy && !dokploy.text.includes("From your account") && !dokploy.addOnDevice && !setupLabelsIn(panel).length, `row: ${dokploy?.text}; enabled=${dokploy?.enabled}`);
        return dokploy;
      };
      await fileOk("signed in as A");
      // Sign out from Settings → Account.
      await app.ui.click("Account", { scope: "[role=dialog] aside" });
      await delay(600);
      await app.ui.shot("M4-01-account-section");
      await app.ui.click("Log out", { scope: "[role=dialog]" });
      await app.ui.waitText("Continue without an account", 20_000);
      await delay(1000);
      await app.ui.shot("M4-02-signed-out");
      await fileOk("after sign-out");
      // The same user again.
      await signIn(context, "A", { seed: false });
      await openProjectIfAsked(context);
      await rowsOk("signed in again as A");
      await app.ui.shot("M4-03-signed-in-again-A");
      await fileOk("signed in again as A");
      // Another user, whose account has its own "Dokploy".
      await app.ui.click("Account", { scope: "[role=dialog] aside" });
      await delay(500);
      await app.ui.click("Log out", { scope: "[role=dialog]" });
      await app.ui.waitText("Continue without an account", 20_000);
      await signIn(context, "B", { seed: false });
      await openProjectIfAsked(context);
      const row = await rowsOk("switched to B");
      await app.ui.shot("M4-04-switched-to-B");
      const server = await fileOk("switched to B");
      record("M4 command after the switch to B", server?.command === "npx" ? true : false, `Dokploy command in the file: ${server?.command} (A configured npx; B's account has uvx); row: ${row?.text}`);
      // Back to A for M5.
      await app.ui.click("Account", { scope: "[role=dialog] aside" });
      await delay(500);
      await app.ui.click("Log out", { scope: "[role=dialog]" });
      await app.ui.waitText("Continue without an account", 20_000);
      await signIn(context, "A", { seed: false });
      await openProjectIfAsked(context);
      app = context.app;
    },
  ],
  [
    "M5",
    async (context) => {
      const { api } = context;
      const profile = profiles(context.options.root).mcp;
      let app = context.app;
      if (!app || app.profile !== profile) {
        app = await context.launch(profile);
        await openProjectIfAsked(context);
      }
      await openMcp(context);
      await delay(1200);
      const path = join(userDataOf(profile), "mcp-settings.json");
      const form = "[role=dialog] form";
      const editDokploy = async () => {
        await app.ui.click("Edit Dokploy");
        await until(() => app.ui.has("Edit Dokploy", form), 5000, "the edit form");
      };
      const dokployRow = async () => (await app.ui.mcpRows()).find((row) => row.name === "Dokploy");
      // Start from a synced Dokploy.
      if ((await dokployRow())?.text.includes("This device only")) {
        record("M5 start", undefined, `Dokploy was "This device only" before M5 (${(await dokployRow()).text}); switched to "Sync to my account" first`);
        await editDokploy();
        await app.ui.click("Sync to my account", { scope: form });
        await app.ui.clickSelector(`${form} button[type=submit]`);
        await until(async () => (await dokployRow())?.text.includes("Synced"), 10_000, "the Synced badge");
      }
      // To this device only: confirmed first.
      await editDokploy();
      await app.ui.click("Keep on this device only", { scope: form });
      let mark = api.mark();
      await app.ui.clickSelector(`${form} button[type=submit]`);
      await delay(600);
      const confirmText = await app.ui.text(form);
      await app.ui.shot("M5-01-leave-account-confirmation");
      check("M5 confirmation first", confirmText.includes("This removes “Dokploy” from your account") && confirmText.includes("Remove from account and save") && !lastPut(context, mark), `form: ${confirmText.slice(-300)}; PUT before confirm: ${Boolean(lastPut(context, mark))}`);
      await app.ui.click("Remove from account and save", { scope: form });
      await until(async () => (await dokployRow())?.text.includes("This device only"), 10_000, "the device-only badge");
      await delay(800);
      let put = lastPut(context, mark);
      await app.ui.shot("M5-02-device-only");
      check("M5 device only: badge and cloud copy gone", put && !JSON.parse(put.body).servers.some((server) => server.name === "Dokploy") && !api.mcpOf(users.A.id).servers.some((server) => server.name === "Dokploy"), `row: ${(await dokployRow())?.text}; PUT: ${put?.body}`);
      // Back to the account.
      await editDokploy();
      await app.ui.click("Sync to my account", { scope: form });
      mark = api.mark();
      await app.ui.clickSelector(`${form} button[type=submit]`);
      await until(async () => (await dokployRow())?.text.includes("Synced"), 10_000, "the Synced badge");
      await delay(800);
      put = lastPut(context, mark);
      let sent = put && JSON.parse(put.body).servers.find((server) => server.name === "Dokploy");
      await app.ui.shot("M5-03-synced-again");
      check("M5 synced again", sent && !put.body.includes(secrets.mcpToken) && !sent.secrets, `PUT: ${put?.body}`);
      // With its secrets.
      await editDokploy();
      await app.ui.clickSelector(`${form} [role=checkbox]`);
      await app.ui.shot("M5-04-sync-secrets-ticked");
      mark = api.mark();
      await app.ui.clickSelector(`${form} button[type=submit]`);
      await until(() => lastPut(context, mark), 10_000, "a PUT");
      await delay(800);
      put = lastPut(context, mark);
      sent = put && JSON.parse(put.body).servers.find((server) => server.name === "Dokploy");
      check("M5 secrets synced", sent?.secretsSynced === true && sent?.secrets?.env?.DOKPLOY_TOKEN === secrets.mcpToken && JSON.stringify(sent?.secrets?.args) === '["-y","@dokploy/mcp"]', `PUT Dokploy: ${JSON.stringify(sent)}`);
      const title = await app.ui.evaluate(`[...document.querySelectorAll('[role=dialog] button[title]')].map((b) => b.title).join(" | ")`);
      record("M5 badge title with secrets", title.includes("with its arguments and secrets"), `badge titles: ${title}`);
      // Without them again.
      await editDokploy();
      await app.ui.clickSelector(`${form} [role=checkbox]`);
      mark = api.mark();
      await app.ui.clickSelector(`${form} button[type=submit]`);
      await until(() => lastPut(context, mark), 10_000, "a PUT");
      await delay(800);
      put = lastPut(context, mark);
      sent = put && JSON.parse(put.body).servers.find((server) => server.name === "Dokploy");
      check("M5 secrets forgotten", sent?.secretsSynced === false && !sent?.secrets && !put.body.includes(secrets.mcpToken) && !api.mcpOf(users.A.id).secrets.Dokploy, `PUT Dokploy: ${JSON.stringify(sent)}; mock keeps secrets for: ${JSON.stringify(Object.keys(api.mcpOf(users.A.id).secrets))}`);
      const local = (await readJson(path))?.mcpServers?.Dokploy;
      check("M5 local copy whole throughout", local?.env?.DOKPLOY_TOKEN === secrets.mcpToken && JSON.stringify(local?.args) === '["-y","@dokploy/mcp"]', `file Dokploy: ${JSON.stringify(local)}`);
      // Another device saved two servers to the account.
      const stored = api.mcpOf(users.A.id);
      await api.setMcp(users.A.id, [
        ...stored.servers.map((server) => (stored.secrets[server.name] ? { ...server, secrets: stored.secrets[server.name], secretsSynced: true } : server)),
        { name: "Sentry", transport: "stdio", command: "npx", disabled: false, localParts: {}, secrets: { args: ["-y", "@sentry/mcp-server"], env: { SENTRY_TOKEN: secrets.sentryToken } }, secretsSynced: true },
        { name: "Grafana", transport: "stdio", command: "uvx", disabled: false, localParts: { env: ["X_TOKEN"] } },
      ]);
      app = await context.launch(profile);
      await openProjectIfAsked(context);
      await openMcp(context);
      await delay(1500);
      const rows = await app.ui.mcpRows();
      await app.ui.shot("M5-05-from-another-device");
      const sentry = rows.find((row) => row.name === "Sentry");
      const grafana = rows.find((row) => row.name === "Grafana");
      const file = await readJson(path);
      check("M5 Sentry complete and enabled", sentry?.enabled && !sentry.addOnDevice && file?.mcpServers?.Sentry?.env?.SENTRY_TOKEN === secrets.sentryToken && file?.mcpServers?.Sentry?.disabled !== true, `row: ${sentry?.text}; enabled=${sentry?.enabled}; file: ${JSON.stringify(file?.mcpServers?.Sentry)}`);
      check("M5 Grafana says what to add", grafana?.text.includes("To use it on this device, add X_TOKEN") && grafana.addOnDevice && !grafana.enabled, `row: ${grafana?.text}`);
      const alarm = await app.ui.evaluate(`[...document.querySelectorAll("[role=dialog] main *")].filter((e) => /amber|yellow|orange|warning/.test(String(e.className))).map((e) => String(e.className).slice(0, 80))`);
      check("M5 no alarm banner", alarm.length === 0 && rows.every((row) => !row.alarm), `amber/yellow/warning classes in the panel: ${JSON.stringify(alarm)}`);
      // The form for the placeholder.
      await app.ui.click("Add details for Grafana on this device");
      await delay(500);
      await app.ui.shot("M5-06-grafana-form");
      record("M5 Grafana form", undefined, (await app.ui.text(form)).slice(0, 400));
      await app.ui.click("Cancel", { scope: form });
    },
  ],
  [
    "M6",
    async (context) => {
      const { api } = context;
      const profile = profiles(context.options.root).local;
      await rm(profile, { force: true, recursive: true });
      const app = await context.launch(profile);
      await app.ui.waitText("Continue without an account", 60_000);
      await app.ui.shot("M6-01-sign-in-screen");
      const choice = { providerId: "openai-compatible", modelId: "lfc-mock-model", credentialLabel: "Seeded", reasoningEffort: null };
      await localApi(app.local, "/providers/credentials", "POST", { providerId: "openai-compatible", label: "Seeded", apiKey: secrets.seedKey, baseUrl: modelBase, modelIds: ["lfc-mock-model"] });
      await localApi(app.local, "/account/ai-preferences", "PUT", { agentModel: choice, alternativeModel: choice });
      await app.cdp.evaluate(`localStorage.setItem("blame.runtime-offer-done.v1", "true")`);
      await app.ui.click("Continue without an account");
      await delay(2500);
      if (await app.ui.has("Connect your AI provider")) {
        record("M6 onboarding", undefined, "the AI setup showed although the local API had AI preferences saved before continuing; finished through the screen");
        await finishOnboarding(app.ui);
      }
      await openProjectIfAsked(context);
      const mark = api.mark();
      await openMcp(context);
      await app.ui.click("Add server", { scope: "[role=dialog] main" });
      await app.ui.fill('[role=dialog] form input[placeholder="GitHub"]', "LocalOnly");
      await app.ui.fill('[role=dialog] form input[placeholder="npx"]', "node");
      await app.ui.click("Advanced options");
      await app.ui.fill('[role=dialog] form input[placeholder="-y @modelcontextprotocol/server-github"]', "/opt/tools/local.js");
      const formText = await app.ui.text("[role=dialog] form");
      await app.ui.shot("M6-02-add-form-no-choice");
      check("M6 no sync choice", !formText.includes("Where to keep this server") && !formText.includes("Sync to my account"), `form: ${formText.slice(0, 300)}`);
      await app.ui.clickSelector("[role=dialog] form button[type=submit]");
      await until(async () => (await app.ui.mcpRows()).some((row) => row.name === "LocalOnly"), 10_000, "the LocalOnly row");
      let row = (await app.ui.mcpRows()).find((entry) => entry.name === "LocalOnly");
      await app.ui.shot("M6-03-added-no-badge");
      check("M6 no badge", !row.text.includes("Synced") && !row.text.includes("This device only"), `row: ${row.text}`);
      await app.ui.click("Edit LocalOnly");
      await app.ui.fill('[role=dialog] form input[placeholder="-y @modelcontextprotocol/server-github"]', "/opt/tools/local-v2.js");
      await app.ui.clickSelector("[role=dialog] form button[type=submit]");
      await until(async () => (await app.ui.mcpRows()).find((entry) => entry.name === "LocalOnly")?.text.includes("local-v2"), 10_000, "the edit");
      row = (await app.ui.mcpRows()).find((entry) => entry.name === "LocalOnly");
      check("M6 edit", row.text.includes("local-v2.js"), `row: ${row.text}`);
      await app.ui.click("Remove LocalOnly");
      await until(async () => !(await app.ui.mcpRows()).some((entry) => entry.name === "LocalOnly"), 10_000, "the removal");
      const file = await readJson(join(userDataOf(profile), "mcp-settings.json"));
      await app.ui.shot("M6-04-removed");
      check("M6 remove", !file?.mcpServers?.LocalOnly, `file: ${JSON.stringify(file)}`);
      const toApi = api.since(mark, (request) => request.path.includes("mcp"));
      check("M6 nothing sent to the account API", toApi.length === 0, `mcp requests to the mock: ${toApi.length}`);
      await context.quit();
    },
  ],
  [
    "P1",
    async (context) => {
      const { api } = context;
      const profile = profiles(context.options.root).providers;
      await rm(profile, { force: true, recursive: true });
      const app = await context.launch(profile);
      await signIn(context, "C", { seed: false });
      await app.ui.waitText("Connect your AI provider", 60_000);
      await delay(2500);
      await app.ui.shot("P1-01-onboarding");
      const mark = api.mark();
      // The OpenAI-compatible tile.
      const tiles = await app.ui.evaluate(`[...document.querySelectorAll("button")].map((b) => b.innerText.replace(/\\s+/g, " ").trim()).filter(Boolean).slice(0, 40)`);
      const tile = tiles.find((label) => /compatible/i.test(label));
      if (!tile) throw new Error(`No OpenAI-compatible tile: ${JSON.stringify(tiles)}`);
      await app.ui.click(tile);
      await app.ui.waitText("Where to keep this key", 15_000);
      const dialog = "[role=dialog]";
      await app.ui.fill(`${dialog} #provider-label`, "Mock device");
      await app.ui.fill(`${dialog} #provider-api-key`, secrets.deviceKey);
      await app.ui.fill(`${dialog} #provider-base-url`, modelBase);
      await app.ui.fill(`${dialog} #provider-model-id`, "lfc-mock-model");
      await app.ui.press("Enter", "Enter", 13, 0, "\r");
      await delay(300);
      const deviceDefault = await app.ui.radioChecked("Keep on this device only", dialog);
      const keyType = await app.ui.evaluate(`document.querySelector("#provider-api-key").type`);
      await app.ui.shot("P1-02-connect-dialog");
      check("P1 choice shown, default device", deviceDefault === "true" && (await app.ui.has("Save to my Blame account (available on your other devices)", dialog)), `"Keep on this device only" aria-checked=${deviceDefault}; key input type=${keyType}`);
      await app.ui.click("Continue", { scope: dialog });
      await until(async () => !(await app.ui.evaluate(`Boolean(document.querySelector("#provider-api-key"))`)), 20_000, "the dialog to close");
      await delay(1500);
      await app.ui.shot("P1-03-connected");
      const posted = api.since(mark, (request) => request.path.startsWith("/providers/credentials") && request.method !== "GET");
      const anyKey = api.since(mark, (request) => request.body.includes(secrets.deviceKey));
      check("P1 nothing posted", posted.length === 0 && anyKey.length === 0, `credential writes to the mock: ${JSON.stringify(posted.map((r) => `${r.method} ${r.path}`))}; requests carrying the key: ${anyKey.length}`);
      const directory = join(userDataOf(profile), "device-credentials");
      const files = await readdir(directory).catch(() => []);
      const index = await readFile(join(directory, "credentials.json"), "utf8").catch(() => "");
      check("P1 device store", index && !index.includes(secrets.deviceKey) && files.filter((name) => /^device-.*\.bin$/.test(name)).length === 1, `files: ${JSON.stringify(files)}; credentials.json: ${index.replace(/\s+/g, " ")}`);
      check("P1 provider connected", await app.ui.has("1 provider connected"), (await app.ui.text()).slice(0, 300));
      // Finish the onboarding with that model.
      await finishOnboarding(app.ui);
      await openProjectIfAsked(context);
      await app.ui.shot("P1-04-workspace");
    },
  ],
  [
    "P2",
    async (context) => {
      const { api } = context;
      const profile = profiles(context.options.root).providers;
      let app = context.app;
      if (!app || app.profile !== profile) {
        app = await context.launch(profile);
        await openProjectIfAsked(context);
      }
      const ui = app.ui;
      const deviceDir = join(userDataOf(profile), "device-credentials");
      const deviceIndex = async () => (await readJson(join(deviceDir, "credentials.json")))?.credentials ?? [];
      const providerRow = (name) =>
        ui.evaluate(`(() => {
          const manage = [...document.querySelectorAll("[role=dialog] main button")].filter((b) => b.innerText.trim() === "Manage");
          const named = new RegExp("(^| )" + ${JSON.stringify(name)} + " [0-9]+ connection");
          for (const button of manage) {
            // The row: the largest ancestor holding this one Manage button only.
            let row = button;
            while (row.parentElement && row.parentElement.innerText.length < 300 && [...row.parentElement.querySelectorAll("button")].filter((b) => b.innerText.trim() === "Manage").length === 1) row = row.parentElement;
            const text = row.innerText.replace(/\\s+/g, " ");
            if (named.test(text)) return { text, index: manage.indexOf(button) };
          }
          return null;
        })()`);
      const manage = async (name) => {
        const row = await providerRow(name);
        if (!row) throw new Error(`No provider row for ${name}`);
        await ui.click("Manage", { scope: "[role=dialog] main", index: row.index });
        await delay(900);
      };
      const credentialsOf = (providerId) => localApi(app.local, "/providers/credentials").then((value) => (value.data ?? value).filter((entry) => entry.providerId === providerId));
      await ui.openSettings("Models & Providers");
      await delay(1500);
      let row = await providerRow("OpenAI-compatible");
      await ui.shot("P2-01-models-providers");
      check("P2 device badge on the row", row?.text.includes("This device only") && !row.text.includes("Synced"), `row: ${row?.text}`);
      // A second provider, saved to the account.
      let mark = api.mark();
      await ui.click("Connect provider", { scope: "[role=dialog] main" });
      await delay(800);
      await ui.click("OpenAI", { selector: "[cmdk-item]" });
      await ui.waitText("Where to keep this key", 10_000);
      await ui.fill("#provider-label", "Work");
      await ui.fill("#provider-api-key", secrets.accountKey);
      await ui.click("Save to my Blame account (available on your other devices)");
      await ui.shot("P2-02-connect-openai-to-account");
      await ui.click("Continue");
      await until(async () => !(await ui.evaluate(`Boolean(document.querySelector("#provider-api-key"))`)), 20_000, "the dialog to close");
      await delay(1500);
      const posts = api.since(mark, (request) => request.method === "POST" && request.path === "/providers/credentials");
      check("P2 account credential POSTed", posts.length === 1 && JSON.parse(posts[0].body).providerId === "openai" && posts[0].body.includes(secrets.accountKey), `POSTs: ${JSON.stringify(posts.map((r) => JSON.parse(r.body)).map(({ apiKey, ...rest }) => ({ ...rest, apiKey: apiKey === secrets.accountKey ? "<the fake account key>" : "?" })))}`);
      row = await providerRow("OpenAI");
      const rows = await ui.text("[role=dialog] main");
      await ui.shot("P2-03-two-providers");
      record("P2 badges", undefined, rows.slice(0, 600));
      // Move the device-only connection to the account (no key typed).
      await manage("OpenAI-compatible");
      const list = await ui.text("body");
      await ui.shot("P2-04-connections-list");
      await ui.click("Mock device", { selector: "button" }).catch(async () => {
        await ui.evaluate(`[...document.querySelectorAll("[role=dialog] button")].find((b) => b.innerText.includes("Mock device")).click()`);
      });
      await ui.waitText("Where to keep this key", 10_000);
      const keyType = await ui.evaluate(`document.querySelector("#provider-api-key")?.type`);
      await ui.click("Save to my Blame account (available on your other devices)");
      await delay(300);
      const moveLabel = await ui.evaluate(`[...document.querySelectorAll("[role=dialog] form button[type=submit]")].map((b) => b.innerText.trim()).join(",")`);
      await ui.shot("P2-05-move-to-account");
      check("P2 Move button, masked key", moveLabel === "Move" && keyType === "password" && (await ui.has("Saving moves this connection to your Blame account")), `submit label: ${moveLabel}; key input type=${keyType}; list before: ${list.slice(list.indexOf("connections"), list.indexOf("connections") + 200)}`);
      mark = api.mark();
      await ui.clickSelector("[role=dialog] form button[type=submit]");
      await until(async () => !(await ui.evaluate(`Boolean(document.querySelector("#provider-api-key"))`)), 20_000, "the move");
      await delay(1500);
      const moved = api.since(mark);
      const accountCopy = (await credentialsOf("openai-compatible")).find((entry) => entry.label === "Mock device");
      const deviceAfterMove = await deviceIndex();
      check("P2 moved to account", accountCopy && !deviceAfterMove.some((entry) => entry.label === "Mock device") && moved.some((r) => r.method === "POST" && r.path === "/providers/credentials" && r.body.includes(secrets.deviceKey)), `requests: ${JSON.stringify(moved.map((r) => `${r.method} ${r.path} ${r.status}`))}; account holds: ${JSON.stringify(accountCopy && { id: accountCopy.id, label: accountCopy.label })}; device index: ${JSON.stringify(deviceAfterMove.map((entry) => entry.label))}`);
      await ui.shot("P2-06-after-move-to-account");
      // And back to this device.
      await manage("OpenAI-compatible");
      await ui.evaluate(`[...document.querySelectorAll("[role=dialog] button")].find((b) => b.innerText.includes("Mock device"))?.click()`);
      await ui.waitText("Where to keep this key", 10_000);
      await ui.click("Keep on this device only");
      await delay(300);
      const backLabel = await ui.evaluate(`[...document.querySelectorAll("[role=dialog] form button[type=submit]")].map((b) => b.innerText.trim()).join(",")`);
      mark = api.mark();
      await ui.clickSelector("[role=dialog] form button[type=submit]");
      await until(async () => !(await ui.evaluate(`Boolean(document.querySelector("#provider-api-key"))`)), 20_000, "the move back");
      await delay(1500);
      const back = api.since(mark);
      const stillInAccount = (await credentialsOf("openai-compatible")).find((entry) => entry.label === "Mock device");
      const deviceBack = await deviceIndex();
      check("P2 moved back to device", backLabel === "Move" && !stillInAccount && deviceBack.some((entry) => entry.label === "Mock device") && back.some((r) => r.method === "DELETE" && r.path.startsWith("/providers/credentials/")) && !back.some((r) => r.body.includes(secrets.deviceKey)), `submit label: ${backLabel}; requests: ${JSON.stringify(back.map((r) => `${r.method} ${r.path} ${r.status}`))}; device index: ${JSON.stringify(deviceBack.map((entry) => ({ label: entry.label, lastFour: entry.lastFour })))}`);
      await ui.shot("P2-07-back-on-device");
      // A key-only provider kept on the device shows the end of its key.
      mark = api.mark();
      await ui.click("Connect provider", { scope: "[role=dialog] main" });
      await delay(800);
      await ui.click("Anthropic", { selector: "[cmdk-item]" });
      await ui.waitText("Where to keep this key", 10_000);
      await ui.fill("#provider-label", "Laptop");
      await ui.fill("#provider-api-key", secrets.secondDeviceKey);
      const anthropicDefault = await ui.radioChecked("Keep on this device only");
      await ui.click("Continue");
      await until(async () => !(await ui.evaluate(`Boolean(document.querySelector("#provider-api-key"))`)), 20_000, "the dialog to close");
      await delay(1200);
      await manage("Anthropic");
      const anthropicList = await ui.evaluate(`[...document.querySelectorAll("[role=dialog] button")].map((b) => b.innerText.replace(/\\s+/g, " ")).filter((t) => t.includes("Laptop")).join(" | ")`);
      await ui.shot("P2-08-anthropic-ending-in");
      check("P2 ending in, nothing sent", anthropicDefault === "true" && anthropicList.includes("API key ending in 1234") && api.since(mark, (r) => r.body.includes(secrets.secondDeviceKey) || (r.method === "POST" && r.path === "/providers/credentials")).length === 0, `default device=${anthropicDefault}; connection: ${anthropicList}`);
      const allRows = await ui.text("body");
      await ui.press("Escape", "Escape", 27);
      await delay(400);
      record("P2 final rows", undefined, allRows.slice(allRows.indexOf("Provider connections"), allRows.indexOf("Provider connections") + 500));
      await ui.closeSettings();
    },
  ],
  [
    "P3",
    async (context) => {
      const { api, model } = context;
      const profile = profiles(context.options.root).providers;
      const deviceCalls = (mark) => model.requests.slice(mark).filter((r) => r.path.includes("chat/completions") && r.authorization === `Bearer ${secrets.deviceKey}`);
      const describeCalls = (mark) => JSON.stringify(model.requests.slice(mark).map((r) => `${r.method} ${r.path} ${r.model} ${r.authorization === `Bearer ${secrets.deviceKey}` ? "Bearer <device key>" : r.authorization}`));
      const engineProviders = async (ui) => {
        const value = await ui.evaluate(`window.blame.engine.call("providers", { refresh: true }).then((v) => JSON.stringify(v)).catch((e) => "error: " + e.message)`);
        if (value.startsWith("error:")) return value;
        const found = [];
        JSON.parse(value, (key, entry) => {
          if (entry && typeof entry === "object" && entry.providerId === "openai-compatible" && entry.label) found.push({ label: entry.label, storage: entry.storage, lastFour: entry.lastFour });
          return entry;
        });
        return JSON.stringify(found);
      };
      // 1. Relaunch with the API stopped.
      await context.quit();
      await api.stop();
      const apiMark = api.mark();
      try {
        const app = await context.launch(profile);
        const ui = app.ui;
        await until(async () => {
          const text = await ui.text();
          return ["Agent Queue", "Continue without an account", "Connect your AI provider", "Open Project"].some((value) => text.includes(value));
        }, 60_000, "a screen");
        await delay(3000);
        const text = await ui.text();
        await ui.shot("P3-01-launch-api-down");
        check("P3 no sign-out", !text.includes("Continue without an account"), `screen: ${text.slice(0, 200)}`);
        check("P3 workspace opens", text.includes("Agent Queue"), `screen: ${text.slice(0, 300)}`);
        record("P3 engine providers, API down", undefined, await engineProviders(ui));
      } finally {
        await api.start();
      }
      check("P3 API received nothing while down", api.since(apiMark).length === 0, `requests: ${api.since(apiMark).length}`);
      // 2. The API up at launch, stopped while the app runs: a chat on the device key.
      const app = await context.launch(profile);
      const ui = app.ui;
      await openProjectIfAsked(context);
      await ui.press("2", "Digit2", 50, 4 /* meta */);
      await until(() => ui.evaluate(`Boolean(document.querySelector("[contenteditable='true']"))`), 20_000, "the chat composer");
      await delay(1200);
      await dismissOffers(ui);
      const send = async (message) => {
        await ui.clickSelector("[contenteditable='true']");
        await ui.send("Input.insertText", { text: message });
        await delay(200);
        await ui.press("Enter", "Enter", 13, 0, "\r");
      };
      let modelMark = model.requests.length;
      let mark = api.mark();
      await send("Say hello in one sentence.");
      await until(() => deviceCalls(modelMark).length > 0, 60_000, "the model to be called with the device key").catch(() => undefined);
      await delay(2500);
      await ui.shot("P3-02-chat-api-up");
      check("P3 chat with API up uses the device key", deviceCalls(modelMark).length > 0, `model calls: ${describeCalls(modelMark)}; API requests meanwhile: ${JSON.stringify(api.since(mark).map((r) => `${r.method} ${r.path}`))}`);
      check("P3 no credential resolve at the API", !api.since(mark).some((r) => r.path.startsWith("/providers/credentials/resolve") || r.body.includes(secrets.deviceKey)), `credential requests: ${JSON.stringify(api.since(mark).filter((r) => r.path.startsWith("/providers")).map((r) => `${r.method} ${r.path}`))}`);
      await api.stop();
      try {
        modelMark = model.requests.length;
        mark = api.mark();
        await delay(2000);
        await ui.cdp.retarget().catch(() => undefined);
        record("P3 screen after the API stopped", undefined, `windows: ${JSON.stringify((await (await fetch(`http://127.0.0.1:${process.env.DRIVE_PORT_FOR_DEBUG}/json`)).json()).map((t) => `${t.id.slice(0, 6)} ${t.type} ${t.url}`))}; ${(await ui.text()).slice(0, 300)}`);
        await send("And once more, with the API stopped.");
        await until(() => deviceCalls(modelMark).length > 0, 8_000, "the model").catch(() => undefined);
        const composer = () => ui.evaluate(`document.querySelector("[contenteditable='true']")?.innerText.trim() ?? ""`);
        if (!deviceCalls(modelMark).length && (await composer()).includes("once more")) {
          await ui.shot("P3-03a-enter-did-not-send");
          const arrow = await ui.evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((b) => b.querySelector(".lucide-arrow-up, .lucide-arrow-up-icon")); if (!b) return "none"; b.click(); return "clicked, disabled=" + b.disabled; })()`);
          await until(() => deviceCalls(modelMark).length > 0, 30_000, "the model").catch(() => undefined);
          record("P3 Enter did not send with the API stopped", undefined, `send button: ${arrow}; composer after: "${await composer()}"; screen: ${(await ui.text()).slice(-400)}`);
        }
        await delay(2500);
        await ui.shot("P3-03-chat-api-stopped");
        const answers = await ui.evaluate(`document.body.innerText.split("Hello from the local-first mock model.").length - 1`);
        check("P3 chat with API stopped reaches the model with the device key", deviceCalls(modelMark).length > 0, `model calls: ${describeCalls(modelMark)}; answers on screen: ${answers}; API requests: ${api.since(mark).length}`);
        record("P3 engine providers, API stopped while running", undefined, await engineProviders(ui));
      } finally {
        await api.start();
      }
    },
  ],
  [
    "P4",
    async (context) => {
      const root = context.options.root;
      await context.quit();
      const hits = {};
      for (const [name, value] of Object.entries(secrets)) {
        const { stdout } = await execFileAsync("grep", ["-rlF", value, root]).catch((error) => ({ stdout: error.stdout ?? "" }));
        hits[name] = stdout.split("\n").filter(Boolean).map((path) => path.slice(root.length));
      }
      const inLogs = Object.entries(hits).flatMap(([name, paths]) => paths.filter((path) => /\/logs?\//i.test(path) || path.endsWith(".log")).map((path) => `${name}: ${path}`));
      check("P4 no fake key in log files", inLogs.length === 0, inLogs.join(", ") || `no log file holds any; files that do (expected stores): ${JSON.stringify(hits)}`);
    },
  ],
];

// ------------------------------------------------------------------ electron

async function inElectron() {
  const profile = process.argv.at(-1);
  const { app, BrowserWindow, dialog } = await import("electron");
  for (const name of ["appData", "userData", "sessionData"]) app.setPath(name, profile);
  app.setAppLogsPath(join(profile, "logs"));
  app.getAppPath = () => application;
  app.setAsDefaultProtocolClient = () => false;
  app.commandLine.appendSwitch("remote-debugging-port", process.env.DRIVE_PORT);
  app.on("browser-window-created", (_event, window) => window.webContents.setBackgroundThrottling(false));
  process.env.LIMA_HOME = join(profile, "lima");
  process.env.BLAME_WSL_DISTRO = "BlameLocalFirstDrive";
  process.env.BLAME_CLAUDE_CODE_STATE_DIR = join(profile, "claude-code");
  const fail = (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    app.exit(1);
  };
  process.once("uncaughtException", fail);
  process.once("unhandledRejection", fail);
  // An app whose drive died (killed, interrupted) quits by itself.
  const parent = Number(process.env.DRIVE_PARENT_PID);
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      app.exit(1);
    }
  }, 2000).unref();
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.env.DRIVE_PROJECT] });
  void app.whenReady().then(async () => {
    setInterval(() => {
      const ids = BrowserWindow.getAllWindows()
        .filter((window) => !window.isDestroyed())
        .map((window) => /^window:(\d+):/.exec(window.getMediaSourceId())?.[1])
        .filter(Boolean);
      console.log(`DRIVE_WINDOWS ${ids.join(",")}`);
    }, 500).unref();
    await windowShowing(BrowserWindow, "");
    console.log("DRIVE_READY");
  }).catch(fail);

  await import(pathToFileURL(join(application, "out/main/index.js")).href);
}

async function windowShowing(BrowserWindow, text, timeoutMs = 90_000) {
  const check = `document.readyState === "complete" && Boolean(document.body?.innerText.includes(${JSON.stringify(text)}))`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isLoading()) continue;
      if (await window.webContents.executeJavaScript(check).catch(() => false)) return window;
    }
    await delay(50);
  }
  throw new Error(`No window showed "${text}"`);
}

void stat;
if (process.versions.electron) await inElectron();
else await drive();
