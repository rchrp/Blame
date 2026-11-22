// Drives the built desktop app through the story service of the engine host,
// in an isolated profile, against a scripted model: five queued stories in two
// projects (one of them not shown) start at once, go to review, one takes a
// follow-up from its drawer, a worktree story is approved and merged from
// the board, stories are discarded and sent back, a discarded story is
// deleted from its card, and a second window on the other project queues a
// story there (while it loads and reloads, the first window's projects keep
// starting stories), then closes while that project's stories keep running. With
// --dependencies (an API with startsAfter and requestedModel): a story's drawer
// says it starts after another (its "Starts after" field, with the API's
// message when it refuses a choice), the story waits in Agent Queue, says why
// on its card and in its drawer, and starts once the other is done, told what
// that story delivered; one whose dependency is discarded never starts until
// the drawer's field drops it; one runs on its requested model.
// --dependencies-only runs just that part. It prints each check and takes
// screenshots.
//
//   pnpm --filter @blame/desktop exec electron-vite build
//   pnpm --filter @blame/api build
//   BLAME_ENGINE_BIN=… BLAME_HARNESS_BIN=… node scripts/story-service-drive.mjs --out /tmp/story-shots [--keep]
//
// Stories run Direct (no runtime VM). The merged story's worktree is made
// here on this computer and recorded as a Cloud Preview worktree, which lives
// on the host: the merge, its git flow and its cleanup are the real ones.
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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

function userText(message) {
  if (!message) return "";
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
  const tools = (body.tools ?? []).map((tool) => tool.name);
  const first = userText(messages.find((message) => message.role === "user"));
  const story = /Backlog item: (.*)/.exec(first)?.[1]?.trim();
  if (tools.includes("finish_task")) {
    const last = userText(messages.findLast((message) => message.role === "user"));
    const followUp = messages.filter((message) => message.role === "user" && userText(message).trim()).length > 1;
    return {
      story,
      wait: followUp ? 2500 : 9000,
      tool: "finish_task",
      input: { summary: followUp ? `Followed up on: ${last.slice(0, 80)}` : `Done: ${story ?? "the story"}.` },
    };
  }
  // Approve & Merge analyses the project's code practices first, when it never was.
  if (tools.includes("submit_project_code_practices")) {
    const practice = { detected: true, comment: "The project's samples follow it." };
    return {
      wait: 300,
      tool: "submit_project_code_practices",
      input: { projectState: "starter", practices: { coding_style: practice, unit_tests: practice, layered_architecture: practice, commit_message_convention: practice } },
    };
  }
  if (tools.includes("submit_commit_message"))
    return { wait: 300, tool: "submit_commit_message", input: { message: "Add the merged story's page" } };
  return { wait: 100, pieces: ["Story"] };
}

function sseOf({ pieces, tool, input }) {
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const out = [
    event("message_start", {
      type: "message_start",
      message: { id: "msg_mock", type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1 } },
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
    event("message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } }),
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
    const lastUser = userText((body.messages ?? []).findLast?.((message) => message.role === "user"));
    const users = (body.messages ?? []).filter?.((message) => message.role === "user") ?? [];
    requests.push({ story: plan.story, tool: plan.tool, lastUser, model: body.model, first: users.length === 1, firstUser: userText(users[0]), at: Date.now() });
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
  const scratch = await mkdtemp(join(tmpdir(), "blame-story-drive-"));
  await mkdir(options.out, { recursive: true });
  const shown = join(scratch, "shown-project");
  const hidden = join(scratch, "hidden-project");
  const worktree = join(scratch, "worktrees", "merge-story");
  await prepareProject(shown, "Shown shop");
  await prepareProject(hidden, "Hidden shop");
  await prepareWorktree(shown, worktree);
  const model = await startModel();
  const debugPort = 9300 + Math.floor(Math.random() * 400);
  const electron = createRequire(import.meta.url)("electron");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_RENDERER_URL;
  delete environment.BLAME_RUNTIME_BIN_DIR;
  Object.assign(environment, {
    STORY_DRIVE_MODEL_URL: `http://story-mock.localhost:${model.port}`,
    STORY_DRIVE_SHOWN: shown,
    STORY_DRIVE_HIDDEN: hidden,
    STORY_DRIVE_PORT: String(debugPort),
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
    await until(() => output.includes("STORY_DRIVE_READY"), 120_000, "the app to open the project");
    const cdp = await connect(debugPort);
    await scenario(cdp, options, model, { shown, hidden, worktree });
    if (options.keep) {
      console.log(`STORY_DRIVE_KEEP port=${debugPort}`);
      await new Promise((done) => process.once("SIGTERM", done));
    }
  } catch (error) {
    console.error(output.slice(-6000));
    console.error(error);
    process.exitCode = 1;
  } finally {
    child.kill("SIGTERM");
    await delay(2000);
    model.close();
    if (process.exitCode) console.log(`scratch kept at ${scratch}`);
    else await rm(scratch, { force: true, recursive: true });
    process.exit(process.exitCode ?? 0);
  }
}

function parseOptions(argv) {
  const options = { keep: false, dependencies: false, dependenciesOnly: false, out: resolve("story-shots") };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") options.out = resolve(argv[++index]);
    else if (argv[index] === "--keep") options.keep = true;
    // Needs an API with startsAfter and requestedModel on stories.
    else if (argv[index] === "--dependencies") options.dependencies = true;
    else if (argv[index] === "--dependencies-only") options.dependencies = options.dependenciesOnly = true;
  }
  return options;
}

const git = (cwd, ...args) => execFileAsync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", ...args], { cwd });

async function prepareProject(directory, name) {
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ name: name.toLowerCase().replace(/\s+/g, "-"), version: "1.0.0", type: "module" }, null, 2)}\n`);
  await writeFile(join(directory, "src/index.js"), `export const shop = ${JSON.stringify(name)}\n`);
  await git(directory, "init", "-q", "-b", "main");
  await git(directory, "config", "user.name", "Demo");
  await git(directory, "config", "user.email", "demo@example.com");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-q", "-m", "Initial commit");
}

// A story's worktree with its work committed on its branch, as an agent leaves it.
async function prepareWorktree(project, worktree) {
  await mkdir(join(worktree, ".."), { recursive: true });
  await git(project, "worktree", "add", "-q", "-b", "story/merge-story", worktree, "main");
  await writeFile(join(worktree, "src/about.js"), "export const about = \"Our shop\"\n");
  await git(worktree, "add", "-A");
  await git(worktree, "commit", "-q", "-m", "Add the about page");
}

async function until(condition, timeoutMs, what) {
  const startedAt = Date.now();
  while (!(await condition())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await delay(150);
  }
}

// One tab over the DevTools protocol: the workspace window, not the compact one.
const appPage = (entry) => entry.type === "page" && !entry.url.startsWith("devtools") && !entry.url.includes("window-role=compact");

async function connect(port, pick = appPage) {
  let target;
  await until(async () => {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = targets.find(pick);
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
  return { send, evaluate, port, target };
}

async function scenario(cdp, options, model, paths) {
  const { send, evaluate } = cdp;
  const checks = [];
  const check = (what, ok, detail = "") => {
    checks.push({ what, ok });
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
    if (!ok) process.exitCode = 1;
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(options.out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`shot ${name}`);
  };
  const press = async (key, code, keyCode, modifiers = 0, text) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(type === "keyDown" && text ? { text } : {}) });
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
  // The local API, as the window has it.
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
      const json = await response.json();
      const unwrap = (value) => value && typeof value === "object" && "data" in value ? unwrap(value.data) : value;
      return unwrap(json);
    })()`);
  const stories = async (projectId) => {
    const list = await api(`/projects/user-stories?projectId=${projectId}&view=summary`);
    return (Array.isArray(list) ? list : []).map((item) => item.transformerData?.[0] ?? item);
  };

  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
  const projects = ((await api("/projects")) ?? []).map((item) => item.transformerData?.[0] ?? item);
  console.log("projects:", projects.map((project) => project.name).join(", "));
  const shownProject = projects.find((project) => project.name === "shown-project");
  const hiddenProject = projects.find((project) => project.name === "hidden-project");
  check("both projects are known to the account", Boolean(shownProject && hiddenProject));
  if (!shownProject || !hiddenProject) throw new Error("A project is missing.");
  const shownTitle = await evaluate(`document.body.innerText.includes("Agent Queue")`);
  check("the window shows the board of the shown project", shownTitle);
  // The first visit offers to set up previews: not for this drive, and never again.
  const dismissPreviewSetup = async () => {
    if (!(await evaluate(`document.body.innerText.includes("Set up previews for")`))) return;
    await evaluate(`(() => {
      const dialog = [...document.querySelectorAll("[role=dialog]")].find((element) => element.innerText.includes("Set up previews for"));
      dialog?.querySelector("[role=checkbox], input[type=checkbox]")?.click();
      [...(dialog ?? document).querySelectorAll("button")].find((button) => button.innerText.trim() === "Not now")?.click();
    })()`);
    await delay(700);
  };
  await dismissPreviewSetup();
  if (options.dependenciesOnly) {
    await dependencies();
    console.log(`model requests: ${model.requests.length}; checks: ${checks.filter((item) => item.ok).length}/${checks.length}`);
    return;
  }

  // Five Direct stories queued at once: three in the shown project, two in the other.
  const titles = { shown: ["Checkout page", "Search box", "Cart badge"], hidden: ["Invoice export", "Footer links"] };
  const created = [];
  for (const [project, list] of [[shownProject, titles.shown], [hiddenProject, titles.hidden]])
    for (const title of list)
      created.push(await api("/projects/user-stories", "POST", { projectId: project.id, title, summary: `Build the ${title.toLowerCase()}.`, status: "ready", runMode: "direct" }));
  // What the board does once it created a story: the story service reads its project again.
  await evaluate(`window.blame.engine.call("storyRefresh", {})`);
  const all = async () => [...(await stories(shownProject.id)), ...(await stories(hiddenProject.id))].filter((story) => created.some((item) => item.id === story.id));
  let mostRunning = 0;
  await until(async () => {
    const current = await all();
    const running = current.filter((story) => story.status === "in-progress" && story.agentStatus === "Running").length;
    mostRunning = Math.max(mostRunning, running);
    return running === 5 || current.every((story) => story.status === "in-review");
  }, 90_000, "the five stories to start");
  await delay(1500);
  await shot("01-five-running");
  check("five agents work at the same time (no cap of three)", mostRunning === 5, `${mostRunning} at once`);
  await until(async () => (await all()).every((story) => story.status === "in-review"), 120_000, "the five stories to reach review");
  const reviewed = await all();
  check("every story reached review", reviewed.every((story) => story.status === "in-review" && !story.agentStatus));
  check(
    "the stories of the project no window shows ran too",
    reviewed.filter((story) => story.projectId === hiddenProject.id).every((story) => story.status === "in-review" && story.engineSessionId),
  );
  check("each story counts the turn its model answered", reviewed.every((story) => story.agentModels?.at(-1)?.turns === 1));
  await delay(1200);
  await shot("02-in-review");

  // A follow-up from the drawer of a story in review.
  await dismissPreviewSetup();
  const followed = created[0];
  // Its title is the button that opens its drawer.
  await click(`[...document.querySelectorAll('[data-story-id="${followed.id}"] [data-slot="card-title"] button, [data-story-id="${followed.id}"] button')].find((button) => button.innerText.trim() === ${JSON.stringify(titles.shown[0])})`);
  await until(() => evaluate(`Boolean([...document.querySelectorAll("[contenteditable='true']")].at(-1))`), 20_000, "the drawer");
  await delay(1500);
  await click(`[...document.querySelectorAll("[contenteditable='true']")].at(-1)`);
  await send("Input.insertText", { text: "Make the checkout button blue." });
  await delay(300);
  await shot("03-follow-up-typed");
  await press("Enter", "Enter", 13, 0, "\r");
  await until(async () => (await stories(shownProject.id)).some((story) => story.id === followed.id && story.status === "in-progress" && story.agentStatus === "Running"), 20_000, "the follow-up to start").catch(() => undefined);
  await shot("04-follow-up-running");
  await until(async () => model.requests.some((request) => request.lastUser.includes("Make the checkout button blue.")), 30_000, "the follow-up to reach the agent");
  check("the follow-up reached the story's agent", true);
  await until(async () => (await stories(shownProject.id)).some((story) => story.id === followed.id && story.status === "in-review" && story.agentModels?.at(-1)?.turns === 2), 60_000, "the follow-up to settle");
  check("the follow-up settled the story back in review", true);
  await press("Escape", "Escape", 27);
  await delay(800);

  // Approve & Merge of a worktree story, from its card.
  const merging = await api("/projects/user-stories", "POST", {
    projectId: shownProject.id,
    title: "About page",
    summary: "Add an about page.",
    status: "in-review",
    worktree: paths.worktree,
    branch: "story/merge-story",
    targetBranch: "main",
    workspaceMode: "cloud-mirror",
  });
  await evaluate(`window.location.reload()`);
  await until(() => evaluate(`Boolean(document.querySelector('[data-story-id="${merging.id}"]'))`), 40_000, "the merge story's card");
  await delay(2000);
  await dismissPreviewSetup();
  const cardButtons = await evaluate(`[...document.querySelectorAll('[data-story-id="${merging.id}"] button')].map((button) => button.innerText.trim() || button.getAttribute("aria-label") || "?")`);
  console.log("merge story's card buttons:", JSON.stringify(cardButtons));
  // The menu's own button: Approve & Merge on this computer, without push.
  await click(`[...document.querySelectorAll('[data-story-id="${merging.id}"] button')].find((button) => button.innerText.trim() === "Approve & Merge")`);
  await until(async () => (await stories(shownProject.id)).some((story) => story.id === merging.id && story.status === "done"), 90_000, "the merge").catch(async (error) => {
    await shot("05-merge-timed-out");
    const left = (await stories(shownProject.id)).find((story) => story.id === merging.id);
    console.log("merge story:", JSON.stringify({ status: left?.status, agentStatus: left?.agentStatus, agentLastError: left?.agentLastError }));
    console.log("toasts:", JSON.stringify(await evaluate(`[...document.querySelectorAll("[data-sonner-toast]")].map((toast) => toast.innerText.slice(0, 400))`)));
    throw error;
  });
  await delay(800);
  await shot("05-merged");
  const { stdout: log } = await execFileAsync("git", ["log", "--oneline", "main"], { cwd: paths.shown });
  check("the story's commit is on the target branch", log.includes("Add the about page"), log.trim().split("\n")[0]);
  const done = (await stories(shownProject.id)).find((story) => story.id === merging.id);
  check("the merged story is done with its merge commit", done?.status === "done" && Boolean(done.mergeCommit) && !done.worktree);
  await until(async () => !(await stat(paths.worktree).then(() => true, () => false)), 30_000, "the worktree to be removed").catch(() => undefined);
  check("the merged story's worktree is removed", !(await stat(paths.worktree).then(() => true, () => false)));

  // Discard and back to the backlog go through the story service too.
  await evaluate(`window.blame.engine.call("storyDiscard", { storyId: ${JSON.stringify(created[4].id)}, reason: "Not needed" })`);
  await evaluate(`window.blame.engine.call("storyToBacklog", { storyId: ${JSON.stringify(created[3].id)} })`);
  const hiddenNow = await stories(hiddenProject.id);
  check("a discarded story is discarded", hiddenNow.find((story) => story.id === created[4].id)?.status === "discarded");
  check("a story sent back is in the backlog", hiddenNow.find((story) => story.id === created[3].id)?.status === "backlog");

  // Delete Permanently from the board: a discarded story of the shown project.
  const deleted = created[1];
  await evaluate(`window.blame.engine.call("storyDiscard", { storyId: ${JSON.stringify(deleted.id)}, reason: "Rejected during review" })`);
  await until(() => evaluate(`document.querySelector('[data-story-id="${deleted.id}"]')?.getAttribute("data-story-state") === "discarded"`), 20_000, "the discarded card");
  await delay(800);
  await click(`[...document.querySelectorAll('[data-story-id="${deleted.id}"] button')].find((button) => button.innerText.trim() === "Delete Permanently" || button.getAttribute("aria-label") === "Delete Permanently")`);
  await until(() => evaluate(`Boolean([...document.querySelectorAll("[role=alertdialog] button")].find((button) => button.innerText.trim() === "Delete Permanently"))`), 10_000, "the delete confirmation");
  await click(`[...document.querySelectorAll("[role=alertdialog] button")].find((button) => button.innerText.trim() === "Delete Permanently")`);
  await until(async () => !(await stories(shownProject.id)).some((story) => story.id === deleted.id), 30_000, "the delete").catch(() => undefined);
  check("a story deleted from its card is gone from the account", !(await stories(shownProject.id)).some((story) => story.id === deleted.id));
  await until(() => evaluate(`!document.querySelector('[data-story-id="${deleted.id}"]')`), 10_000, "the card to leave").catch(() => undefined);
  check("its card left the board", await evaluate(`!document.querySelector('[data-story-id="${deleted.id}"]')`));
  await shot("06-after-delete");

  // A second window, on the other project: its stories run from there, and
  // keep running once it is closed. It lists only its own project (the
  // first window lists both): while it loads, and when it reloads, the
  // first window's projects keep starting stories.
  const known = new Set(((await (await fetch(`http://127.0.0.1:${cdp.port}/json`)).json())).map((entry) => entry.id));
  const savedProjects = await evaluate(`(() => {
    const saved = localStorage.getItem("blame.app.projects.v1");
    const state = JSON.parse(saved ?? "{}");
    localStorage.setItem("blame.app.projects.v1", JSON.stringify({ ...state, recent: (state.recent ?? []).filter((project) => project.id === ${JSON.stringify(hiddenProject.id)}) }));
    return saved;
  })()`);
  await evaluate(`window.blame.projectWindows.openProject(${JSON.stringify(paths.hidden)})`);
  const other = await connect(cdp.port, (entry) => appPage(entry) && !known.has(entry.id));
  await until(() => other.evaluate(`Boolean(document.body?.innerText.includes("Agent Queue"))`), 60_000, "the second window's board");
  await other.evaluate(`window.location.reload()`).catch(() => undefined);
  await delay(1000);
  await until(() => other.evaluate(`Boolean(document.body?.innerText.includes("Agent Queue"))`), 60_000, "the second window's board after a reload");
  await delay(1500);
  const profile = await api("/projects/user-stories", "POST", { projectId: shownProject.id, title: "Profile page", summary: "Build the profile page.", status: "ready", runMode: "direct" });
  // Straight to the host: the first window does not tell it its projects again.
  await evaluate(`window.blame.engine.call("storyRefresh", { projectId: ${JSON.stringify(shownProject.id)} })`);
  const profileStarted = await until(async () => (await stories(shownProject.id)).some((story) => story.id === profile.id && story.status !== "ready"), 30_000, "the first window's story to start").then(() => true, () => false);
  const profileWait = profileStarted ? "" : JSON.stringify((await evaluate(`window.blame.engine.call("storyQueueState", undefined)`))?.waiting?.find((entry) => entry.storyId === profile.id)?.reason);
  check("a second window that opens and reloads leaves the first window's projects starting stories", profileStarted, profileWait);
  await until(async () => (await stories(shownProject.id)).some((story) => story.id === profile.id && story.status === "in-review"), 60_000, "the first window's story to settle").catch(() => undefined);
  const shipping = await api("/projects/user-stories", "POST", { projectId: hiddenProject.id, title: "Shipping page", summary: "Build the shipping page.", status: "ready", runMode: "direct" });
  await other.evaluate(`window.blame.engine.call("storyRefresh", { projectId: ${JSON.stringify(hiddenProject.id)} })`);
  await until(async () => (await stories(hiddenProject.id)).some((story) => story.id === shipping.id && story.status === "in-review"), 60_000, "the second window's story to reach review");
  check("a story queued from a second window runs and settles", true);
  await fetch(`http://127.0.0.1:${cdp.port}/json/close/${other.target.id}`);
  await delay(1500);
  // The first window's list of projects as it was.
  await evaluate(typeof savedProjects === "string" ? `localStorage.setItem("blame.app.projects.v1", ${JSON.stringify(savedProjects)})` : `localStorage.removeItem("blame.app.projects.v1")`);
  const returns = await api("/projects/user-stories", "POST", { projectId: hiddenProject.id, title: "Returns page", summary: "Build the returns page.", status: "ready", runMode: "direct" });
  await evaluate(`window.blame.engine.call("storyRefresh", {})`);
  await until(async () => (await stories(hiddenProject.id)).some((story) => story.id === returns.id && story.status === "in-review"), 60_000, "a story of the closed window's project to settle");
  check("once that window is closed, its project's stories still start and settle", true);

  if (options.dependencies) await dependencies();

  async function dependencies() {
    const create = (fields) => api("/projects/user-stories", "POST", { projectId: shownProject.id, summary: `Build the ${fields.title.toLowerCase()}.`, runMode: "direct", ...fields });
    const current = async (id) => (await stories(shownProject.id)).find((story) => story.id === id);
    // Stories wait in the backlog while the drawer says what they start after.
    const base = await create({ title: "Base API", status: "backlog" });
    const dropped = await create({ title: "Dropped idea", status: "backlog" });
    const after = await create({ title: "After base", status: "backlog" });
    const orphan = await create({ title: "Orphan", status: "backlog" });
    const ownModel = await create({ title: "Own model", status: "ready", requestedModel: { providerId: "anthropic", modelId: "claude-opus-5-5" } });
    await evaluate(`window.blame.engine.call("storyRefresh", {})`);
    await until(() => evaluate(`Boolean(document.querySelector('[data-story-id="${orphan.id}"]'))`), 30_000, "the new cards").catch(async () => {
      // The board loads a project's stories when it opens: load them again.
      await evaluate(`window.location.reload()`);
      await until(() => evaluate(`Boolean(document.querySelector('[data-story-id="${orphan.id}"]'))`), 40_000, "the new cards after a reload");
      await delay(1500);
      await dismissPreviewSetup();
    });
    // The drawer keeps showing what it showed while it slides away: it is open while it says so.
    const openField = `[...document.querySelectorAll('[data-slot="starts-after-field"]')].find((element) => element.closest('[data-state="open"]'))`;
    const drawerOpen = `Boolean(${openField})`;
    const openDrawer = async (story) => {
      await dismissPreviewSetup();
      await click(`[...document.querySelectorAll('[data-story-id="${story.id}"] button')].find((button) => button.innerText.trim() === ${JSON.stringify(story.title)})`);
      await until(() => evaluate(`${drawerOpen}`), 20_000, `the drawer of ${story.title}`).catch(async (error) => {
        await shot("drawer-failed");
        console.log("dialogs:", JSON.stringify(await evaluate(`[...document.querySelectorAll("[role=dialog]")].map((dialog) => dialog.innerText.slice(0, 300))`)));
        throw error;
      });
      await delay(600);
    };
    const closeDrawer = async () => {
      // The first Escape may close a list that is still open.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await press("Escape", "Escape", 27);
        await delay(800);
        if (await evaluate(`!(${drawerOpen})`)) break;
      }
      await until(() => evaluate(`!(${drawerOpen})`), 10_000, "the drawer to close").catch(async (error) => {
        await shot("drawer-stuck");
        throw error;
      });
      await delay(500);
    };
    const field = () => evaluate(`(${openField})?.innerText ?? ""`);
    // Picks a story in the field's list; the list closes on Escape.
    const pick = async (title) => {
      await click(`(${openField})?.querySelector('button[aria-label="Starts after"]')`);
      await until(() => evaluate(`Boolean(document.querySelector('[data-slot="popover-content"] [cmdk-item]'))`), 10_000, "the stories to pick from");
      await click(`[...document.querySelectorAll('[data-slot="popover-content"] [cmdk-item]')].find((item) => item.innerText.includes(${JSON.stringify(title)}))`);
      await delay(1200);
      await press("Escape", "Escape", 27);
      await delay(400);
    };

    // After base: picked from its drawer, saved through startsAfter.
    await openDrawer(after);
    await pick("Base API");
    await until(async () => ((await current(after.id))?.startsAfter ?? []).includes(base.id), 15_000, "the choice to be saved");
    check("a story's drawer saves the story it starts after", (await current(after.id)).startsAfter.length === 1);
    await until(async () => (await field()).includes("Base API"), 10_000, "the field to name the story");
    check("the field names it by its number and title", /US-\d{3} Base API/.test(await field()), (await field()).replace(/\n/g, " | "));
    await shot("07-starts-after-field");
    await closeDrawer();

    // Base cannot start after "After base": the API refuses a cycle, and the drawer says so.
    await openDrawer(base);
    await pick("After base");
    await until(async () => (await field()).includes("already waits for this story"), 15_000, "the API's message").catch(() => undefined);
    const refused = await field();
    check("a choice the API refuses shows its message next to the field", refused.includes("already waits for this story"), refused.replace(/\n/g, " | "));
    check("the refused choice is not kept", !refused.includes("After base") && ((await current(base.id))?.startsAfter ?? []).length === 0);
    await shot("08-starts-after-refused");
    await closeDrawer();

    // Orphan: its dependency is discarded afterwards.
    await openDrawer(orphan);
    await pick("Dropped idea");
    await until(async () => ((await current(orphan.id))?.startsAfter ?? []).includes(dropped.id), 15_000, "the orphan's choice to be saved");
    await closeDrawer();
    await evaluate(`window.blame.engine.call("storyDiscard", { storyId: ${JSON.stringify(dropped.id)}, reason: "Not needed" })`);
    await evaluate(`window.blame.engine.call("storyEnqueue", { storyId: ${JSON.stringify(after.id)} })`);
    await evaluate(`window.blame.engine.call("storyEnqueue", { storyId: ${JSON.stringify(orphan.id)} })`);
    // The card's text as it reads (its lines kept; each wait is one line).
    const card = (id) => evaluate(`document.querySelector('[data-story-id="${id}"]')?.innerText ?? ""`);
    await until(async () => (await card(after.id)).includes("Starts after"), 30_000, "the waiting card to say why").catch(async (error) => {
      console.log("card:", JSON.stringify(await card(after.id)));
      console.log("queue:", JSON.stringify(await evaluate(`window.blame.engine.call("storyQueueState", undefined)`)));
      console.log("board ids:", JSON.stringify(await evaluate(`[...document.querySelectorAll("[data-story-id]")].map((element) => element.getAttribute("data-story-id") + ":" + element.getAttribute("data-story-state"))`)));
      console.log("after:", after.id, "startsAfter:", JSON.stringify((await current(after.id))?.startsAfter));
      await shot("09-waiting-cards-failed");
      throw error;
    });
    check("a story waits for the one it starts after, and its card says so", (await card(after.id)).includes("Base API"), await card(after.id));
    await until(async () => (await card(orphan.id)).includes("Will not start"), 30_000, "the orphan's card");
    check("a story whose dependency was discarded never starts, and its card says so", true, await card(orphan.id));
    await evaluate(`document.querySelector('[data-story-id="${after.id}"]')?.scrollIntoView({ block: "center", inline: "center" })`);
    await delay(600);
    await shot("09-waiting-cards");

    // Its drawer says the same, in the same words, and the field is still editable.
    await openDrawer(after);
    const waiting = await field();
    const cardWait = (await card(after.id)).split("\n").find((line) => line.startsWith("Starts after")) ?? "";
    check("a queued story's drawer says why it waits, as its card does", cardWait !== "" && waiting.includes(cardWait), waiting.replace(/\n/g, " | "));
    await shot("10-drawer-waiting");
    await closeDrawer();

    // The orphan's drawer shows the discarded story as such, with a way to drop it.
    await openDrawer(orphan);
    const orphanField = await field();
    check("a dependency that was discarded is shown as such", orphanField.includes("Dropped idea (discarded)"), orphanField.replace(/\n/g, " | "));
    await shot("11-drawer-discarded-dependency");
    await click(`(${openField})?.querySelector('button[aria-label^="Remove"]')`);
    await until(async () => ((await current(orphan.id))?.startsAfter ?? ["x"]).length === 0, 15_000, "the dependency to be removed");
    check("removing it from the field saves, and the story starts", true);
    await closeDrawer();
    await until(async () => (await current(orphan.id))?.status !== "ready", 60_000, "the orphan to start once it starts after nothing");
    check("a story freed of a dependency that was dropped starts", true);

    await until(async () => (await stories(shownProject.id)).some((story) => story.id === ownModel.id && story.status === "in-review"), 60_000, "the story on its own model");
    const ownRequests = model.requests.filter((request) => request.story === "Own model");
    check("a story runs on the model it asked for", ownRequests.length > 0 && ownRequests.every((request) => request.model === "claude-opus-5-5"), ownRequests.map((request) => request.model).join(", "));

    // The base runs, is done (with a commit of its own), and the story after it starts, told what it delivered.
    await evaluate(`window.blame.engine.call("storyEnqueue", { storyId: ${JSON.stringify(base.id)} })`);
    await until(async () => (await current(base.id))?.status === "in-review", 60_000, "the base to reach review");
    check("the story after it has not started yet", (await current(after.id))?.status === "ready");
    await writeFile(join(paths.shown, "src/base-api.js"), "export const baseApi = true\n");
    const before = (await git(paths.shown, "rev-parse", "HEAD")).stdout.trim();
    await git(paths.shown, "add", "src/base-api.js");
    await git(paths.shown, "commit", "-q", "-m", "Add the base API");
    const merged = (await git(paths.shown, "rev-parse", "HEAD")).stdout.trim();
    await evaluate(`window.blame.engine.call("storyComplete", { storyId: ${JSON.stringify(base.id)}, baseCommit: ${JSON.stringify(before)}, mergeCommit: ${JSON.stringify(merged)} })`);
    await until(async () => ["in-progress", "in-review"].includes((await current(after.id))?.status), 60_000, "the story after it to start");
    check("once it is done, the story after it starts", true);
    const requested = () => model.requests.find((request) => request.story === "After base" && request.first);
    await until(() => Boolean(requested()), 30_000, "the model's first request for the story after it").catch(() => undefined);
    const firstRequest = requested();
    if (!firstRequest) console.log("requests:", JSON.stringify(model.requests.map(({ story, tool, first, model: name }) => ({ story, tool, first, name }))));
    const brief = firstRequest?.firstUser ?? "";
    console.log("the dependent's first message:\n" + brief.split("\n").map((line) => "  | " + line).join("\n"));
    check("the model's first request for it carries what the first story reported", brief.includes("<starts_after>") && brief.includes("Done: Base API."), brief.slice(0, 80));
    check("... and the files it changed", brief.includes("A src/base-api.js"));
    check("... and the story's number and title", /US-\d{3} · Base API/.test(brief));
  }

  console.log(`model requests: ${model.requests.length}; checks: ${checks.filter((item) => item.ok).length}/${checks.length}`);
}

// ------------------------------------------------------------------ electron

async function inElectron() {
  const profile = process.argv.at(-1);
  const { app, BrowserWindow, dialog } = await import("electron");
  for (const name of ["appData", "userData", "sessionData"]) app.setPath(name, profile);
  app.setAppLogsPath(join(profile, "logs"));
  app.getAppPath = () => application;
  app.setAsDefaultProtocolClient = () => false;
  app.commandLine.appendSwitch("remote-debugging-port", process.env.STORY_DRIVE_PORT);
  process.env.LIMA_HOME = join(profile, "lima");
  process.env.BLAME_WSL_DISTRO = "BlameStoryDrive";
  const fail = (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    app.exit(1);
  };
  process.once("uncaughtException", fail);
  process.once("unhandledRejection", fail);
  void app.whenReady().then(prepare).catch(fail);

  async function prepare() {
    const shown = process.env.STORY_DRIVE_SHOWN;
    const hidden = process.env.STORY_DRIVE_HIDDEN;
    const window = await windowShowing(BrowserWindow, "");
    await window.webContents.executeJavaScript(`(async () => {
      const session = await window.blame.localApi.session();
      const api = (path, method, body) => fetch(session.url.replace(/\\/$/, "") + path, {
        method,
        headers: { Accept: "application/json", Authorization: "Bearer " + session.token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (response) => {
        if (!response.ok) throw new Error(path + ": " + response.status + " " + await response.text());
        const json = await response.json();
        const unwrap = (value) => value && typeof value === "object" && "data" in value ? unwrap(value.data) : value;
        const value = unwrap(json);
        return value?.transformerData?.[0] ?? value;
      });
      await api("/providers/credentials", "POST", { providerId: "anthropic", apiKey: "sk-ant-mock", baseUrl: ${JSON.stringify(process.env.STORY_DRIVE_MODEL_URL)} });
      const model = { providerId: "anthropic", modelId: "claude-sonnet-5-5", credentialLabel: null, reasoningEffort: null };
      await api("/account/ai-preferences", "PUT", { agentModel: model, alternativeModel: model });
      // The other project is one this computer opened before: in the recent list only.
      const hidden = await api("/projects", "POST", { name: "hidden-project", repositoryFingerprint: null });
      localStorage.setItem("blame.app.projects.v1", JSON.stringify({ recent: [{ id: hidden.id, name: "hidden-project", path: ${JSON.stringify(hidden)}, repositoryFingerprint: null, initials: "HP", color: "bg-blue-500" }] }));
      localStorage.setItem("blame.app.workspace-start.v1", "local");
      localStorage.setItem("blame.runtime-offer-done.v1", "true");
      localStorage.setItem("blame.runtime-preference.v1", JSON.stringify({ profile: "direct", source: "account-default" }));
    })()`);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [shown] });
    window.webContents.reload();
    const welcome = await windowShowing(BrowserWindow, "Open Project");
    await welcome.webContents.executeJavaScript(`[...document.querySelectorAll("button")]
      .find((button) => button.innerText.startsWith("Open Project")).click()`);
    await windowShowing(BrowserWindow, "Agent Queue");
    console.log("STORY_DRIVE_READY");
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
