// Drives the built desktop app's orchestrator end to end, in an isolated
// profile, against a scripted model (docs/orchestrator.md), in the real
// engine host with real git and the local API. One command runs every
// scenario, each on its own epic, and prints a line per scenario and a
// final count:
//
// - preview: without a working preview environment Start epic is refused
//   before the goal; once the project has one, the notice goes.
// - models: choose models before launch, revisit the draft and check the
//   first orchestrator turn and the model assigned to its first held story.
// - loop: a goal; two stories, the second after the first; two wakes, two
//   merges into the epic's branch, the summary; the target branch did not
//   move.
// - checks: approving a story whose build check fails is refused by the
//   host, the row says so, changes are requested, it is approved.
// - reply: a plain message that hands the turn back with no card; the
//   statistics panel's Pause and Settings are icon buttons at its top right.
// - ask: a question answered by clicking one of its options.
// - allow: "Ask me before launching": nothing starts before Allow, a Deny
//   is told to the orchestrator, the merge waits for Allow too.
// - pause: Pause all while two stories work; the host pauses them, says the
//   pause took, and it does not read "needs you"; the person talks to the
//   orchestrator meanwhile (its acting call is refused: the epic is paused);
//   Resume resumes exactly those agents; neither wakes the orchestrator.
// - relaunch: a quit and a relaunch while a story works; the orchestrator
//   is woken exactly once.
// - blocked: a story only the person can start (Local Container with no
//   runtime), under Needs you, in the epic switcher, the statistics panel and the wake.
// - conflict: two stories change one line; the second merge is refused by
//   the host and sent back to its agent, which merges the epic's branch in.
//
//   pnpm --filter @blame/desktop exec electron-vite build
//   pnpm --filter @blame/api build
//   BLAME_ENGINE_BIN=… BLAME_HARNESS_BIN=… node scripts/orchestrator-drive.mjs --out /tmp/orchestrator-shots [--only loop,ask] [--keep]
//
// NOT PROOF OF A LOCAL CONTAINER STORY. An epic's stories never run Direct,
// and in a profile without an account they would run in a Local Container,
// which needs the Blame Runtime VM. The drive starts no VM: it tells the
// story service, as a second window would (`storySync` from a window id of
// its own), that this computer runs Cloud Preview stories with a licence.
// Their worktrees are then made on the host, under BLAME_CLOUD_WORKTREE_ROOT
// inside the profile, and no preview, local or managed, is started. What
// this proves is the orchestrator, the screen, the queue and git; a Local
// Container story in an epic (the VM, its worktree, its preview) and a real
// Cloud Preview are not exercised. The blocked scenario asks for Local
// Container with no runtime precisely so that nothing starts.
//
// Nothing may reach the person's screen or keychain. The drive watches the
// on-screen windows (CoreGraphics, no permission needed) and stops the run
// at the first window of the system's security or alert agents, or of the
// app's own process that is not one of its BrowserWindows (an alert, a sheet,
// a native dialog); it checks the app's keychain item was not modified; it
// kills the app on every way out, and the app quits by itself when the drive
// is gone. HOME is left alone (moving it hides the login keychain).
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, realpathSync } from "node:fs";
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

function textOf(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) =>
      typeof block.text === "string"
        ? block.text
        : typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((part) => part.text ?? "").join("")
            : "",
    )
    .join("\n");
}

/** Anthropic's Messages API, answering each request from what it is. */
class ScriptedModel {
  requests = [];
  orchestrators = new Map(); // epic title -> steps
  stories = new Map(); // story title -> steps
  unscripted = [];
  stalled = new Set();

  constructor() {
    this.server = createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        } catch {
          // Not a model request.
        }
        const { who, step } = this.route(body);
        const cwd = who.startsWith("story:") && workspaceOf(body);
        this.requests.push({ who, model: body.model, body, cwd: cwd && existsSync(cwd) ? realpathSync(cwd) : undefined, at: Date.now() });
        void Promise.resolve(typeof step === "function" ? step(body) : step)
          .then((reply) => this.answer(response, reply))
          .catch((error) => {
            this.unscripted.push(`${who}: ${error.message}`);
            this.answer(response, { text: "(error)" });
          });
      });
    });
  }

  route(body) {
    const tools = (body.tools ?? []).map((tool) => tool.name);
    const system =
      typeof body.system === "string"
        ? body.system
        : (body.system ?? []).map((part) => part.text ?? "").join("");
    if (tools.includes("submit_project_code_practices")) {
      const practice = { detected: true, comment: "Starter default." };
      return { who: "practices", step: tool("submit_project_code_practices", {
        projectState: "starter",
        practices: { coding_style: practice, unit_tests: practice, layered_architecture: practice, commit_message_convention: practice },
      }) };
    }
    if (tools.includes("submit_commit_message"))
      return { who: "commit", step: { tool: "submit_commit_message", input: { message: "feat: the story's work" } } };
    if (system.includes("# Blame Orchestrator")) {
      const title = /title: (.*)/.exec(system)?.[1]?.trim() ?? "?";
      const step = this.orchestrators.get(title)?.shift();
      if (step) return { who: `orchestrator:${title}`, step };
      this.unscripted.push(`orchestrator ${title}: ${textOf(body.messages?.at(-1)?.content).slice(0, 200)}`);
      return { who: `orchestrator:${title}`, step: { tool: "end_turn", input: { action: "ask", reason: "Unscripted.", question: "(unscripted)" } } };
    }
    if (tools.includes("finish_task")) {
      const first = textOf(body.messages?.find((message) => message.role === "user")?.content);
      const title = /Backlog item: (.*)/.exec(first)?.[1]?.trim() ?? "?";
      const entry = this.stories.get(title);
      // A function answers every request of the story; a list, one each.
      const step = typeof entry === "function" ? entry : entry?.shift();
      return { who: `story:${title}`, step: step ?? { text: "I stopped there." } };
    }
    return { who: "other", step: { text: "Title" } };
  }

  answer(response, reply) {
    // The request was cut (a pause, a quit): its answer goes nowhere.
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const events = sse(reply);
    if (reply.stall) {
      response.write(events.slice(0, events.indexOf("event: content_block_stop")));
      const close = () => response.destroy();
      this.stalled.add(close);
      response.on("close", () => this.stalled.delete(close));
      return;
    }
    response.end(events);
  }

  // A step that waits for the drive (a story kept working until a check is done).
  gate(name) {
    let open;
    const opened = new Promise((done) => (open = done));
    const gate = { name, open: () => open(), wait: () => opened };
    return gate;
  }

  of(who) {
    return this.requests.filter((request) => request.who === who);
  }

  async start() {
    await new Promise((done) => this.server.listen(0, "127.0.0.1", done));
    this.base = `http://orchestrator-drive.localhost:${this.server.address().port}`;
  }

  close() {
    for (const close of this.stalled) close();
    this.server.closeAllConnections();
    this.server.close();
  }
}

function sse(reply) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const out = [
    event("message_start", {
      type: "message_start",
      message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "scripted", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1 } },
    }),
  ];
  if (reply.tool)
    out.push(
      event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${randomUUID().replaceAll("-", "")}`, name: reply.tool, input: {} } }),
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.input) } }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
    );
  else
    out.push(
      event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text ?? "Thinking about it" } }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
    );
  out.push(
    event("message_delta", { type: "message_delta", delta: { stop_reason: reply.tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 100 } }),
    event("message_stop", { type: "message_stop" }),
  );
  return out.join("");
}

const tool = (name, input) => ({ tool: name, input });
const finish = (summary) => tool("finish_task", { summary });
const write = (path, content) => tool("edit_code", { operations: [{ kind: "patch", path, patch: content }] });
const replace = (path, from, to) =>
  tool("edit_code", { operations: [{ kind: "patch", patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n-${from}\n+${to}\n*** End Patch` }] });
const lastResult = (body) => textOf(body.messages?.at(-1)?.content);

// -------------------------------------------------------------------- driver

async function drive() {
  const options = parseOptions(process.argv.slice(2));
  const scratch = await mkdtemp(join(tmpdir(), "blame-orchestrator-drive-"));
  await mkdir(options.out, { recursive: true });
  const project = join(scratch, "shop");
  await prepareProject(project);
  const model = new ScriptedModel();
  await model.start();
  const debugPort = 9300 + Math.floor(Math.random() * 400);
  const electron = createRequire(import.meta.url)("electron");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_RENDERER_URL;
  delete environment.BLAME_RUNTIME_BIN_DIR;
  Object.assign(environment, {
    DRIVE_MODEL_URL: model.base,
    DRIVE_PROJECT: project,
    DRIVE_PORT: String(debugPort),
    BLAME_ENGINE_LOG: "warn",
  });
  const profile = join(scratch, "profile");
  // Cloud Preview worktrees go inside the profile, never under the person's
  // home folder (HOME itself stays: the app needs its login keychain).
  environment.BLAME_CLOUD_WORKTREE_ROOT = join(profile, "cloud-worktrees");
  environment.DRIVE_PARENT_PID = String(process.pid);
  let app;
  const keychainBefore = keychainItemDate();
  const dialogs = new DialogWatch();
  await dialogs.start(() => {
    console.error(`FAIL a system dialog appeared on screen: ${dialogs.found.join(", ")}; the app is stopped`);
    process.exitCode = 1;
    app?.child.kill("SIGKILL");
  });
  const killApp = () => {
    try {
      app?.child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  };
  process.once("exit", killApp);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.once(signal, () => {
      killApp();
      process.exit(130);
    });
  const deadline = setTimeout(() => {
    console.error("FAIL the drive took longer than 45 minutes");
    killApp();
    process.exit(1);
  }, 45 * 60_000);
  const launch = async (relaunch) => {
    const child = spawn(electron, [fileURLToPath(import.meta.url), profile], {
      env: { ...environment, ...(relaunch ? { DRIVE_RELAUNCH: "1" } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const state = { child, output: "" };
    child.stdout.on("data", (data) => {
      state.output += data;
      dialogs.follow(child.pid, state.output);
    });
    child.stderr.on("data", (data) => (state.output += data));
    await until(() => state.output.includes("DRIVE_READY"), 120_000, "the app to open the project");
    if (dialogs.found.length) throw new Error("A system dialog appeared while the app opened.");
    state.cdp = await connect(debugPort);
    return state;
  };
  const quit = async () => {
    app.cdp.close();
    app.child.kill("SIGTERM");
    await new Promise((done) => (app.child.exitCode !== null ? done() : app.child.once("exit", done)));
  };
  try {
    app = await launch(false);
    const relaunch = async () => {
      await quit();
      app = await launch(true);
      return app.cdp;
    };
    await scenario(app.cdp, options, model, project, relaunch);
    const keychainAfter = keychainItemDate();
    console.log(`${keychainAfter === keychainBefore ? "PASS" : "FAIL"} the app's keychain item was not modified: ${keychainBefore} -> ${keychainAfter}`);
    if (keychainAfter !== keychainBefore) process.exitCode = 1;
    if (options.keep) {
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
    if (model.unscripted.length) console.log("unscripted:", model.unscripted);
    app?.child.kill("SIGTERM");
    await delay(2500);
    killApp();
    model.close();
    if (process.exitCode) console.log(`scratch kept at ${scratch}`);
    else await rm(scratch, { force: true, recursive: true });
    process.exit(process.exitCode ?? 0);
  }
}

function parseOptions(argv) {
  const options = { keep: false, out: resolve("orchestrator-shots"), only: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") options.out = resolve(argv[++index]);
    else if (argv[index] === "--keep") options.keep = true;
    else if (argv[index] === "--only") options.only = new Set(argv[++index].split(","));
  }
  return options;
}

const gitSync = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const git = (cwd, ...args) => execFileAsync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", ...args], { cwd });

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
// or a window of the app's own process that is not one of its BrowserWindows
// (seen twice, at least 80 points tall, so a tooltip is not one).
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
  /** The app's process and its own windows, as its launcher reports them. */
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

// The build check reads a file a story writes: "broken" fails it.
const buildScript = `import { existsSync, readFileSync } from "node:fs";
const state = existsSync("state.txt") ? readFileSync("state.txt", "utf8").trim() : "";
process.exit(state === "broken" ? 1 : 0);
`;

async function prepareProject(directory) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ name: "shop", private: true, type: "module", scripts: { build: "node build.js" } }, null, 2)}\n`);
  await writeFile(join(directory, "build.js"), buildScript);
  await writeFile(join(directory, ".gitignore"), ".blame/\n");
  await writeFile(join(directory, "README.md"), "The shop.\n");
  await git(directory, "init", "-q", "-b", "main");
  await git(directory, "config", "user.name", "Demo");
  await git(directory, "config", "user.email", "demo@example.com");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-q", "-m", "Initial commit");
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

const appPage = (entry) => entry.type === "page" && !entry.url.startsWith("devtools") && !entry.url.includes("window-role=compact");

async function connect(port) {
  let target;
  await until(async () => {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = targets.find(appPage);
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
  return { send, evaluate, close: () => socket.close() };
}

// ------------------------------------------------------------------ scenario

const scenarioNames = ["preview", "models", "loop", "checks", "reply", "ask", "allow", "pause", "relaunch", "blocked", "conflict"];

async function scenario(initial, options, model, projectPath, relaunch) {
  let cdp = initial;
  const checks = [];
  let current = "setup";
  const check = (what, ok, detail = "") => {
    checks.push({ scenario: current, what, ok });
    console.log(`${ok ? "PASS" : "FAIL"} [${current}] ${what}${detail ? `: ${detail}` : ""}`);
    if (!ok) process.exitCode = 1;
  };
  const evaluate = (expression) => cdp.evaluate(expression);
  const send = (method, params) => cdp.send(method, params);
  const shot = async (name, clip) => {
    // One frame for what was just rendered to be painted.
    await evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))`);
    const { data } = await send("Page.captureScreenshot", { format: "png", clip });
    await writeFile(join(options.out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`shot ${join(options.out, `${name}.png`)}`);
  };
  const press = async (key, code, keyCode, modifiers = 0) => {
    const typed = key === "Enter" ? "\r" : undefined;
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(type === "keyDown" && typed ? { text: typed } : {}) });
  };
  const click = async (expression) => {
    const point = await evaluate(`(async () => {
      const element = ${expression};
      if (!element) return null;
      element.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
      await new Promise(done => requestAnimationFrame(() => done()));
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    if (!point) throw new Error(`Nothing matches ${expression}`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  };
  const paneSelector = `document.querySelector('section[aria-label="Conversation with the orchestrator"]')`;
  const boardSelector = `document.querySelector('section[aria-label="The epic\\'s stories"]')`;
  const button = (label, scope = "document") => `[...(${scope}?.querySelectorAll("button") ?? [])].find((b) => b.innerText.trim() === ${JSON.stringify(label)})`;
  const text = () => evaluate(`document.body.innerText`);
  const pane = () => evaluate(`${paneSelector}?.innerText ?? ""`);
  const board = () => evaluate(`${boardSelector}?.innerText ?? ""`);
  const startButton = `document.querySelector('button[aria-label="Start epic"]')`;
  // The statistics panel's icon buttons have no text: they are found by label.
  const pauseButton = `document.querySelector('button[aria-label="Pause all"]')`;
  const resumeButton = `document.querySelector('button[aria-label="Resume all"]')`;
  const editor = `document.querySelector('[data-markdown-editor-input="true"][contenteditable="true"]')`;
  const statsPanel = `document.querySelector('[aria-label="Epic statistics"]')`;
  // Chat folds completed work. Read the decisions after opening the work log.
  const readWork = async () => {
    await evaluate(`[...(${paneSelector}?.querySelectorAll('button[aria-expanded="false"]') ?? [])]
      .filter(b => /^Work (completed|stopped)/.test(b.innerText)).forEach(b => b.click())`);
    await evaluate(`new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))`);
    return pane();
  };
  const switcher = `document.querySelector('button[aria-label^="Switch epic,"]')`;
  const dots = () => evaluate(`${switcher}?.querySelector('[role="img"]')?.getAttribute('aria-label') ?? ""`);
  const api = (path, method = "GET", body) =>
    evaluate(`(async () => {
      const session = await window.blame.localApi.session();
      const response = await fetch(session.url.replace(/\\/$/, "") + ${JSON.stringify(path)}, {
        method: ${JSON.stringify(method)},
        headers: { Accept: "application/json", Authorization: "Bearer " + session.token, "Content-Type": "application/json" },
        ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ""}
      });
      if (!response.ok) throw new Error(${JSON.stringify(path)} + ": " + response.status + " " + await response.text());
      if (response.status === 204) return null;
      const unwrap = (value) => value && typeof value === "object" && "data" in value ? unwrap(value.data) : value;
      const value = unwrap(await response.json());
      const flat = (item) => item?.transformerData?.[0] ?? item;
      return Array.isArray(value) ? value.map(flat) : flat(value);
    })()`);
  const engine = (method, input) => evaluate(`window.blame.engine.call(${JSON.stringify(method)}, ${JSON.stringify(input)})`);
  const offerShown = () => evaluate(`document.body.innerText.includes("Set up previews for")`);
  const dismissPreviewSetup = async (waitMs = 0) => {
    await until(offerShown, waitMs, "the preview setup offer").catch(() => undefined);
    if (!(await offerShown())) return;
    await evaluate(`(() => {
      const dialog = [...document.querySelectorAll("[role=dialog]")].find((element) => element.innerText.includes("Set up previews for"));
      dialog?.querySelector("[role=checkbox], input[type=checkbox]")?.click();
      [...(dialog ?? document).querySelectorAll("button")].find((button) => button.innerText.trim() === "Not now")?.click();
    })()`);
    await until(async () => !(await offerShown()), 5_000, "the preview setup offer to close");
  };
  const state = (epicId) => engine("epicState", { epicId });
  const waitState = (epicId, conversation, timeoutMs = 120_000) =>
    until(async () => (await state(epicId)).conversation === conversation, timeoutMs, `the orchestrator to be ${conversation}`).catch(async (error) => {
      console.log("state:", JSON.stringify(await state(epicId).catch(() => null)));
      console.log("requests:", model.requests.map((request) => request.who).join(" "));
      throw error;
    });
  const epicOf = async (title) => (await api(`/projects/epics?projectId=${project.id}`)).find((item) => item.title === title);
  const storiesOf = async (epicId) => (await api(`/projects/user-stories?projectId=${project.id}&view=summary`)).filter((story) => story.epicId === epicId);
  const working = async (epicId) => (await storiesOf(epicId)).filter((story) => story.status === "in-progress" && story.agentStatus === "Running");
  const wakeRows = (conversation) => (conversation.match(/story updates?|resumed after its pause|Blame was restarted|Nothing of the epic can move/g) ?? []).length;
  const openEpic = async (title) => {
    await press("8", "Digit8", 56, 4);
    await click(switcher);
    const row = `[...document.querySelectorAll('[role="menuitemradio"]')].find(r => r.firstElementChild?.textContent === ${JSON.stringify(title)} || r.textContent.startsWith(${JSON.stringify(title)}))`;
    await until(async () => evaluate(`Boolean(${row})`), 10_000, `${title} in the epic history`);
    await click(row);
    await until(async () => evaluate(`Boolean(${paneSelector}) && ${switcher}?.innerText.trim() === ${JSON.stringify(title)}`), 10_000, `the page of ${title}`);
  };
  const startEpicThroughUi = async (title, goal, configure) => {
    await click(`document.querySelector('a[data-sidebar="menu-button"][href="/orchestrator"]')`);
    await until(async () => evaluate(`Boolean(${switcher})`), 10_000, "the epic switcher");
    if (await evaluate(`Boolean(${paneSelector})`)) {
      await click(switcher);
      await click(`[...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent.trim() === "New epic")`);
    }
    await until(async () => (await text()).includes("What should this epic achieve?"), 15_000, "the New epic page");
    await dismissPreviewSetup();
    await click(editor);
    await send("Input.insertText", { text: `${title}\n${goal}` });
    if (configure) await configure();
    await click(startButton);
    await until(async () => Boolean(await epicOf(title)), 15_000, `the epic ${title}`);
    return epicOf(title);
  };
  // A second window, for the story service (see the header): Cloud Preview,
  // licensed, unless a scenario asks for something else.
  let windowPreferences = { runMode: "vercel-compose", premium: true, runtimePhase: "ready" };
  const cloudWindow = () =>
    engine("storySync", {
      window: "orchestrator-drive",
      projects: [{ id: project.id, path: projectPath }],
      preferences: { agentModel: { providerId: "anthropic", modelId: "claude-sonnet-5-5" }, initializingProjects: [], ...windowPreferences },
    });

  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
  await dismissPreviewSetup();
  const project = (await api("/projects")).find((item) => item.name === "shop");
  check("the project is known to the account", Boolean(project));
  if (!project) throw new Error("The project is missing.");
  const mainBefore = gitSync(projectPath, "rev-parse", "main");
  let keepCloud;

  // Each scenario: its own epic, its own checks; a failure is reported and
  // the next one still runs.
  const scenarios = {
    // A project without a working preview environment, then with one.
    async preview() {
      await press("8", "Digit8", 56, 4);
      await until(async () => (await text()).includes("What should this epic achieve?"), 15_000, "the New epic page");
      await until(async () => (await text()).includes("Set up the preview environment"), 30_000, "the preview environment notice");
      await dismissPreviewSetup(3000);
      const blocked = await evaluate(`(!${startButton} || ${startButton}.disabled) && !${editor}`);
      check("without a working preview environment, Start epic is refused before the goal", blocked && (await text()).includes("An epic needs this project"));
      await shot("01-no-preview-environment");
      await api(`/projects/${project.id}/initialization/start`, "POST", { providerId: "anthropic", modelId: "claude-sonnet-5-5" }).catch(() => undefined);
      await api(`/projects/${project.id}/initialization/complete`, "POST", {
        previewManifest: {
          confidence: "high",
          project: { root: "." },
          setup: [],
          services: [{ id: "web", kind: "preview", container: { image: "node:22-bookworm" }, command: "node server.js", endpoints: [{ id: "http", protocol: "http", port: 3000, healthcheck: { type: "http", path: "/", timeoutMs: 30_000 } }] }],
          caches: [],
          risks: [],
          probes: [],
        },
        runConfigurations: [{ id: "web", name: "Web", command: "node server.js", cwd: ".", default: true, category: "web", services: ["web"], previewService: "web", scopes: ["frontend"] }],
      });
      // What the window does once its analysis completes: it reads the project's environment again.
      await evaluate(`window.dispatchEvent(new CustomEvent("project-initialization:updated", { detail: ${JSON.stringify(project.id)} })); true`);
      await until(async () => (await evaluate(`Boolean(${startButton})`)) && !(await text()).includes("An epic needs this project"), 30_000, "the notice to go");
      check("with a preview environment, the notice goes", true);
      await dismissPreviewSetup(3000);
      await shot("01-new-epic");
      const setupClip = await evaluate(`(() => {
        const frame = document.querySelector('.epic-setup').getBoundingClientRect();
        const heading = document.querySelector('.epic-setup').closest('main').querySelector('h2').getBoundingClientRect();
        const x = Math.max(0, Math.floor(frame.left - 56)), y = Math.max(0, Math.floor(heading.top - 100));
        return { x, y, width: Math.min(innerWidth - x, Math.ceil(frame.width + 112)), height: Math.min(innerHeight - y, Math.ceil(frame.bottom + 48 - y)), scale: 1.5 };
      })()`);
      await shot("01-epic-model-setup", setupClip);
      const clouds = `document.querySelector('.epic-clouds')`;
      const drift = `${clouds}.querySelector('.preview-ambilight-patch')`;
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
      check("the empty composer uses the drifting preview clouds", await evaluate(`getComputedStyle(${drift}).animationName === "preview-ambilight-drift" && getComputedStyle(${drift}).animationPlayState === "running"`));
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
      check("the clouds stay still with reduced motion", await evaluate(`getComputedStyle(${drift}).animationName === "none"`));
      await shot("01-new-epic-light");
      await send("Emulation.setEmulatedMedia", { features: [] });
      await click(editor);
      await send("Input.insertText", { text: "A" });
      await until(() => evaluate(`getComputedStyle(${clouds}).visibility === "hidden"`), 5_000, "the clouds to fade out while drafting");
      await press("Backspace", "Backspace", 8);
      await until(() => evaluate(`${clouds}.dataset.visible === "true"`), 5_000, "the clouds to return to the empty composer");
      await cloudWindow();
      keepCloud = setInterval(() => void cloudWindow().catch(() => undefined), 1500);
    },

    async models() {
      const title = "Choose the export models";
      const goal = "Plan a review of the export format.";
      const preferences = () => api("/account/ai-preferences");
      const accountBefore = (await preferences()).agentModel;
      const fields = `document.querySelector('fieldset[aria-label="Story agents"]')`;
      const provider = button("Anthropic", fields);
      const composer = `document.querySelector('.epic-setup [data-slot="markdown-editor"]')`;
      const picker = `${composer}.querySelector('[aria-label="Orchestrator model"] [data-model-picker]')`;
      const range = `${fields}.querySelector('[aria-label="Models stories may use"]')`;
      const ceiling = `${range}?.querySelector('[data-handle="max"]')`;
      let pickedName, storyName;
      model.orchestrators.set(title, [
        tool("create_stories", { reason: "Prepare a review.", stories: [{ key: "review", title: "Review the export", brief: "Review the export format.", intent: "smarter", hold: true }] }),
        tool("end_turn", { action: "reply", reason: "The review is ready." }),
      ]);
      const epic = await startEpicThroughUi(title, goal, async () => {
        check("the orchestrator model sits beside the Markdown toolbar actions", await evaluate(`(() => {
          const model = ${picker}.getBoundingClientRect();
          const attach = ${composer}.querySelector('button[aria-label="Attach files"]').getBoundingClientRect();
          return model.left > attach.right && Math.abs((model.top + model.height / 2) - (attach.top + attach.height / 2)) <= 1;
        })()`));
        check("the story model and provider controls share the form's right edge", await evaluate(`(() => {
          const form = ${fields}, right = form.getBoundingClientRect().right;
          const controls = form.querySelectorAll('[aria-label="Models stories may use"], [aria-label="Story providers"] button:last-child');
          return controls.length >= 2 && [...controls].every(control => Math.abs(control.getBoundingClientRect().right - right) <= 1);
        })()`));
        await click(provider);
        const currentName = await evaluate(`${picker}.innerText.trim()`);
        const point = await evaluate(`(() => { const r = ${picker}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        for (const deltaY of [90, -90]) {
          await send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY });
          if (await until(() => evaluate(`${picker}.innerText.trim() !== ${JSON.stringify(currentName)}`), 1000, "a model change").then(() => true, () => false)) break;
        }
        pickedName = await evaluate(`${picker}.innerText.trim()`);
        check("the orchestrator picker changes the draft's model", pickedName !== currentName);
        await until(() => evaluate(`Boolean(${ceiling})`), 10_000, "the story model range slider");
        const [cheapest, smartest] = await evaluate(`[...${range}.querySelectorAll('[role="slider"]')].map(thumb => {
          const box = thumb.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2, name: thumb.getAttribute("aria-valuetext") };
        })`);
        storyName = cheapest.name;
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: smartest.x, y: smartest.y, button: "left", buttons: 1, clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cheapest.x, y: cheapest.y, button: "left", buttons: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cheapest.x, y: cheapest.y, button: "left", clickCount: 1 });
        await until(() => evaluate(`${ceiling}.getAttribute("aria-valuetext") === ${JSON.stringify(storyName)}`), 3_000, "the upper handle to reach the cheapest model");
        const picks = await evaluate(`[...${fields}.querySelectorAll("dd")].map(item => item.textContent.trim())`);
        check("dragging the handles together updates all three model previews", picks.length === 3 && picks.every(name => name === storyName));
        await click(`document.querySelector('a[data-sidebar="menu-button"][href="/backlog"]')`);
        await click(`document.querySelector('a[data-sidebar="menu-button"][href="/orchestrator"]')`);
        await until(() => evaluate(`Boolean(${fields}) && ${editor}?.innerText.includes(${JSON.stringify(goal)})`), 10_000, "the goal and its model fields to return");
        check("the draft keeps its orchestrator and story choices when revisited", await evaluate(`${picker}.innerText.trim() === ${JSON.stringify(pickedName)} && ${provider}.getAttribute("aria-pressed") === "true" && ${ceiling}?.getAttribute("aria-valuetext") === ${JSON.stringify(storyName)}`));
        await send("Emulation.setDeviceMetricsOverride", { width: 760, height: 750, deviceScaleFactor: 1, mobile: false });
        check("the model fields fit a narrow window", await evaluate(`${fields}.scrollWidth <= ${fields}.clientWidth`));
        await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
      });
      await waitState(epic.id, "replied");
      const saved = epic.settings;
      const list = await engine("providers", { refresh: false });
      const nameOf = choice => list.all.find(p => p.id === choice?.providerId)?.models[choice?.modelId]?.name;
      check("the first orchestrator turn uses the chosen model", nameOf(saved.orchestratorModel) === pickedName && model.of(`orchestrator:${title}`)[0]?.model === saved.orchestratorModel.modelId);
      const story = (await storiesOf(epic.id))[0];
      check("the first story uses the chosen provider and model range", saved.providers.join() === "anthropic" && story?.requestedModel?.providerId === "anthropic" && nameOf(story.requestedModel) === storyName);
      check("choosing models for the epic preserves the account preference", JSON.stringify((await preferences()).agentModel) === JSON.stringify(accountBefore));
    },

    // A goal, two stories one after the other, two wakes, two merges, the summary.
    async loop() {
      const title = "Orders export as CSV";
      model.stories.set("CSV writer", writeThenFinish("csv.js", "export const csv = (rows) => rows.join('\\n')\n"));
      model.stories.set("Export button", (body) => {
        const cwd = workspaceOf(body);
        if (cwd && existsSync(join(cwd, "button.js"))) return finish("Added button.js.");
        // It starts from what the epic's branch holds: the first story's file.
        return cwd && existsSync(join(cwd, "csv.js")) ? write("button.js", "export const button = 'Export'\n") : { text: "csv.js is missing" };
      });
      model.orchestrators.set(title, [
        { text: "I will write the CSV writer first, then the button that uses it." },
        tool("epic_board", {}),
        tool("create_stories", {
          reason: "The button needs the writer, so it starts after it.",
          stories: [
            { key: "csv", title: "CSV writer", brief: "Create csv.js exporting csv(rows).", intent: "cheaper" },
            { key: "button", title: "Export button", brief: "Create button.js using csv.js.", intent: "balanced", startsAfter: ["csv"] },
          ],
        }),
        tool("end_turn", { action: "wait", reason: "The writer runs; the button waits for it." }),
        (body) => tool("story_report", { storyId: storyNumberIn(body, "csv") }),
        (body) => tool("approve_story", { reason: "Verified, and only csv.js changed.", storyId: storyNumberIn(body, "csv") }),
        tool("end_turn", { action: "wait", reason: "The button can start now." }),
        (body) => tool("approve_story", { reason: "Verified.", storyId: storyNumberIn(body, "button") }),
        tool("end_turn", { action: "finish", reason: "Both merged.", summary: "The epic's branch has **csv.js** and **button.js**: orders export as CSV from the button." }),
      ]);
      const epic = await startEpicThroughUi(title, "A button on the orders page that downloads them as CSV.");
      await until(async () => (await api(`/projects/epics/${epic.id}`)).engineSessionId, 30_000, "the conversation to be created");
      const created = await api(`/projects/epics/${epic.id}`);
      check("Start epic creates the conversation and the epic's branch", created.branch?.startsWith("epic/") && created.targetBranch === "main", `${created.branch} -> ${created.targetBranch}`);
      await until(async () => (await text()).includes(created.branch), 15_000, "the statistics panel to name the branch").catch(() => undefined);
      check("the statistics panel names the epic's branch", (await text()).includes(created.branch) && !(await text()).includes("Branch created when it starts"));
      await waitState(epic.id, "waiting");
      const launched = `${paneSelector}?.querySelector('ul[aria-label="Created stories"]')`;
      await until(async () => evaluate(`(${launched}?.querySelectorAll("button").length ?? 0) === 2`), 20_000, "both story cards before opening tools");
      check("the agent introduces the stories before the launch cards", await evaluate(`${paneSelector}.innerText.indexOf("I will write the CSV writer first") >= 0 && ${paneSelector}.innerText.indexOf("I will write the CSV writer first") < ${paneSelector}.innerText.indexOf("CSV writer\\nUS-")`));
      await shot("02-loop-waiting");
      await click(`${launched}.querySelector('button')`);
      await until(async () => evaluate(`Boolean(document.querySelector("[data-slot=drawer-content]"))`), 10_000, "the story launched in the conversation");
      await press("Escape", "Escape", 27);
      await until(async () => evaluate(`!document.querySelector("[data-slot=drawer-content]")`), 10_000, "the opened story to close");
      await waitState(epic.id, "finished", 240_000);
      await until(async () => (await pane()).includes("Ready for your review"), 15_000, "the summary");
      await readWork();
      await evaluate(`[...(${paneSelector}?.querySelectorAll('button[aria-expanded="false"]') ?? [])].filter(b => b.innerText.includes("Approved and merged")).forEach(b => b.click())`);
      const conversation = await pane();
      check("each decision shows, with its reason", conversation.includes("Created 2 stories") && (conversation.match(/Approved and merged into epic\//g) ?? []).length === 2 && conversation.includes("Verified, and only csv.js changed."));
      check("the wakes are events, never the person's messages", wakeRows(conversation) === 2 && !conversation.includes("orchestrator_wake"));
      check("the summary shows, with what is left to the person", conversation.includes("before merging into"));
      const finished = await state(epic.id);
      const cost = await evaluate(`(${statsPanel}?.innerText ?? "").match(/\\$\\d+\\.\\d\\d[^\\n]*/)?.[0] ?? ""`);
      check("the statistics panel shows the spend from the host", finished.spend.totalMicroUsd > 0 && /\$\d/.test(cost), `${finished.spend.totalMicroUsd} µ$ / "${cost}"`);
      check("the epic's branch has both merges", gitShow(projectPath, created.branch, "csv.js").includes("csv") && gitShow(projectPath, created.branch, "button.js").includes("Export"));
      check("the target branch did not move", gitSync(projectPath, "rev-parse", "main") === mainBefore);
      const stories = await storiesOf(epic.id);
      // Merging releases the worktree. Check where each agent actually ran.
      const roots = ["story:CSV writer", "story:Export button"].map(who => model.of(who)[0]?.cwd);
      const worktreeRoot = join(realpathSync(projectPath), "..", "profile", "cloud-worktrees");
      check("both stories ran inside the drive's isolated worktree folder", roots.every(root => root && resolve(root).startsWith(worktreeRoot + "/")), roots.join(", "));
      check("both stories are merged", stories.length === 2 && stories.every((story) => story.status === "done"));
      check("the epic switcher shows the finished state", (await dots()).includes("Done"));
      await shot("03-loop-finished");
      await send("Emulation.setDeviceMetricsOverride", { width: 880, height: 720, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
      await shot("03-loop-narrow");
      check("in a narrow window the stats and composer have separate space", await evaluate(`(() => {
        const panel = ${statsPanel}.firstElementChild.getBoundingClientRect();
        const conversation = ${paneSelector}.getBoundingClientRect();
        return panel.height > 0 && panel.bottom <= conversation.top && conversation.height >= 250;
      })()`));
      await send("Emulation.setEmulatedMedia", { features: [] });
      await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
      await click(`${boardSelector}?.querySelector('button[title^="Open US-"]')`);
      await until(async () => evaluate(`Boolean(document.querySelector("[data-slot=drawer-content]"))`), 10_000, "the drawer from a row");
      check("a story in a row opens in the drawer", true);
      await press("Escape", "Escape", 27);
      await until(async () => evaluate(`!document.querySelector("[data-slot=drawer-content]")`), 10_000, "the drawer to close");
    },

    // Approving a story whose check fails is refused; changes are requested.
    async checks() {
      const title = "Fix the state check";
      model.stories.set("Repair state", [
        write("state.txt", "broken\n"),
        tool("run_task", { kind: "project", task: "build" }),
        finish("Wrote state.txt."),
        { text: "I could not fix it." },
        { text: "I could not fix it." },
        { text: "I could not fix it." },
        replace("state.txt", "broken", "fixed"),
        tool("run_task", { kind: "project", task: "build" }),
        finish("The build passes now."),
      ]);
      let refusal = "";
      model.orchestrators.set(title, [
        tool("create_stories", { reason: "One story.", stories: [{ key: "fix", title: "Repair state", brief: "Make `build` pass.", intent: "cheaper" }] }),
        tool("end_turn", { action: "wait", reason: "It works on it." }),
        (body) => tool("approve_story", { reason: "Let us try.", storyId: storyNumberIn(body, "fix") }),
        (body) => {
          refusal = lastResult(body);
          return tool("message_story", { reason: "The build still fails.", storyId: storyNumberIn(body, "fix"), kind: "changes", message: "The build still fails: state.txt must not say broken.", escalate: true });
        },
        tool("end_turn", { action: "wait", reason: "It fixes it." }),
        (body) => tool("approve_story", { reason: "Verified now.", storyId: storyNumberIn(body, "fix") }),
        tool("end_turn", { action: "finish", reason: "Fixed.", summary: "The build passes." }),
      ]);
      const epic = await startEpicThroughUi(title, "Make the build pass.");
      await waitState(epic.id, "finished", 240_000);
      await until(async () => (await pane()).includes("Ready for your review"), 15_000, "the summary");
      const conversation = await readWork();
      check("the host refused to approve a story whose checks failed", refusal.length > 0 && !/"merged":\s*true/.test(refusal), refusal.slice(0, 200));
      check("the row says the approval was refused, with the host's sentence", conversation.includes("Refused:"));
      check("changes were requested, on a smarter model", conversation.includes("Asked for changes on a smarter model"));
      check("the wake told the failing check", /failed its checks/.test(conversation));
      await shot("04-checks-refused");
    },

    // A plain message, then the turn handed back: no card, the composer answers.
    async reply() {
      const title = "Export sketch";
      model.orchestrators.set(title, [
        { text: "I would write the CSV writer first, then the button that uses it. Tell me when to start." },
        tool("end_turn", { action: "reply", reason: "The plan is in my message." }),
      ]);
      const epic = await startEpicThroughUi(title, "Sketch the export feature.");
      await waitState(epic.id, "replied");
      await until(async () => (await pane()).includes("I would write the CSV writer first"), 15_000, "the message");
      check("a reply is the message alone: no card", await evaluate(`!document.querySelector('[aria-label="Reply to the orchestrator"]')`));
      check("the composer is the way to answer", await evaluate(`Boolean(${editor}) && !${editor}.closest('[aria-disabled="true"]')`));
      check("the dot says the epic needs the person", (await dots()).includes("Needs you"));
      check("the statistics panel says it is the person's turn", /Your turn/.test(await evaluate(`${statsPanel}?.innerText ?? ""`)));
      const iconButtons = await evaluate(`(() => {
        const panel = ${statsPanel}.getBoundingClientRect();
        return ["Pause all", "Epic settings"].map((label) => {
          const element = document.querySelector('button[aria-label="' + label + '"]');
          const box = element?.getBoundingClientRect();
          return { label, text: element?.innerText.trim(), width: box && Math.round(box.width), height: box && Math.round(box.height), fromTop: box && Math.round(box.top - panel.top), fromRight: box && Math.round(panel.right - box.right) };
        });
      })()`);
      check(
        "Pause and Settings are icon buttons at the statistics panel's top right",
        iconButtons.every((item) => item.text === "" && item.width === 28 && item.height === 28 && item.fromTop < 24 && item.fromRight < 64) && iconButtons.at(-1).fromRight < 24,
        JSON.stringify(iconButtons),
      );
      await shot("05a-reply");
    },

    // A question answered with one of its options.
    async ask() {
      const title = "Export format";
      let answer = "";
      model.orchestrators.set(title, [
        tool("end_turn", { action: "ask", reason: "The format decides the stories.", question: "Which format should the export use?", options: ["CSV", "Excel"] }),
        (body) => {
          answer = lastResult(body);
          return tool("end_turn", { action: "finish", reason: "Nothing to build yet.", summary: `Noted: ${answer.trim().split("\n").at(-1)}.` });
        },
      ]);
      const epic = await startEpicThroughUi(title, "Choose the export format.");
      await waitState(epic.id, "asking");
      await until(async () => (await pane()).includes("Which format should the export use?"), 15_000, "the question");
      check("Orchestrator uses the same button dimensions as Backlog", await evaluate(`(() => {
        const box = path => document.querySelector('a[data-sidebar="menu-button"][href="/' + path + '"]').getBoundingClientRect();
        return box("orchestrator").height === box("backlog").height && box("orchestrator").width === box("backlog").width;
      })()`));
      check("the dot says the epic needs the person", (await dots()).includes("Needs you"));
      const other = (await api(`/projects/epics?projectId=${project.id}`)).find(item => item.id !== epic.id);
      if (other) await openEpic(other.title);
      await openEpic(title);
      await click(switcher);
      await press("Home", "Home", 36);
      check("the epic menu can be navigated by keyboard", await evaluate(`document.activeElement?.textContent.trim() === "New epic"`));
      await shot("05-epic-history");
      await press("Escape", "Escape", 27);
      await until(async () => evaluate(`!document.querySelector('[role="menu"]')`), 5000, "the epic history to close");
      const replyModifier = process.platform === "darwin" ? 4 : 2;
      await click(`document.querySelector('button[aria-label="Epic settings"]')`);
      await until(async () => evaluate(`Boolean(document.querySelector('[role="dialog"][data-state="open"]'))`), 5000, "epic settings to open");
      await press("Enter", "Enter", 13, replyModifier);
      check("the shortcut leaves a question pending beneath a dialog", (await state(epic.id)).conversation === "asking");
      await press("Escape", "Escape", 27);
      await until(async () => evaluate(`!document.querySelector('[data-slot="dialog-content"]')`), 5000, "epic settings to close");
      await click(button("Write a reply", paneSelector));
      check("Write a reply focuses the existing composer", await evaluate(`document.activeElement?.matches('[data-markdown-editor-input="true"]')`));
      check("the reply options sit just above the composer", await evaluate(`(() => {
        const actions = document.querySelector('[aria-label="Reply to the orchestrator"]').getBoundingClientRect();
        const gap = ${editor}.getBoundingClientRect().top - actions.bottom;
        return gap >= 0 && gap < 110;
      })()`));
      await shot("05-ask");
      await send("Input.insertText", { text: "Add XLSX later." });
      await press("Enter", "Enter", 13, replyModifier);
      await waitState(epic.id, "finished");
      check("the shortcut sends the primary answer once", answer.trim().endsWith("CSV") && model.of(`orchestrator:${title}`).length === 2);
      check("choosing a suggestion preserves a typed draft", await evaluate(`${editor}.textContent.includes("Add XLSX later.")`));
    },

    // "Ask me before launching": nothing starts before Allow; Deny is told.
    async allow() {
      const title = "Orders filter";
      let denied = "";
      model.stories.set("Filter by date", writeThenFinish("filter.js", "export const filter = 'date'\n"));
      const create = tool("create_stories", { reason: "One story is enough.", stories: [{ key: "f", title: "Filter by date", brief: "Create filter.js.", intent: "balanced" }] });
      model.orchestrators.set(title, [
        tool("end_turn", { action: "ask", reason: "Before starting.", question: "Shall I start?", options: ["Yes"] }),
        create,
        (body) => {
          denied = lastResult(body);
          return create;
        },
        tool("end_turn", { action: "wait", reason: "It runs." }),
        (body) => tool("approve_story", { reason: "Verified.", storyId: storyNumberIn(body, "f") }),
        tool("end_turn", { action: "finish", reason: "Merged.", summary: "Orders filter by date." }),
      ]);
      const epic = await startEpicThroughUi(title, "Filter orders by date.");
      await waitState(epic.id, "asking");
      await click(`document.querySelector('button[aria-label="Epic settings"]')`);
      await until(async () => (await text()).includes("Ask me before launching"), 5_000, "the settings");
      await click(`[...document.querySelectorAll('[role=dialog] label')].find((l) => l.innerText.includes("Ask me before launching"))?.querySelector('[role=switch]')`);
      await click(button("Save", `document.querySelector('[role=dialog]')`));
      await until(async () => (await api(`/projects/epics/${epic.id}`)).settings.askBeforeLaunch === true, 10_000, "the setting saved");
      await until(async () => evaluate(`!document.querySelector('[data-slot=dialog-content]')`), 5_000, "the settings to close");
      // The person's own message, typed in the composer.
      await click(`${paneSelector}?.querySelector('[data-markdown-editor-input="true"]')`);
      await send("Input.insertText", { text: "Yes, go ahead." });
      await press("Enter", "Enter", 13);
      const allowButtons = () => evaluate(`[...(${paneSelector}?.querySelectorAll("button") ?? [])].filter((b) => b.innerText.trim() === "Allow" && !b.disabled).length`);
      await until(async () => (await allowButtons()) === 1, 60_000, "a call waiting for Allow");
      check("nothing is created before Allow", (await storiesOf(epic.id)).length === 0);
      check("what will be launched reads before the click", (await pane()).includes("Filter by date") && (await pane()).includes("Balanced"));
      await shot("06-allow-waiting");
      await click(button("Deny", paneSelector));
      await until(async () => (await pane()).includes("You denied it") && (await allowButtons()) === 1, 60_000, "the second call waiting for Allow");
      check("a Deny is told to the orchestrator", /den/i.test(denied), denied.slice(0, 120));
      check("the denied row says so", true);
      await click(button("Allow", paneSelector));
      await until(async () => (await storiesOf(epic.id)).length === 1, 30_000, "the story after Allow");
      check("Allow creates and starts the story", true);
      await until(async () => (await allowButtons()) === 1 && (await pane()).includes("Approve and merge"), 180_000, "the merge waiting for Allow");
      await shot("07-allow-merge");
      check("the merge waits for Allow", (await storiesOf(epic.id))[0]?.status === "in-review");
      await click(button("Allow", paneSelector));
      await waitState(epic.id, "finished", 120_000);
      check("the merge ran once allowed", (await storiesOf(epic.id))[0]?.status === "done");
    },

    // Pause all is the host's: it pauses the working agents and resumes exactly those.
    async pause() {
      const title = "Orders search";
      const gate = model.gate("pause");
      let pausedRefusal = "";
      model.stories.set("Search box", writeThenFinish("search.js", "export const search = true\n", gate));
      model.stories.set("Search results", writeThenFinish("results.js", "export const results = []\n", gate));
      model.orchestrators.set(title, [
        tool("create_stories", { reason: "Two independent pieces.", stories: [
          { key: "box", title: "Search box", brief: "Create search.js.", intent: "cheaper" },
          { key: "results", title: "Search results", brief: "Create results.js.", intent: "cheaper" },
        ] }),
        tool("end_turn", { action: "wait", reason: "Both run." }),
        // The person writes during the pause: acting is refused, waiting is not.
        (body) => tool("message_story", { reason: "The person asked to hurry.", storyId: storyNumberIn(body, "box"), kind: "answer", message: "Please finish soon." }),
        (body) => {
          pausedRefusal = lastResult(body);
          return tool("end_turn", { action: "wait", reason: "The epic is paused; it goes on when resumed." });
        },
        tool("epic_board", {}),
        (body) => tool("approve_story", { reason: "Verified.", storyId: storyNumberIn(body, "box") }),
        (body) => tool("approve_story", { reason: "Verified.", storyId: storyNumberIn(body, "results") }),
        tool("end_turn", { action: "finish", reason: "Done.", summary: "Search box and results." }),
      ]);
      const epic = await startEpicThroughUi(title, "Search the orders.");
      await waitState(epic.id, "waiting");
      await until(async () => (await working(epic.id)).length === 2, 60_000, "both stories to work");
      const atPause = model.of(`orchestrator:${title}`).length;
      await click(pauseButton);
      await until(async () => (await api(`/projects/epics/${epic.id}`)).status === "paused", 15_000, "the epic to be paused");
      await until(async () => (await working(epic.id)).length === 0, 30_000, "the host to pause the agents");
      check("Pause all: the host paused both working agents", (await storiesOf(epic.id)).every((story) => story.agentStatus === "Paused"));
      await until(async () => (await state(epic.id)).pause?.phase === "paused", 30_000, "the host to say the pause took");
      await until(async () => evaluate(`Boolean(${resumeButton})`), 5_000, "Resume all");
      check("the statistics panel says Paused once the pause took", /\bPaused\b/.test(await evaluate(`${statsPanel}?.innerText ?? ""`)));
      check("a pause is not 'needs you'", !(await dots()).includes("Needs you") && !((await state(epic.id)).blocked?.length));
      await shot("08-paused");
      // The person can still talk to the orchestrator.
      const asked = model.of(`orchestrator:${title}`).length;
      await click(`${paneSelector}?.querySelector('[data-markdown-editor-input="true"]')`);
      await send("Input.insertText", { text: "How far are the stories?" });
      await press("Enter", "Enter", 13);
      await until(async () => /paused/i.test(pausedRefusal), 60_000, "the orchestrator's answer during the pause");
      await waitState(epic.id, "waiting");
      check("during the pause the orchestrator answers the person", model.of(`orchestrator:${title}`).length >= asked + 2);
      check("its acting call is refused because the epic is paused, and the row says so", /paused/i.test(pausedRefusal) && /Refused:[^\n]*paused/i.test(await readWork()), pausedRefusal.slice(0, 160));
      check("the statistics panel still says Paused", (await state(epic.id)).pause?.phase === "paused" && (await evaluate(`Boolean(${resumeButton})`)));
      await click(resumeButton);
      await until(async () => (await api(`/projects/epics/${epic.id}`)).status === "active", 15_000, "the epic to resume");
      await until(async () => (await working(epic.id)).length === 2, 60_000, "the host to resume both agents");
      check("Resume: the host resumed exactly the agents it paused", true);
      check("the orchestrator was woken neither by the pause nor by the resume", model.of(`orchestrator:${title}`).length === atPause + 2, `${model.of(`orchestrator:${title}`).length - atPause} requests since the pause, 2 of them the person's`);
      gate.open();
      await waitState(epic.id, "finished", 240_000);
      await until(async () => (await pane()).includes("Ready for your review"), 15_000, "the summary");
      check("one wake after the pause and the resume", wakeRows(await pane()) === 1, `${wakeRows(await pane())} wake rows`);
    },

    // A quit and a relaunch while a story works: the orchestrator is woken once.
    async relaunch() {
      const title = "Orders print";
      const gate = model.gate("relaunch");
      model.stories.set("Print view", writeThenFinish("print.js", "export const print = true\n", gate));
      model.orchestrators.set(title, [
        tool("create_stories", { reason: "One story.", stories: [{ key: "print", title: "Print view", brief: "Create print.js.", intent: "cheaper" }] }),
        tool("end_turn", { action: "wait", reason: "It runs." }),
        (body) => tool("approve_story", { reason: "Verified.", storyId: storyNumberIn(body, "print") }),
        tool("end_turn", { action: "finish", reason: "Done.", summary: "Print view." }),
      ]);
      const epic = await startEpicThroughUi(title, "Print the orders.");
      await waitState(epic.id, "waiting");
      await until(async () => (await working(epic.id)).length === 1, 60_000, "the story to work");
      clearInterval(keepCloud);
      cdp = await relaunch();
      await dismissPreviewSetup(3000);
      await cloudWindow();
      keepCloud = setInterval(() => void cloudWindow().catch(() => undefined), 1500);
      await openEpic(title);
      await until(async () => (await working(epic.id)).length === 1, 90_000, "the story to work again after the relaunch");
      check("the story works again after the relaunch", true);
      gate.open();
      await waitState(epic.id, "finished", 240_000);
      await until(async () => (await pane()).includes("Ready for your review"), 15_000, "the summary");
      check("after the relaunch the orchestrator is woken exactly once", wakeRows(await pane()) === 1, `${wakeRows(await pane())} wake rows`);
      await shot("09-after-relaunch");
    },

    // A story only the person can start: shown under Needs you, in the statistics panel and the wake.
    async blocked() {
      const title = "Orders labels";
      const second = model.gate("blocked");
      const printer = model.gate("printer");
      model.stories.set("Label printer", writeThenFinish("labels.js", "export const labels = true\n", printer));
      model.orchestrators.set(title, [
        tool("create_stories", { reason: "The printer first.", stories: [{ key: "printer", title: "Label printer", brief: "Create labels.js.", intent: "cheaper" }] }),
        async () => {
          // The drive switches this computer to Local Container stories with no runtime.
          await second.wait();
          return tool("create_stories", { reason: "The layout next.", stories: [{ key: "layout", title: "Label layout", brief: "Create layout.js.", intent: "cheaper" }] });
        },
        tool("end_turn", { action: "wait", reason: "The printer runs." }),
        (body) => tool("approve_story", { reason: "Verified.", storyId: storyNumberIn(body, "printer") }),
        tool("end_turn", { action: "ask", reason: "Only the person can start it.", question: "The layout story needs Blame Runtime. Install it, then tell me.", options: ["Done"] }),
      ]);
      const epic = await startEpicThroughUi(title, "Print shipping labels.");
      await until(async () => (await working(epic.id)).length === 1, 60_000, "the printer story to work");
      windowPreferences = { runMode: "local-container", premium: true, runtimePhase: "missing" };
      await cloudWindow();
      second.open();
      await until(async () => (await state(epic.id)).blocked?.length === 1, 90_000, "the host to call the layout story blocked");
      const blocked = (await state(epic.id)).blocked[0];
      check("the host says why only the person can start it", /runtime/i.test(blocked.reason), blocked.reason);
      await until(async () => (await board()).includes(blocked.reason), 15_000, "the Needs you story group");
      check("the statistics panel lists it under Needs you, with the reason", (await board()).includes("Needs you"));
      check("the dot says the epic needs the person", (await dots()).includes("Needs you"));
      await waitState(epic.id, "waiting");
      check("the statistics panel says a story needs the person to start", (await text()).includes("needs you to start"));
      printer.open();
      await waitState(epic.id, "asking", 180_000);
      const conversation = await pane();
      check("the wake names the blocked story", conversation.includes("Only you can start") && conversation.includes(blocked.number));
      await shot("10-blocked");
      windowPreferences = { runMode: "vercel-compose", premium: true, runtimePhase: "ready" };
      await cloudWindow();
      // Dismiss the install offer that covered the sidebar while the runtime was missing.
      const installOffer = `[...document.querySelectorAll('[role="dialog"]')].find(d => d.innerText.includes("Install Blame Runtime"))`;
      if (await evaluate(`Boolean(${installOffer})`)) {
        await click(`(${installOffer}).querySelector('[data-slot="dialog-close"]')`);
        await until(async () => !await evaluate(`Boolean(document.querySelector('[data-slot="dialog-overlay"]'))`), 5_000, "the runtime offer to close");
      }
    },

    // Two stories change the same line: the second merge conflicts, is refused
    // and goes back to its agent, which merges the epic's branch in.
    async conflict() {
      const title = "Orders greeting";
      let branch = "";
      model.stories.set("Greeting A", writeThenFinish("greeting.txt", "hello from A\n"));
      model.stories.set("Greeting B", (body) => {
        const cwd = workspaceOf(body);
        const messages = body.messages ?? [];
        // The turn's own steps: the assistant replies since the last message a person (or the orchestrator) wrote.
        const opened = messages.findLastIndex((message) => message.role === "user" && (typeof message.content === "string" || message.content.some((block) => block.type === "text")));
        const asked = textOf(messages[opened]?.content);
        const step = messages.slice(opened + 1).filter((message) => message.role === "assistant").length;
        if (!asked.includes("git merge")) return cwd && existsSync(join(cwd, "greeting.txt")) ? finish("Wrote greeting.txt.") : write("greeting.txt", "hello from B\n");
        // Asked for changes: bring the epic's branch in, keep both greetings, commit the merge.
        return [
          tool("run_task", { kind: "command", command: `git merge --no-edit ${branch} || true` }),
          tool("run_task", { kind: "command", command: "printf 'hello from A and B\\n' > greeting.txt && git add greeting.txt && git -c user.name=Agent -c user.email=agent@example.com commit --no-edit -m 'Merge the epic branch'" }),
          finish("Merged the epic's branch and kept both greetings in greeting.txt."),
        ][Math.min(step, 2)];
      });
      let refusal = "";
      model.orchestrators.set(title, [
        tool("create_stories", { reason: "Two greetings in parallel.", stories: [
          { key: "a", title: "Greeting A", brief: "Write greeting.txt.", intent: "cheaper" },
          { key: "b", title: "Greeting B", brief: "Write greeting.txt.", intent: "cheaper" },
        ] }),
        tool("end_turn", { action: "wait", reason: "Both run." }),
        (body) => tool("approve_story", { reason: "Verified.", storyId: storyNumberIn(body, "a") }),
        (body) => tool("approve_story", { reason: "Verified.", storyId: storyNumberIn(body, "b") }),
        (body) => {
          refusal = lastResult(body);
          return tool("message_story", { reason: "It conflicts with A.", storyId: storyNumberIn(body, "b"), kind: "changes", message: `Merge ${branch} into your work (git merge ${branch}), resolve greeting.txt to keep both greetings, and pass your checks again.` });
        },
        tool("end_turn", { action: "wait", reason: "B resolves the conflict." }),
        (body) => tool("approve_story", { reason: "Resolved and verified.", storyId: storyNumberIn(body, "b") }),
        tool("end_turn", { action: "finish", reason: "Both merged.", summary: "greeting.txt keeps both greetings." }),
      ]);
      const epic = await startEpicThroughUi(title, "Greet the customers.");
      await until(async () => (await api(`/projects/epics/${epic.id}`)).branch, 30_000, "the epic's branch");
      branch = (await api(`/projects/epics/${epic.id}`)).branch;
      await until(async () => /conflict/i.test(refusal), 180_000, "the conflicting merge to be refused");
      check("the host refused the conflicting merge", /conflict/i.test(refusal), refusal.slice(0, 200));
      await until(async () => (await readWork()).includes("Refused:"), 15_000, "the refusal row");
      check("the refusal row reads the host's first sentence", /Refused: [^\n]+/.test(await pane()));
      await shot("11-conflict-refused");
      await waitState(epic.id, "finished", 300_000);
      check("the second story was merged once its agent resolved the conflict", gitShow(projectPath, branch, "greeting.txt").includes("A and B"));
      check("the target branch did not move", gitSync(projectPath, "rev-parse", "main") === mainBefore);
    },
  };

  const summaries = [];
  try {
    for (const name of scenarioNames) {
      // The preview environment is what every other scenario starts from.
      if (options.only && !options.only.has(name) && name !== "preview") continue;
      current = name;
      const before = checks.length;
      let error;
      try {
        await scenarios[name]();
      } catch (caught) {
        error = caught;
        check("finishes", false, caught instanceof Error ? caught.message : String(caught));
        await shot(`fail-${name}`).catch(() => undefined);
        console.log("page:", (await text().catch(() => "")).replace(/\n+/g, " / ").slice(0, 1500));
      }
      const mine = checks.slice(before);
      const passed = mine.filter((item) => item.ok).length;
      summaries.push({ name, ok: !error && passed === mine.length });
      console.log(`SCENARIO ${name}: ${!error && passed === mine.length ? "PASS" : "FAIL"} (${passed}/${mine.length} checks)`);
      // Without a preview environment no other scenario can run; a system dialog stops everything.
      if ((name === "preview" && error) || watchedDialogs?.found.length) break;
    }
  } finally {
    clearInterval(keepCloud);
  }
  current = "end";
  await evaluate(`document.activeElement?.blur?.(); true`).catch(() => undefined);
  await press("d", "KeyD", 68).catch(() => undefined);
  await shot("12-other-theme").catch(() => undefined);
  const passedScenarios = summaries.filter((item) => item.ok).length;
  console.log(`SUMMARY ${passedScenarios}/${summaries.length} scenarios passed; ${checks.filter((item) => item.ok).length}/${checks.length} checks; ${model.requests.length} model requests`);
}

// The story's worktree, from its system prompt.
function workspaceOf(body) {
  return /cwd: ([^\\\n"]+)/.exec(JSON.stringify(body.system))?.[1];
}

/** A story that writes its file (after the gate opens, if given), then finishes. */
function writeThenFinish(path, content, gate) {
  return async (body) => {
    const cwd = workspaceOf(body);
    if (cwd && existsSync(join(cwd, path))) return finish(`Added ${path}.`);
    if (gate) await gate.wait();
    return write(path, content);
  };
}

/** The number create_stories gave a story, by the drive's key, from what the orchestrator read. */
function storyNumberIn(body, key) {
  for (const message of [...(body.messages ?? [])].reverse())
    for (const json of textOf(message.content).match(/\{"created":\[.*?\]\}/g) ?? []) {
      const found = JSON.parse(json).created.find((item) => item.key === key);
      if (found) return found.number;
    }
  return key;
}

function gitShow(cwd, branch, path) {
  try {
    return gitSync(cwd, "show", `${branch}:${path}`);
  } catch {
    return "";
  }
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
  // Screenshots and DOM assertions still need paint frames when the test window is covered.
  app.on("browser-window-created", (_event, window) => window.webContents.setBackgroundThrottling(false));
  process.env.LIMA_HOME = join(profile, "lima");
  process.env.BLAME_WSL_DISTRO = "BlameOrchestratorDrive";
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
  void app.whenReady().then(prepare).catch(fail);
  // The windows the app made (their CoreGraphics numbers): any other window
  // of this process on screen is a dialog, which the drive stops at.
  void app.whenReady().then(() =>
    setInterval(() => {
      const ids = BrowserWindow.getAllWindows()
        .filter((window) => !window.isDestroyed())
        .map((window) => /^window:(\d+):/.exec(window.getMediaSourceId())?.[1])
        .filter(Boolean);
      console.log(`DRIVE_WINDOWS ${ids.join(",")}`);
    }, 500).unref(),
  );

  async function prepare() {
    if (process.env.DRIVE_RELAUNCH) {
      await windowShowing(BrowserWindow, "Orchestrator");
      console.log("DRIVE_READY");
      return;
    }
    const window = await windowShowing(BrowserWindow, "");
    await window.webContents.executeJavaScript(`(async () => {
      const session = await window.blame.localApi.session();
      const api = (path, method, body) => fetch(session.url.replace(/\\/$/, "") + path, {
        method,
        headers: { Accept: "application/json", Authorization: "Bearer " + session.token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (response) => {
        if (!response.ok) throw new Error(path + ": " + response.status + " " + await response.text());
        return response.json();
      });
      await api("/providers/credentials", "POST", { providerId: "anthropic", apiKey: "sk-ant-mock", baseUrl: ${JSON.stringify(process.env.DRIVE_MODEL_URL)} });
      const model = { providerId: "anthropic", modelId: "claude-sonnet-5-5", credentialLabel: null, reasoningEffort: null };
      await api("/account/ai-preferences", "PUT", { agentModel: model, alternativeModel: model });
      localStorage.setItem("blame.app.workspace-start.v1", "local");
      localStorage.setItem("blame.agent-import-done.v1", "true");
      localStorage.setItem("blame.runtime-offer-done.v1", "true");
      localStorage.setItem("blame.runtime-preference.v1", JSON.stringify({ profile: "direct", source: "account-default" }));
    })()`);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.env.DRIVE_PROJECT] });
    window.webContents.reload();
    const welcome = await windowShowing(BrowserWindow, "Open Project");
    await welcome.webContents.executeJavaScript(`[...document.querySelectorAll("button")].find((button) => button.innerText.startsWith("Open Project")).click()`);
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
