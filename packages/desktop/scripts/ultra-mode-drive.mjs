// Drives the built desktop app through ultra mode, in an isolated profile,
// against a scripted model: the person turns ultra mode on in the composer,
// sends a message, the lead agent starts three helpers, and the script takes
// screenshots (light and dark) of the reasoning menu, the composer, the
// helper agents card while it runs and when it is done, and a helper's
// thread. It also measures the engine's footprint with and without helpers.
//
//   cargo build -p blame-engine -p blame-harness
//   pnpm --filter @blame/desktop exec electron-vite build
//   pnpm --filter @blame/api build
//   node scripts/ultra-mode-drive.mjs --out /tmp/ultra-shots [--model claude-sonnet-5-5]
//
// The model is an Anthropic-shaped server on a `*.localhost` host that
// decides each reply from the request itself (the lead's, or a helper's by
// its role prompt), so helpers racing never confuse the script. The app runs
// with its own profile and Lima home and never reaches a real provider.
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const here = fileURLToPath(new URL(".", import.meta.url));
const application = resolve(here, "..");


// ---------------------------------------------------------------- the model

/** How long each helper's first request takes, so the card is seen running. */
const firstReplyMs = { explore: 4000, research: 9000, review: 6500 };

const briefs = [
  {
    role: "explore",
    title: "Where routes are registered",
    brief:
      "Find where the HTTP routes of this project are registered and which handler each one calls. Reference the lines.",
  },
  {
    role: "research",
    title: "How the router library handles params",
    brief:
      "Check the documentation of the router library this project uses: how are path parameters typed, and is there a breaking change in the latest minor? Give URLs.",
  },
  {
    role: "review",
    title: "Review the uncommitted changes",
    brief:
      "Review the current uncommitted changes of the workspace. Report anything that could break an existing caller.",
  },
];

const reports = {
  explore: {
    summary:
      "Routes are registered once, in `registerRoutes` of `src/router.ts`, and each one points at a handler exported from `src/handlers/`. `src/server.ts` calls it at startup.",
    references: [
      { ref: "src/router.ts:4", note: "registerRoutes: the one place routes are added" },
      { ref: "src/handlers/users.ts:1", note: "the users handlers the router imports" },
      { ref: "src/server.ts:3", note: "calls registerRoutes at startup" },
    ],
  },
  research: {
    summary:
      "Path parameters are typed through a generic on the route definition. The latest minor deprecates the untyped form but still accepts it.",
    references: [
      { ref: "https://example.com/router/docs/params", note: "typed path parameters" },
      { ref: "https://example.com/router/changelog", note: "the deprecation in the latest minor" },
    ],
  },
  review: {
    summary:
      "The new `/health` route is fine, but `registerRoutes` now takes a second argument and `server.ts` still calls it with one.",
    references: [
      { ref: "src/router.ts:4", note: "blocker: new required parameter, one caller not updated" },
      { ref: "src/server.ts:3", note: "issue: still passes a single argument" },
    ],
  },
};

const helperTools = {
  explore: { name: "search_code", input: { query: "registerRoutes" } },
  research: { name: "search_web", input: { query: "router path parameters typed" } },
  review: { name: "read_code", input: { target: "src/router.ts" } },
};

function systemText(body) {
  return typeof body.system === "string"
    ? body.system
    : (body.system ?? []).map((block) => block.text ?? "").join("\n");
}

function helperRole(body) {
  const system = systemText(body);
  if (system.startsWith("You answer one question about a codebase")) return "explore";
  if (system.startsWith("You answer one question from the web")) return "research";
  if (system.startsWith("You review the current changes")) return "review";
  return undefined;
}

function userText(message) {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

/** What the model answers: `{ pieces }` of text, or `{ tool, input }`, after `wait` ms. */
function decide(body) {
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  const answered = last?.role === "user" && Array.isArray(last.content) && last.content.some((block) => block.type === "tool_result");
  const role = helperRole(body);
  if (role) {
    if (answered && messages.filter((m) => m.role === "assistant").length === 1)
      return { wait: 400, usage: [900, 160], tool: "report", input: reports[role] };
    if (answered) return { wait: 100, usage: [900, 20], pieces: ["Done."] };
    return { wait: firstReplyMs[role], usage: [3200, 180], tool: helperTools[role].name, input: helperTools[role].input };
  }
  const tools = (body.tools ?? []).map((tool) => tool.name);
  if (tools.includes("run_agents")) {
    const asked = messages.map((m) => (m.role === "user" ? userText(m) : "")).join("\n");
    if (answered)
      return {
        wait: 300,
        usage: [2400, 120],
        pieces: [
          "The three helpers agree on the picture. Routes are registered in `registerRoutes` (`src/router.ts:4`), ",
          "the router's typed path parameters are documented, and the review found one blocker: ",
          "`src/server.ts:3` still calls `registerRoutes` with one argument.",
        ],
      };
    const last_user = userText(last);
    if (last_user.includes("Ultra mode is on for this message") || last_user.includes("force helpers"))
      return { wait: 500, usage: [2100, 300], tool: "run_agents", input: { agents: briefs } };
    void asked;
    return { wait: 300, usage: [1800, 40], pieces: ["Ok. I did this one on my own: no helper agents were needed."] };
  }
  // Titles and other small tasks the app asks of the model.
  return { wait: 100, usage: [200, 10], pieces: ["Routes overview"] };
}

function sseOf({ usage, pieces, tool, input }) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const out = [
    event("message_start", {
      type: "message_start",
      message: { id: "msg_mock", type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage[0], output_tokens: 1 } },
    }),
  ];
  if (tool) {
    out.push(
      event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2)}`, name: tool, input: {} } }),
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }),
      event("content_block_stop", { type: "content_block_stop", index: 0 })
    );
  } else {
    out.push(event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    for (const piece of pieces)
      out.push(event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }));
    out.push(event("content_block_stop", { type: "content_block_stop", index: 0 }));
  }
  out.push(
    event("message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: usage[1] } }),
    event("message_stop", { type: "message_stop" })
  );
  return out.join("");
}

async function startModel() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      // Not a model request.
    }
    const plan = decide(body);
    requests.push({ role: helperRole(body) ?? "lead", tool: plan.tool });
    await delay(plan.wait);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sseOf(plan));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { port: server.address().port, requests, close: () => (server.closeAllConnections(), server.close()) };
}

// -------------------------------------------------------------------- driver

async function drive() {
  const options = parseOptions(process.argv.slice(2));
  const scratch = await mkdtemp(join(tmpdir(), "blame-ultra-drive-"));
  await mkdir(options.out, { recursive: true });
  const project = join(scratch, "project");
  await prepareProject(project);
  const model = await startModel();
  const debugPort = 9300 + Math.floor(Math.random() * 400);
  const electron = createRequire(import.meta.url)("electron");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_RENDERER_URL;
  delete environment.BLAME_RUNTIME_BIN_DIR;
  Object.assign(environment, {
    ULTRA_DRIVE_MODEL_URL: `http://ultra-mock.localhost:${model.port}`,
    ULTRA_DRIVE_MODEL: options.model,
    ULTRA_DRIVE_PROJECT: project,
    ULTRA_DRIVE_PORT: String(debugPort),
    BLAME_ENGINE_LOG: "warn",
  });
  const child = spawn(electron, [fileURLToPath(import.meta.url), join(scratch, "profile")], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  try {
    await until(() => output.includes("ULTRA_DRIVE_READY"), 120_000, "the app to open the project");
    const cdp = await connect(debugPort);
    await scenario(cdp, options, model, child);
  } catch (error) {
    console.error(output.slice(-4000));
    throw error;
  } finally {
    child.kill("SIGTERM");
    await delay(1500);
    model.close();
    await rm(scratch, { force: true, recursive: true });
    process.exit(process.exitCode ?? 0);
  }
}

function parseOptions(argv) {
  const options = { model: "claude-sonnet-5-5", out: resolve("ultra-shots") };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") options.out = resolve(argv[++index]);
    else if (argv[index] === "--model") options.model = argv[++index];
  }
  return options;
}

async function prepareProject(directory) {
  await mkdir(join(directory, "src/handlers"), { recursive: true });
  const files = {
    "package.json": JSON.stringify({ name: "ultra-demo", version: "1.0.0", type: "module" }, null, 2),
    "src/handlers/users.ts": "export function listUsers() {\n  return [{ id: 1, name: \"Ada\" }]\n}\n",
    "src/router.ts": "import { listUsers } from \"./handlers/users\"\n\nexport function registerRoutes(app: Router) {\n  app.get(\"/users\", listUsers)\n}\n",
    "src/server.ts": "import { registerRoutes } from \"./router\"\n\nregisterRoutes(createApp())\n",
  };
  for (const [path, content] of Object.entries(files)) await writeFile(join(directory, path), `${content}\n`);
  const git = (...args) => execFileAsync("git", args, { cwd: directory });
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-q", "-m", "Initial commit");
  // The uncommitted change a review helper looks at.
  await writeFile(
    join(directory, "src/router.ts"),
    "import { listUsers } from \"./handlers/users\"\n\nexport function registerRoutes(app: Router, prefix: string) {\n  app.get(`${prefix}/users`, listUsers)\n  app.get(`${prefix}/health`, () => \"ok\")\n}\n"
  );
}

async function until(condition, timeoutMs, what) {
  const startedAt = Date.now();
  while (!(await condition())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await delay(100);
  }
}

// One tab over the DevTools protocol.
async function connect(port) {
  let target;
  await until(async () => {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = targets.find((entry) => entry.type === "page" && !entry.url.startsWith("devtools"));
      return Boolean(target);
    } catch {
      return false;
    }
  }, 30_000, "the debugging port");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done) => socket.addEventListener("open", done, { once: true }));
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed");
    return result.result.value;
  };
  return { send, evaluate };
}

async function scenario(cdp, options, model, child) {
  const { send, evaluate } = cdp;
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(options.out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`shot ${name}`);
  };
  const press = async (key, code, keyCode, modifiers = 0, text) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(type === "keyDown" && text ? { text } : {}) });
  };
  const click = async (selector, index = 0) => {
    const point = await evaluate(`(() => {
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}];
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    if (!point) throw new Error(`Nothing matches ${selector}`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  };
  const text = (value) => evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`);
  const theme = (scheme) =>
    send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });

  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await theme("light");
  // The chat page, as ⌘2 opens it.
  await press("2", "Digit2", 50, 4 /* meta */);
  await until(() => evaluate(`Boolean(document.querySelector("[contenteditable='true']"))`), 20_000, "the chat composer");
  await delay(1200);
  // The first visit offers to set up previews: not for this drive.
  if (await text("Set up previews for")) {
    await evaluate(`[...document.querySelectorAll("button")].find((button) => button.innerText.trim() === "Not now").click()`);
    await delay(800);
  }
  await shot("00-chat-start");

  // A message in ordinary mode first: the engine's footprint with no helper.
  await click("[contenteditable='true']");
  await send("Input.insertText", { text: "Explain this project in two sentences." });
  await delay(200);
  await press("Enter", "Enter", 13, 0, "\r");
  await until(() => text("did this one on my own"), 40_000, "the plain answer");
  await delay(4000);
  const baseline = await footprints(child.pid);
  console.log("engine footprint with no helper (MiB):", JSON.stringify(baseline));

  // The reasoning menu with the toggle.
  // The model picker's group is the popover anchor; its last button is the thinking mode.
  const trigger = `[data-slot="popover-anchor"] button`;
  const buttons = await evaluate(`[...document.querySelectorAll(${JSON.stringify(trigger)})].map((button) => button.innerText.trim() + "|" + (button.getAttribute("aria-label") ?? ""))`);
  console.log("composer buttons:", buttons);
  const variantIndex = buttons.length - 1;
  await click(trigger, variantIndex);
  await delay(500);
  await shot("01-menu-light");
  // Check Ultra mode.
  await click(`[data-slot="checkbox"]`);
  await delay(300);
  await shot("02-menu-checked-light");
  await press("Escape", "Escape", 27);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 300 });
  await delay(600);
  await shot("03-composer-ultra-light");

  // Send a message in ultra mode.
  await click("[contenteditable='true']");
  await send("Input.insertText", { text: "Check how routes are registered in this project, and whether my uncommitted changes break anything." });
  await delay(200);
  await press("Enter", "Enter", 13, 0, "\r");
  await until(() => text("Helper agents"), 40_000, "the helper agents card");
  await delay(2500);
  await shot("04-card-running-light");
  const running = await footprints(child.pid);
  console.log("engine footprint with three helpers running (MiB):", JSON.stringify(running));
  await until(() => text("2 of 3 done") || text("1 of 3 done"), 40_000, "a helper to finish").catch(() => undefined);
  await shot("05-card-partly-done-light");
  await until(() => text("All done"), 60_000, "all helpers to finish");
  await delay(1500);
  await shot("06-card-done-light");
  await delay(3000);
  console.log("engine footprint after the helpers ended (MiB):", JSON.stringify(await footprints(child.pid)));

  // A helper's thread.
  await click(`section[aria-label="Helper agents"] button`, 0);
  await delay(900);
  await shot("07-thread-light");
  await press("Escape", "Escape", 27);
  await delay(500);

  // Dark.
  await theme("dark");
  await delay(900);
  await shot("08-card-done-dark");
  await click(`section[aria-label="Helper agents"] button`, 2);
  await delay(900);
  await shot("09-thread-dark");
  await press("Escape", "Escape", 27);
  await delay(400);
  await click(trigger, variantIndex);
  await delay(500);
  await shot("10-menu-dark");
  await press("Escape", "Escape", 27);
  await delay(300);
  await shot("11-composer-ultra-dark");

  // A narrow window.
  await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 860, deviceScaleFactor: 2, mobile: false });
  await delay(900);
  await shot("12-card-narrow-dark");
  await theme("light");
  await delay(600);
  await shot("13-card-narrow-light");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await delay(600);

  // Ultra off: the agent does it alone, and a call it forces is refused.
  await click(trigger, variantIndex);
  await delay(400);
  await click(`[data-slot="checkbox"]`);
  await delay(300);
  await press("Escape", "Escape", 27);
  await click("[contenteditable='true']");
  await send("Input.insertText", { text: "force helpers: look at routes again" });
  await press("Enter", "Enter", 13, 0, "\r");
  await until(() => text("Did not start"), 40_000, "the refused call");
  await delay(1200);
  await shot("14-refused-light");
  console.log("model requests:", model.requests.length);
}

/** Footprints in MiB, from macOS's `footprint`, of the engine and the harness the app started. */
async function footprints(root) {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,comm="]);
  const processes = stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }));
  const descendants = new Set([root]);
  for (let grown = true; grown; ) {
    grown = false;
    for (const entry of processes)
      if (descendants.has(entry.parent) && !descendants.has(entry.pid)) {
        descendants.add(entry.pid);
        grown = true;
      }
  }
  const result = {};
  for (const entry of processes) {
    const name = ["blame-engine", "blame-harness"].find((candidate) => entry.command.endsWith(`/${candidate}`));
    if (!name || !descendants.has(entry.pid)) continue;
    const { stdout: report } = await execFileAsync("footprint", ["-p", String(entry.pid)]).catch((error) => ({ stdout: String(error.stdout ?? "") }));
    const match = report.match(/Footprint:\s+([\d.]+)\s+(KB|MB|GB)/);
    if (match) result[name] = Math.round(Number(match[1]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 }[match[2]]) * 10) / 10;
  }
  return result;
}

// ------------------------------------------------------------------ electron

async function inElectron() {
  const profile = process.argv.at(-1);
  const { app, BrowserWindow, dialog } = await import("electron");
  for (const name of ["appData", "userData", "sessionData"]) app.setPath(name, profile);
  app.setAppLogsPath(join(profile, "logs"));
  app.getAppPath = () => application;
  app.setAsDefaultProtocolClient = () => false;
  app.commandLine.appendSwitch("remote-debugging-port", process.env.ULTRA_DRIVE_PORT);
  process.env.LIMA_HOME = join(profile, "lima");
  process.env.BLAME_WSL_DISTRO = "BlameUltraDrive";
  const fail = (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    app.exit(1);
  };
  process.once("uncaughtException", fail);
  process.once("unhandledRejection", fail);
  void app.whenReady().then(prepare).catch(fail);

  async function prepare() {
    const project = process.env.ULTRA_DRIVE_PROJECT;
    const window = await windowShowing(BrowserWindow, "");
    await window.webContents.executeJavaScript(`(async () => {
      const session = await window.blame.localApi.session();
      const api = (path, method, body) => fetch(session.url.replace(/\\/$/, "") + path, {
        method,
        headers: { Accept: "application/json", Authorization: "Bearer " + session.token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (response) => {
        if (!response.ok) throw new Error(path + ": " + response.status + " " + await response.text());
      });
      await api("/providers/credentials", "POST", { providerId: "anthropic", apiKey: "sk-ant-mock", baseUrl: ${JSON.stringify(process.env.ULTRA_DRIVE_MODEL_URL)} });
      const model = { providerId: "anthropic", modelId: ${JSON.stringify(process.env.ULTRA_DRIVE_MODEL)}, credentialLabel: null, reasoningEffort: null };
      await api("/account/ai-preferences", "PUT", { agentModel: model, alternativeModel: model });
      localStorage.setItem("blame.app.workspace-start.v1", "local");
      localStorage.setItem("blame.runtime-offer-done.v1", "true");
    })()`);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
    window.webContents.reload();
    const welcome = await windowShowing(BrowserWindow, "Open Project");
    await welcome.webContents.executeJavaScript(`[...document.querySelectorAll("button")]
      .find((button) => button.innerText.startsWith("Open Project")).click()`);
    await windowShowing(BrowserWindow, "Agent Queue");
    console.log("ULTRA_DRIVE_READY");
  }

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

if (process.versions.electron) await inElectron();
else await drive();
