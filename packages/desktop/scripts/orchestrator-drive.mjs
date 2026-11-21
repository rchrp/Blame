// Drives the built desktop app's orchestrator end to end, in an isolated
// profile, against a scripted model (docs/orchestrator.md): the screen with
// no epic, a project without a working preview environment (Start epic is
// refused), then, once the project has one, five epics run one after the
// other in the real engine host, with real git and the local API:
//
// 1. loop: a goal typed on the New epic page; the orchestrator creates two
//    stories (the second after the first), sleeps, is woken, approves the
//    first, the second starts by itself, it is woken again, approves it and
//    finishes. The epic's branch holds both merges, the target branch did
//    not move, and the page shows each decision, the wakes, the spend and
//    the summary.
// 2. checks: a story whose build check fails; approving it is refused by
//    the host and the row says so; changes are requested; it is approved.
// 3. ask: the orchestrator asks; the answer is a click on an option.
// 4. allow: "Ask me before launching": nothing starts before Allow; a Deny
//    is told to the orchestrator; Allow starts the story and its merge.
// 5. pause: Pause all while a story works, Resume; then a quit and a
//    relaunch while a story works: the orchestrator is woken once.
//
//   pnpm --filter @blame/desktop exec electron-vite build
//   pnpm --filter @blame/api build
//   BLAME_ENGINE_BIN=… BLAME_HARNESS_BIN=… node scripts/orchestrator-drive.mjs --out /tmp/orchestrator-shots [--only loop,ask] [--keep]
//
// An epic's stories never run Direct, and in a profile without an account
// they would run in a Local Container, which needs the Blame Runtime VM. The
// drive starts none: it tells the story service, as a second window would,
// that this computer runs Cloud Preview stories with a licence. Their
// worktrees are then made on the host (a Cloud Preview worktree lives
// there, under BLAME_CLOUD_WORKTREE_ROOT inside the profile), and no
// preview is started. Everything else is the app's own path.
//
// Nothing may reach the person's screen or keychain: the drive watches the
// on-screen windows of the system's security and alert agents and stops the
// run at the first one, checks the app's keychain item was not modified,
// and kills the app on every way out (an app whose drive died exits too).
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
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
        this.requests.push({ who, model: body.model, body, at: Date.now() });
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
      const step = this.stories.get(title)?.shift();
      return { who: `story:${title}`, step: step ?? { text: "I stopped there." } };
    }
    return { who: "other", step: { text: "Title" } };
  }

  answer(response, reply) {
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
const later = (ms, reply) => async () => (await delay(ms), reply);
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
    console.error("FAIL the drive took longer than 30 minutes");
    killApp();
    process.exit(1);
  }, 30 * 60_000);
  const launch = async (relaunch) => {
    const child = spawn(electron, [fileURLToPath(import.meta.url), profile], {
      env: { ...environment, ...(relaunch ? { DRIVE_RELAUNCH: "1" } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const state = { child, output: "" };
    child.stdout.on("data", (data) => (state.output += data));
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
    await scenario(app.cdp, options, model, project, relaunch, dialogs);
    const keychainAfter = keychainItemDate();
    console.log(`${keychainAfter === keychainBefore ? "PASS" : "FAIL"} the app's keychain item was not modified: ${keychainBefore} -> ${keychainAfter}`);
    if (keychainAfter !== keychainBefore) process.exitCode = 1;
    if (options.keep) {
      console.log(`DRIVE_KEEP port=${debugPort}`);
      await new Promise((done) => process.once("SIGTERM", done));
    }
  } catch (error) {
    console.error(app?.output?.slice(-6000));
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
  out.push(ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")) + "\\t" + ObjC.unwrap(w.objectForKey("kCGWindowNumber")));
}
out.join("\\n");`;

async function screenWindows() {
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", windowListScript]);
  return stdout.trim().split("\n").map((line) => {
    const [owner, number] = line.split("\t");
    return { owner, number };
  });
}

class DialogWatch {
  found = [];
  async start(onFound) {
    if (process.platform !== "darwin") return;
    // Only windows that were not there before the app.
    const before = new Set((await screenWindows()).map((window) => window.number));
    watchedDialogs = this;
    this.timer = setInterval(async () => {
      const windows = await screenWindows().catch(() => []);
      const dialogs = windows.filter((window) => !before.has(window.number) && dialogOwners.test(window.owner));
      if (!dialogs.length || this.found.length) return;
      this.found = dialogs.map((window) => window.owner);
      onFound();
    }, 1000);
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

async function scenario(initial, options, model, projectPath, relaunch, dialogs) {
  let cdp = initial;
  const checks = [];
  const check = (what, ok, detail = "") => {
    checks.push({ what, ok });
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
    if (!ok) process.exitCode = 1;
  };
  const evaluate = (expression) => cdp.evaluate(expression);
  const send = (method, params) => cdp.send(method, params);
  const shot = async (name) => {
    await delay(600);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(options.out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`shot ${join(options.out, `${name}.png`)}`);
  };
  const press = async (key, code, keyCode, modifiers = 0) => {
    const typed = key === "Enter" ? "\r" : undefined;
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(type === "keyDown" && typed ? { text: typed } : {}) });
  };
  const click = async (expression) => {
    const point = await evaluate(`(() => {
      const element = ${expression};
      if (!element) return null;
      element.scrollIntoView({ block: "center", inline: "center" });
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    if (!point) throw new Error(`Nothing matches ${expression}`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  };
  const button = (label, scope = "document") => `[...${scope}.querySelectorAll("button")].find((b) => b.innerText.trim() === ${JSON.stringify(label)})`;
  const text = () => evaluate(`document.body.innerText`);
  const pane = () => evaluate(`document.querySelector('section[aria-label="Conversation with the orchestrator"]')?.innerText ?? ""`);
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
  const dismissPreviewSetup = async (waitMs = 0) => {
    await until(async () => evaluate(`document.body.innerText.includes("Set up previews for")`), waitMs, "the preview setup offer").catch(() => undefined);
    if (!(await evaluate(`document.body.innerText.includes("Set up previews for")`))) return;
    await evaluate(`(() => {
      const dialog = [...document.querySelectorAll("[role=dialog]")].find((element) => element.innerText.includes("Set up previews for"));
      dialog?.querySelector("[role=checkbox], input[type=checkbox]")?.click();
      [...(dialog ?? document).querySelectorAll("button")].find((button) => button.innerText.trim() === "Not now")?.click();
    })()`);
    await delay(700);
  };
  // The sidebar lists the epics by title.
  const openEpic = async (epicId) => {
    const epic = await api(`/projects/epics/${epicId}`);
    await click(`[...document.querySelectorAll('[data-sidebar=menu-sub] a[href="/orchestrator"]')].find((a) => a.innerText.trim() === ${JSON.stringify(epic.title)})`);
    await delay(500);
  };
  const state = (epicId) => engine("epicState", { epicId });
  const waitState = (epicId, conversation, timeoutMs = 120_000) =>
    until(async () => (await state(epicId)).conversation === conversation, timeoutMs, `the orchestrator to be ${conversation}`).catch(async (error) => {
      console.log("state:", JSON.stringify(await state(epicId)));
      console.log("requests:", model.requests.map((request) => request.who).join(" "));
      await shot(`fail-${conversation}`);
      throw error;
    });
  const storiesOf = async (projectId) => api(`/projects/user-stories?projectId=${projectId}&view=summary`);
  // A second window, for the story service: Cloud Preview, licensed (see the header).
  const cloudWindow = async (project) => {
    const agentModel = { providerId: "anthropic", modelId: "claude-sonnet-5-5" };
    await engine("storySync", {
      window: "orchestrator-drive",
      projects: [{ id: project.id, path: projectPath }],
      preferences: { agentModel, runMode: "vercel-compose", premium: true, runtimePhase: "ready", initializingProjects: [] },
    });
  };

  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
  await dismissPreviewSetup();
  const project = (await api("/projects")).find((item) => item.name === "shop");
  check("the project is known to the account", Boolean(project));

  // ----- A project without a working preview environment.
  await press("8", "Digit8", 56, 4);
  await until(async () => (await text()).includes("What should this epic achieve?"), 15_000, "the New epic page");
  await until(async () => (await text()).includes("Set up the preview environment"), 30_000, "the preview environment notice").catch(() => undefined);
  const blocked = await evaluate(`${button("Start epic")}?.disabled === true && document.querySelector("textarea")?.disabled === true`);
  check("without a working preview environment, Start epic is refused before the goal", blocked && (await text()).includes("An epic needs this project"));
  await shot("01-no-preview-environment");

  // ----- The project gets one, as its analysis would leave it.
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
  await until(async () => !(await evaluate(`${button("Start epic")} === undefined`)) && !(await text()).includes("An epic needs this project"), 30_000, "the notice to go");
  check("with a preview environment, the notice goes", true);
  await dismissPreviewSetup(3000);
  await cloudWindow(project);
  const keepCloud = setInterval(() => void cloudWindow(project).catch(() => undefined), 1500);

  const mainBefore = gitSync(projectPath, "rev-parse", "main");
  const run = (name) => !options.only || options.only.has(name);

  try {
    // ----- 1. The loop.
    if (run("loop")) {
      const title = "Orders export as CSV";
      model.stories.set("CSV writer", [later(4000, write("csv.js", "export const csv = (rows) => rows.join('\\n')\n")), finish("Added csv.js.")]);
      model.stories.set("Export button", [
        (body) => {
          const system = JSON.stringify(body.system);
          const cwd = /cwd: ([^\\\n"]+)/.exec(system)?.[1];
          return cwd && existsSync(join(cwd, "csv.js")) ? write("button.js", "export const button = 'Export'\n") : { text: "csv.js is missing" };
        },
        finish("Added button.js."),
      ]);
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
        tool("story_report", { storyId: "US-001" }),
        tool("approve_story", { reason: "Verified, and only csv.js changed.", storyId: "US-001" }),
        tool("end_turn", { action: "wait", reason: "The button can start now." }),
        tool("approve_story", { reason: "Verified.", storyId: "US-002" }),
        tool("end_turn", { action: "finish", reason: "Both merged.", summary: "The epic's branch has **csv.js** and **button.js**: orders export as CSV from the button." }),
      ]);
      await dismissPreviewSetup();
      await click(`document.querySelector("textarea")`);
      await send("Input.insertText", { text: `${title}\nA button on the orders page that downloads them as CSV.` });
      await click(button("Start epic"));
      const epic = await until(async () => (await api(`/projects/epics?projectId=${project.id}`)).find((item) => item.title === title), 15_000, "the epic").then(async () => (await api(`/projects/epics?projectId=${project.id}`)).find((item) => item.title === title));
      await until(async () => (await api(`/projects/epics/${epic.id}`)).engineSessionId, 30_000, "the conversation to be created");
      const created = await api(`/projects/epics/${epic.id}`);
      check("Start epic creates the conversation and the epic's branch", created.branch?.startsWith("epic/") && created.targetBranch === "main", `${created.branch} -> ${created.targetBranch}`);
      await waitState(epic.id, "waiting");
      await until(async () => (await pane()).includes("Created 2 stories"), 20_000, "the decision row");
      await shot("02-loop-waiting");
      await waitState(epic.id, "finished", 240_000);
      await delay(1500);
      const conversation = await pane();
      check("each decision shows, with its reason", conversation.includes("Created 2 stories") && (conversation.match(/Approved and merged into epic\//g) ?? []).length === 2 && conversation.includes("Verified, and only csv.js changed."), conversation.replace(/\n+/g, " / ").slice(0, 600));
      check("the wakes are events, never the person's messages", (conversation.match(/finished a turn/g) ?? []).length === 2 && !(await evaluate(`[...document.querySelectorAll('section[aria-label="Conversation with the orchestrator"] .bg-primary\\\\/10')].some((e) => e.innerText.includes("orchestrator_wake"))`)));
      check("the summary shows, with what is left to the person", conversation.includes("The orchestrator’s part is done") && conversation.includes("Left to you"));
      const finished = await state(epic.id);
      const header = await evaluate(`document.querySelector('main, body').innerText.match(/\\$\\d+\\.\\d\\d[^\\n]*/)?.[0] ?? ""`);
      check("the header shows the spend from the host", finished.spend.totalMicroUsd > 0 && /\$\d/.test(header), `${finished.spend.totalMicroUsd} µ$ / "${header}"`);
      const branch = created.branch;
      check("the epic's branch has both merges", gitSync(projectPath, "show", `${branch}:csv.js`).includes("csv") && gitSync(projectPath, "show", `${branch}:button.js`).includes("Export"));
      check("the target branch did not move", gitSync(projectPath, "rev-parse", "main") === mainBefore);
      const stories = (await storiesOf(project.id)).filter((story) => story.epicId === epic.id);
      const detail = await api(`/projects/user-stories/${stories[0]?.id}`);
      check("the stories' worktrees were inside the drive's profile, never the person's folders", typeof detail.worktree === "string" && detail.worktree.includes("cloud-worktrees") && !detail.worktree.includes("Library/Application Support/Blame"), detail.worktree);
      check("the second story started after the first's merge", stories.length === 2 && stories.every((story) => story.status === "done"));
      check("the sidebar dot says done", (await evaluate(`[...document.querySelectorAll("[role=img][aria-label]")].map((e) => e.getAttribute("aria-label")).join(",")`)).includes("Done"));
      await shot("03-loop-finished");
      await click(`[...document.querySelectorAll('section[aria-label="Conversation with the orchestrator"] button[title^="Open US-"]')][0]`);
      await until(async () => evaluate(`Boolean(document.querySelector("[data-slot=drawer-content]"))`), 10_000, "the drawer from a row");
      check("a story in a row opens in the drawer", true);
      await press("Escape", "Escape", 27);
      await delay(600);
    }

    // ----- 2. Checks that fail.
    if (run("checks")) {
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
        (body) => tool("approve_story", { reason: "Let us try.", storyId: storyNumberIn(body, "Repair state") }),
        (body) => {
          refusal = lastResult(body);
          return tool("message_story", { reason: "The build still fails.", storyId: storyNumberIn(body, "Repair state"), kind: "changes", message: "The build still fails: state.txt must not say broken.", escalate: true });
        },
        tool("end_turn", { action: "wait", reason: "It fixes it." }),
        (body) => tool("approve_story", { reason: "Verified now.", storyId: storyNumberIn(body, "Repair state") }),
        tool("end_turn", { action: "finish", reason: "Fixed.", summary: "The build passes." }),
      ]);
      const epic = await startEpicThroughUi(title, "Make the build pass.");
      await waitState(epic.id, "finished", 240_000);
      await delay(1500);
      const conversation = await pane();
      check("the host refused to approve a story whose checks failed", /did not end completed/.test(refusal), refusal.slice(0, 200));
      check("the row says the approval was refused, with the host's sentence", conversation.includes("Refused:") && conversation.includes("did not end completed"));
      check("changes were requested, on a smarter model", conversation.includes("Asked for changes on a smarter model"));
      check("the wake told the failing check", /failed its checks/.test(conversation), (conversation.match(/US-\d+[^\n]*failed[^\n]*/) ?? [""])[0]);
      await shot("04-checks-refused");
    }

    // ----- 3. Ask.
    if (run("ask")) {
      const title = "Export format";
      let answer = "";
      model.orchestrators.set(title, [
        tool("end_turn", { action: "ask", reason: "The format decides the stories.", question: "Which format should the export use?", options: ["CSV", "Excel"] }),
        (body) => {
          answer = lastResult(body);
          return tool("end_turn", { action: "finish", reason: "Nothing to build yet.", summary: `Noted: ${answer.trim()}.` });
        },
      ]);
      const epic = await startEpicThroughUi(title, "Choose the export format.");
      await waitState(epic.id, "asking");
      await until(async () => (await pane()).includes("Which format should the export use?"), 15_000, "the question");
      check("the dot says the epic needs the person", (await evaluate(`[...document.querySelectorAll("[role=img][aria-label]")].map((e) => e.getAttribute("aria-label")).join(",")`)).includes("Needs you"));
      await shot("05-ask");
      await click(button("CSV", `document.querySelector('section[aria-label="Conversation with the orchestrator"]')`));
      await waitState(epic.id, "finished");
      check("the answer is the person's message, and restarts the turn", answer.includes("CSV"), JSON.stringify(answer.slice(0, 80)));
    }

    // ----- 4. Ask before launching.
    if (run("allow")) {
      const title = "Orders filter";
      let denied = "";
      model.stories.set("Filter by date", [write("filter.js", "export const filter = 'date'\n"), finish("Added filter.js.")]);
      const create = tool("create_stories", { reason: "One story is enough.", stories: [{ key: "f", title: "Filter by date", brief: "Create filter.js.", intent: "balanced" }] });
      model.orchestrators.set(title, [
        tool("end_turn", { action: "ask", reason: "Before starting.", question: "Shall I start?", options: ["Yes"] }),
        create,
        (body) => {
          denied = lastResult(body);
          return create;
        },
        tool("end_turn", { action: "wait", reason: "It runs." }),
        (body) => tool("approve_story", { reason: "Verified.", storyId: storyNumberIn(body, "Filter by date") }),
        tool("end_turn", { action: "finish", reason: "Merged.", summary: "Orders filter by date." }),
      ]);
      const epic = await startEpicThroughUi(title, "Filter orders by date.");
      await waitState(epic.id, "asking");
      // "Ask me before launching", from the epic's settings.
      await click(`document.querySelector('button[aria-label="Epic settings"]')`);
      await until(async () => (await text()).includes("Ask me before launching"), 5_000, "the settings");
      await click(`[...document.querySelectorAll('[role=dialog] label')].find((l) => l.innerText.includes("Ask me before launching")).querySelector('[role=switch]')`);
      await click(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === "Save")`);
      await until(async () => (await api(`/projects/epics/${epic.id}`)).settings.askBeforeLaunch === true, 10_000, "the setting saved");
      // The person's own message, typed in the composer.
      await click(`document.querySelector('section[aria-label="Conversation with the orchestrator"] [data-markdown-editor-input="true"]')`);
      await send("Input.insertText", { text: "Yes, go ahead." });
      await press("Enter", "Enter", 13);
      const waitingForAllow = async () => (await pane()).includes("Waiting for you");
      await until(waitingForAllow, 60_000, "a call waiting for Allow");
      const before = (await storiesOf(project.id)).filter((story) => story.epicId === epic.id).length;
      check("nothing is created before Allow", before === 0);
      check("what will be launched reads before the click", (await pane()).includes("Filter by date") && (await pane()).includes("Balanced"));
      await shot("06-allow-waiting");
      await click(button("Deny", `document.querySelector('section[aria-label="Conversation with the orchestrator"]')`));
      await until(waitingForAllow, 60_000, "the second call waiting for Allow");
      check("a Deny is told to the orchestrator", /den/i.test(denied), denied.slice(0, 120));
      check("the denied row says so", (await pane()).includes("You denied it"));
      await click(button("Allow", `document.querySelector('section[aria-label="Conversation with the orchestrator"]')`));
      await until(async () => (await storiesOf(project.id)).some((story) => story.epicId === epic.id), 30_000, "the story after Allow");
      check("Allow creates and starts the story", true);
      await until(waitingForAllow, 180_000, "the approval to merge waiting for Allow");
      await shot("07-allow-merge");
      await click(button("Allow", `document.querySelector('section[aria-label="Conversation with the orchestrator"]')`));
      await waitState(epic.id, "finished", 120_000);
      check("the merge ran once allowed", (await storiesOf(project.id)).find((story) => story.epicId === epic.id)?.status === "done");
    }

    // ----- 5. Pause all, then a quit while a story works.
    if (run("pause")) {
      const title = "Orders search";
      model.stories.set("Search box", [later(9000, write("search.js", "export const search = true\n")), finish("Added search.js.")]);
      model.stories.set("Search results", [later(12000, write("results.js", "export const results = []\n")), finish("Added results.js.")]);
      model.orchestrators.set(title, [
        tool("create_stories", { reason: "Two independent pieces.", stories: [
          { key: "box", title: "Search box", brief: "Create search.js.", intent: "cheaper" },
          { key: "results", title: "Search results", brief: "Create results.js.", intent: "cheaper" },
        ] }),
        tool("end_turn", { action: "wait", reason: "Both run." }),
        // Whatever wakes it next: it reads the board and finishes the work.
        tool("epic_board", {}),
        (body) => tool("approve_story", { reason: "Verified.", storyId: storyNumberIn(body, "Search box") }),
        (body) => tool("approve_story", { reason: "Verified.", storyId: storyNumberIn(body, "Search results") }),
        tool("end_turn", { action: "finish", reason: "Done.", summary: "Search box and results." }),
      ]);
      const epic = await startEpicThroughUi(title, "Search the orders.");
      await waitState(epic.id, "waiting");
      const working = async () => (await storiesOf(project.id)).filter((story) => story.epicId === epic.id && story.agentStatus === "Running");
      await until(async () => (await working()).length > 0, 60_000, "a story to work");
      await click(button("Pause all"));
      await until(async () => (await api(`/projects/epics/${epic.id}`)).status === "paused", 15_000, "the epic to be paused");
      await until(async () => (await working()).length === 0, 30_000, "the agents to pause");
      check("Pause all pauses the epic and its working agents", true);
      await shot("08-paused");
      await click(button("Resume"));
      await until(async () => (await api(`/projects/epics/${epic.id}`)).status === "active", 15_000, "the epic to resume");
      check("Resume sets the epic active", true);
      // Resume the stories by hand (the engine's next round does it for Resume).
      for (const story of (await storiesOf(project.id)).filter((item) => item.epicId === epic.id && item.status === "in-progress"))
        await engine("storyResume", { storyId: story.id }).catch(() => undefined);
      await until(async () => (await working()).length > 0, 60_000, "a story to work again");
      const wakesBefore = model.of(`orchestrator:${title}`).length;
      cdp = await relaunch();
      await dismissPreviewSetup();
      await cloudWindow(project);
      await press("8", "Digit8", 56, 4);
      await openEpic(epic.id);
      await waitState(epic.id, "finished", 240_000).catch(async (error) => {
        console.log("pane:", (await pane()).slice(-1500));
        throw error;
      });
      await delay(1500);
      const conversation = await pane();
      const wakeRows = (conversation.match(/finished a turn|Blame stopped while/g) ?? []).length;
      check("after the relaunch the orchestrator is woken once", wakeRows === 1, `${wakeRows} wake rows; ${model.of(`orchestrator:${title}`).length - wakesBefore} orchestrator requests after the quit`);
      await shot("09-after-relaunch");
    }
  } catch (error) {
    await shot("fail-last").catch(() => undefined);
    console.log("page:", (await text().catch(() => "")).replace(/\n+/g, " / ").slice(0, 2500));
    throw error;
  } finally {
    clearInterval(keepCloud);
  }

  // The page as it ends, in the other theme.
  await evaluate(`document.activeElement?.blur?.(); true`);
  await press("d", "KeyD", 68);
  await delay(800);
  await shot("10-other-theme");
  console.log(`model requests: ${model.requests.length}; checks: ${checks.filter((item) => item.ok).length}/${checks.length}`);

  async function startEpicThroughUi(title, goal) {
    await press("8", "Digit8", 56, 4);
    await click(button("New epic"));
    await until(async () => (await text()).includes("What should this epic achieve?"), 15_000, "the New epic page");
    await dismissPreviewSetup();
    await click(`document.querySelector("textarea")`);
    await send("Input.insertText", { text: `${title}\n${goal}` });
    await click(button("Start epic"));
    await until(async () => (await api(`/projects/epics?projectId=${project.id}`)).some((item) => item.title === title), 15_000, `the epic ${title}`);
    return (await api(`/projects/epics?projectId=${project.id}`)).find((item) => item.title === title);
  }
}

// The number create_stories gave a story, from what the orchestrator read
// (its answer names each story by the drive's key).
const storyKeys = { "Repair state": "fix", "Filter by date": "f", "Search box": "box", "Search results": "results" };
function storyNumberIn(body, title) {
  for (const message of [...(body.messages ?? [])].reverse())
    for (const json of textOf(message.content).match(/\{"created":\[.*?\]\}/g) ?? []) {
      const found = JSON.parse(json).created.find((item) => item.key === storyKeys[title]);
      if (found) return found.number;
    }
  return title;
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
