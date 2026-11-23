// Drives the built desktop app through the self-repair tools, in an isolated
// profile, against a scripted model: a quick chat where the person says
// their "notes" MCP server does not work. The agent looks (blame_inspect),
// tests the server (blame_repair reconnect_mcp: it fails, command not found),
// replaces it (blame_configure remove_mcp then add_mcp: the drive clicks
// Allow, as the person would), tests it again and hands a step to the person
// (hand_over: the drive clicks the button, which opens Settings → MCP).
//
//   pnpm --filter @blame/desktop exec electron-vite build
//   pnpm --filter @blame/api build
//   BLAME_ENGINE_BIN=… BLAME_HARNESS_BIN=… node scripts/self-repair-drive.mjs --out /tmp/self-repair-shots [--keep]
//
// The app runs with its own profile (and Lima home); the MCP settings file is
// the profile's `mcp-settings.json`, seeded with the broken server. The
// model is an Anthropic-shaped server on a `*.localhost` host that never
// reaches a provider. The script fails if a system dialog appears on screen,
// and the app is killed on every exit path.
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const here = fileURLToPath(new URL(".", import.meta.url));
const application = resolve(here, "..");
const testServer = resolve(application, "../agent-runtime/dist/engine/tools/testing-mcp-server.js");

// ---------------------------------------------------------------- the model

/** What the agent does, step by step: one tool call per reply. */
const steps = [
  { tool: "blame_inspect", input: { area: "overview" } },
  { tool: "blame_inspect", input: { area: "mcp" } },
  { tool: "blame_repair", input: { action: "reconnect_mcp", name: "notes" } },
  { tool: "blame_configure", input: { action: "remove_mcp", name: "notes" } },
  { tool: "blame_configure", input: { action: "add_mcp", name: "notes", command: process.execPath, args: [testServer] } },
  { tool: "blame_repair", input: { action: "reconnect_mcp", name: "notes" } },
  { tool: "blame_repair", input: { action: "hand_over", where: "mcp", why: "check the server in Settings → MCP Servers and add a key if it asks for one" } },
];

function userBlocks(message) {
  return typeof message.content === "string" ? [] : message.content;
}

function decide(body) {
  const names = (body.tools ?? []).map((tool) => tool.name);
  // Titles and other small tasks the app asks of the model.
  if (!names.includes("blame_inspect")) return { wait: 100, usage: [200, 10], pieces: ["Notes server"] };
  const done = (body.messages ?? []).flatMap(userBlocks).filter((block) => block.type === "tool_result").length;
  const step = steps[done];
  if (step) return { wait: 700, usage: [2600, 120], ...step };
  return {
    wait: 400,
    usage: [3200, 160],
    pieces: [
      "The notes server pointed at a program that is not installed on this computer, so it never started. ",
      "I replaced it with a working command and tested it: it connects. Its tools appear in new conversations. ",
      "Open Settings → MCP Servers if you want to check it.",
    ],
  };
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
    requests.push({ tool: plan.tool, tools: (body.tools ?? []).length });
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
  const scratch = await mkdtemp(join(tmpdir(), "blame-self-repair-drive-"));
  await mkdir(options.out, { recursive: true });
  const project = join(scratch, "project");
  await prepareProject(project);
  const profile = join(scratch, "profile");
  await mkdir(profile, { recursive: true });
  // The broken server the person complains about.
  await writeFile(join(profile, "mcp-settings.json"), JSON.stringify({ mcpServers: { notes: { type: "stdio", command: "blame-notes-server-not-installed", args: ["--stdio"] } } }, null, 2));
  const model = await startModel();
  const debugPort = 9300 + Math.floor(Math.random() * 400);
  const electron = createRequire(import.meta.url)("electron");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_RENDERER_URL;
  delete environment.BLAME_RUNTIME_BIN_DIR;
  Object.assign(environment, {
    DRIVE_MODEL_URL: `http://repair-mock.localhost:${model.port}`,
    DRIVE_MODEL: options.model,
    DRIVE_PROJECT: project,
    DRIVE_PORT: String(debugPort),
    BLAME_ENGINE_LOG: "warn",
    // Main and the engine host both read the MCP settings from here.
    BLAME_MCP_SETTINGS_PATH: join(profile, "mcp-settings.json"),
  });
  const child = spawn(electron, [fileURLToPath(import.meta.url), profile], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const stop = () => child.kill("SIGTERM");
  process.once("exit", stop);
  try {
    await until(() => output.includes("DRIVE_READY"), 120_000, "the app to open the project");
    const cdp = await connect(debugPort);
    await scenario(cdp, options, model, profile);
    if (options.keep) {
      console.log(`DRIVE_KEEP port=${debugPort}`);
      await new Promise((done) => process.once("SIGTERM", done));
    }
  } catch (error) {
    console.error(output.slice(-4000));
    console.error(error);
    process.exitCode = 1;
  } finally {
    child.kill("SIGTERM");
    await delay(1500);
    child.kill("SIGKILL");
    model.close();
    await rm(scratch, { force: true, recursive: true });
    process.exit(process.exitCode ?? 0);
  }
}

function parseOptions(argv) {
  const options = { keep: false, model: "claude-sonnet-5-5", out: resolve("self-repair-shots") };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") options.out = resolve(argv[++index]);
    else if (argv[index] === "--model") options.model = argv[++index];
    else if (argv[index] === "--keep") options.keep = true;
  }
  return options;
}

async function prepareProject(directory) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "repair-demo", version: "1.0.0", type: "module" }, null, 2) + "\n");
  const git = (...args) => execFileAsync("git", args, { cwd: directory });
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-q", "-m", "Initial commit");
}

/** Fails when a macOS system dialog is on screen (CDP cannot see those). */
async function assertNoSystemDialog() {
  if (process.platform !== "darwin") return;
  const script = 'ObjC.import("CoreGraphics"); ObjC.unwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0))).map(w => ObjC.unwrap(w.kCGWindowOwnerName)).join("|")';
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script]).catch(() => ({ stdout: "" }));
  const bad = stdout.split("|").filter((owner) => /SecurityAgent|UserNotificationCenter|coreauthd/i.test(owner));
  if (bad.length) throw new Error(`A system dialog is on screen: ${bad.join(", ")}`);
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

async function scenario(cdp, options, model, profile) {
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
  const clickAt = async (point) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  };
  const click = async (selector, index = 0) => {
    const point = await evaluate(`(() => {
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}];
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    if (!point) throw new Error(`Nothing matches ${selector}`);
    await clickAt(point);
  };
  const clickButton = async (label) => {
    const point = await evaluate(`(() => {
      const element = [...document.querySelectorAll("button")].find((button) => button.innerText.trim().startsWith(${JSON.stringify(label)}));
      if (!element) return null;
      element.scrollIntoView({ block: "center" });
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    if (!point) throw new Error(`No button "${label}"`);
    await clickAt(point);
  };
  const text = (value) => evaluate(`document.body.innerText.replace(/\\s+/g, " ").includes(${JSON.stringify(value)})`);
  const settingsFile = async () => JSON.parse(await readFile(join(profile, "mcp-settings.json"), "utf8"));

  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await press("2", "Digit2", 50, 4 /* meta */);
  await until(() => evaluate(`Boolean(document.querySelector("[contenteditable='true']"))`), 20_000, "the chat composer");
  await delay(1200);
  if (await text("Set up previews for")) {
    await evaluate(`[...document.querySelectorAll("button")].find((button) => button.innerText.trim() === "Not now").click()`);
    await delay(800);
  }
  assert((await settingsFile()).mcpServers.notes.command === "blame-notes-server-not-installed", "the broken server is seeded");

  await click("[contenteditable='true']");
  await send("Input.insertText", { text: "My notes MCP server does not work. Can you fix it?" });
  await delay(200);
  await press("Enter", "Enter", 13, 0, "\r");

  // The agent looks, tests, then asks to remove the broken server: the person allows.
  await until(() => text("Allow"), 60_000, "the first approval (remove_mcp)");
  await delay(600);
  await shot("01-remove-awaiting-approval");
  assert(await text("Removing MCP server") || (await text("Remove")), "the approval names the call");
  await clickButton("Allow");

  // The add: the card shows the exact command it will run.
  await until(async () => (await text("Adding MCP server")) && (await text("Allow")), 60_000, "the second approval (add_mcp)");
  await delay(600);
  const approvalText = await evaluate(`document.body.innerText.replace(/\\s+/g, " ")`);
  assert(approvalText.includes("testing-mcp-server.js"), "the approval shows the command that will run");
  await shot("02-add-awaiting-approval");
  await clickButton("Allow");

  await until(() => text("Settings → MCP Servers if you want"), 90_000, "the final answer");
  await delay(1200);
  // The settings file holds the replacement, and it is the test server.
  const saved = (await settingsFile()).mcpServers.notes;
  assert(saved && saved.command.endsWith("node") && saved.args[0].endsWith("testing-mcp-server.js"), `the file holds the new server: ${JSON.stringify(saved)}`);
  await shot("03-fixed");

  // Open the finished work, then each call's row, to read what it said.
  if (!(await text("Asked you to"))) {
    await clickButton("Work completed");
    await delay(900);
  }
  await evaluate(`[...document.querySelectorAll("button")].filter((button) => /Checked|Reconnected|Removed MCP|Added MCP|Asked you/.test(button.innerText)).forEach((button) => button.click())`);
  await delay(900);
  await shot("04-calls-expanded");

  // The hand-over's button opens Settings on the MCP section.
  await clickButton("Open Settings");
  // The Settings page, on its MCP section.
  await until(() => text("External tools and context for agents"), 20_000, "Settings");
  await delay(900);
  await shot("05-settings-mcp");
  const settingsText = await evaluate(`document.body.innerText.replace(/\\s+/g, " ")`);
  assert(settingsText.includes("notes"), "Settings → MCP lists the replaced server");
  await assertNoSystemDialog();

  // The same, dark.
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await delay(800);
  await shot("06-settings-dark");
  console.log("model requests:", model.requests.map((request) => request.tool ?? "text").join(" → "));
  console.log("tools offered to the lead:", Math.max(...model.requests.map((request) => request.tools)));
}

function assert(condition, message) {
  if (!condition) throw new Error(`Check failed: ${message}`);
}

// ------------------------------------------------------------------ electron

async function inElectron() {
  const profile = process.argv.at(-1);
  const { app, BrowserWindow, dialog } = await import("electron");
  for (const name of ["appData", "userData", "sessionData"]) app.setPath(name, profile);
  app.setAppLogsPath(join(profile, "logs"));
  app.getAppPath = () => application;
  app.setAsDefaultProtocolClient = () => false;
  app.commandLine.appendSwitch("remote-debugging-port", process.env.DRIVE_PORT);
  process.env.LIMA_HOME = join(profile, "lima");
  process.env.BLAME_WSL_DISTRO = "BlameRepairDrive";
  const fail = (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    app.exit(1);
  };
  process.once("uncaughtException", fail);
  process.once("unhandledRejection", fail);
  void app.whenReady().then(prepare).catch(fail);

  async function prepare() {
    const project = process.env.DRIVE_PROJECT;
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
      await api("/providers/credentials", "POST", { providerId: "anthropic", apiKey: "sk-ant-mock", baseUrl: ${JSON.stringify(process.env.DRIVE_MODEL_URL)} });
      const model = { providerId: "anthropic", modelId: ${JSON.stringify(process.env.DRIVE_MODEL)}, credentialLabel: null, reasoningEffort: null };
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
    console.log("DRIVE_READY");
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
