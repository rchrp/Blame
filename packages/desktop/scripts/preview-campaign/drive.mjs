// Preview campaign: drives the built desktop app in an isolated profile (its
// own userData, its own Lima home and runtime VM, its own cloud worktree root)
// through the same workspace API the story drawer uses: create a worktree,
// prepare the preview from a manifest, start it, read its lifecycle, edit
// files, stop, restart, remove. Each scenario records checks with timings.
//
//   pnpm --filter @blame/desktop exec electron-vite build
//   node packages/desktop/scripts/preview-campaign/drive.mjs --out <dir> [--only a,b] [--fresh] [--keep]
//
// State lives under --root (default /tmp/blc: Lima sockets need a short
// path), so the runtime VM and the images survive between runs.
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { fixtures, writeFixture } from "./fixtures.mjs";
import { advancedFixtures } from "./advanced-fixtures.mjs";
import { editFixture, initializeFixture } from "./scripted-agent.mjs";

const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const here = fileURLToPath(new URL(".", import.meta.url));
const application = resolve(here, "../..");
const repository = resolve(application, "../..");
const limaBundle = "/Applications/Blame.app/Contents/Resources/runtime/macos/lima/bundle";

// -------------------------------------------------------------- runtime home

/**
 * The runtime resources the app runs its VM scripts from: the repository's own,
 * with the Lima config of the packaged app. The repository's config builds the
 * VM from the plain Ubuntu cloud image (slow, and it drifts from what people
 * run); the packaged app's downloads the baked image of the same runtime
 * version. The harness payload must be the version the manifest names:
 * `pnpm --filter @blame/desktop build:semantic-harness-payload`.
 */
async function prepareRuntimeHome(options) {
  const home = join(options.root, "runtime-home");
  const source = join(application, "resources/runtime/macos");
  const packaged = "/Applications/Blame.app/Contents/Resources/runtime/macos";
  const version = JSON.parse(await readFile(join(source, "manifest.json"), "utf8")).runtimeVersion;
  const current = await readFile(join(home, "manifest.json"), "utf8").then((text) => JSON.parse(text).runtimeVersion, () => null);
  const packagedVersion = await readFile(join(packaged, "manifest.json"), "utf8").then((text) => JSON.parse(text).runtimeVersion, () => null);
  if (packagedVersion !== version) throw new Error(`The installed Blame.app has runtime ${packagedVersion}, this checkout ${version}: its baked-image config would not match.`);
  if (current !== version) {
    await rm(home, { force: true, recursive: true });
    await cp(source, home, { recursive: true });
    await cp(join(packaged, "lima/blame-runtime.yaml"), join(home, "lima/blame-runtime.yaml"));
  } else await cp(join(source, "payloads"), join(home, "payloads"), { recursive: true });
  return home;
}

// ------------------------------------------------------------------ options

function parseOptions(argv) {
  const options = {
    root: "/tmp/blc",
    // The VM only mounts the home folder, so projects live there.
    projects: join(homedir(), ".blame-campaign", "projects"),
    out: resolve("campaign-out"),
    only: null,
    fresh: false,
    keep: false,
    cloud: false,
    scriptedAgents: false,
    // Where a signed-in app keeps its account session (only the Local Storage folder is copied).
    sessionFrom: join(homedir(), "Library/Application Support/dev.blame.desktop"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--root") options.root = resolve(argv[++index]);
    else if (flag === "--projects") options.projects = resolve(argv[++index]);
    else if (flag === "--out") options.out = resolve(argv[++index]);
    else if (flag === "--only") options.only = argv[++index].split(",");
    else if (flag === "--fresh") options.fresh = true;
    else if (flag === "--keep") options.keep = true;
    else if (flag === "--cloud") options.cloud = true;
    else if (flag === "--scripted-agents") options.scriptedAgents = true;
    else if (flag === "--session-from") options.sessionFrom = resolve(argv[++index]);
  }
  return options;
}

// ------------------------------------------------------------------- report

const results = [];
let current = "setup";
let outDirectory = ".";
const startedAt = Date.now();
const stamp = () => `${String(Math.round((Date.now() - startedAt) / 1000)).padStart(5)}s`;

async function log(line) {
  const text = `${stamp()} ${line}`;
  console.log(text);
  await appendFile(join(outDirectory, "campaign.log"), `${text}\n`).catch(() => undefined);
}

async function check(name, ok, detail = "") {
  results.push({ scenario: current, name, ok: Boolean(ok), detail: String(detail).slice(0, 1500) });
  await log(`${ok ? "PASS" : "FAIL"} [${current}] ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`);
  await writeFile(join(outDirectory, "results.json"), JSON.stringify(results, null, 2)).catch(() => undefined);
  return ok;
}

async function note(line) {
  await log(`     ${line}`);
}

// ---------------------------------------------------------------------- vm

function limaEnvironment(root) {
  return { ...process.env, LIMA_HOME: join(root, "lima"), PATH: `${limaBundle}/bin:${process.env.PATH}` };
}

/** A path as one shell word. */
const sq = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

/** Runs a shell command in the runtime VM, as root or as the `blame` user that owns the worktrees. */
async function vm(options, command, timeout = 120_000, user = "root") {
  try {
    const { stdout, stderr } = await execFileAsync(
      `${limaBundle}/bin/limactl`,
      ["shell", "--workdir", "/", "BlameRuntime", "--", "sudo", "-n", ...(user === "root" ? [] : ["-u", user]), "bash", "-lc", command],
      { env: limaEnvironment(options.root), timeout, maxBuffer: 32 * 1024 * 1024 },
    );
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? error.message) };
  }
}

async function vmStatus(options) {
  try {
    const { stdout } = await execFileAsync(`${limaBundle}/bin/limactl`, ["list", "--json"], {
      env: limaEnvironment(options.root),
    });
    const entry = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((vmEntry) => vmEntry.name === "BlameRuntime");
    return entry?.status ?? "missing";
  } catch {
    return "missing";
  }
}

// --------------------------------------------------------------------- http

async function get(url, { timeoutMs = 15_000, headers } = {}) {
  const startedGet = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers, redirect: "manual" });
    const body = await response.text();
    return { ok: true, status: response.status, body, ms: Date.now() - startedGet };
  } catch (error) {
    return { ok: false, status: 0, body: "", error: String(error.cause?.code ?? error.message), ms: Date.now() - startedGet };
  }
}

async function until(condition, timeoutMs, what, interval = 500) {
  const begun = Date.now();
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() - begun > timeoutMs) throw new Error(`Timed out (${Math.round(timeoutMs / 1000)}s) waiting for ${what}`);
    await delay(interval);
  }
}

// ------------------------------------------------------------------ browser

/** A hidden browser window on a preview URL (see browse.mjs). */
async function openBrowser(options, url, { ticket } = {}) {
  const electron = createRequire(import.meta.url)("electron");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  if (ticket) environment.BROWSE_TICKET = ticket;
  const profile = join(options.root, ticket ? `browser-profile-${crypto.randomUUID()}` : "browser-profile");
  const child = spawn(electron, [join(here, "browse.mjs"), url, profile], { env: environment, stdio: ["pipe", "pipe", "ignore"] });
  const running = () => child.exitCode === null && child.signalCode === null;
  child.stdin.on("error", () => undefined);
  const close = async () => {
    if (running()) {
      child.stdin.end('{"op":"quit"}\n');
      await until(() => !running(), 1000, "the test browser to quit", 100).catch(() => child.kill("SIGKILL"));
    }
    if (ticket) await rm(profile, { force: true, recursive: true });
  };
  const waiting = [];
  let buffer = "";
  const lines = [];
  child.stdout.on("data", (data) => {
    buffer += data;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const match = /^BROWSE_(READY|ANSWER) (.*)$/.exec(line);
      if (match) lines.push(JSON.parse(match[2]));
      waiting.splice(0).forEach((done) => done());
    }
  });
  const next = async (timeoutMs = 45_000) => {
    const begun = Date.now();
    while (!lines.length) {
      if (!running() || Date.now() - begun > timeoutMs) throw new Error("the test browser did not answer");
      await new Promise((done) => (waiting.push(done), setTimeout(done, 300)));
    }
    return lines.shift();
  };
  const first = await next(60_000).catch(async (error) => {
    await close();
    throw error;
  });
  const ask = async (op, input) => (child.stdin.write(`${JSON.stringify({ op, ...input })}\n`), next());
  return {
    first, text: () => ask("text"), reload: () => ask("reload"), goto: (path) => ask("goto", { path }),
    click: (selector) => ask("click", { selector }),
    close,
  };
}

// ---------------------------------------------------------------------- app

async function launch(options, port, { profile = "profile", projectWindow = true } = {}) {
  const electron = createRequire(import.meta.url)("electron");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_RENDERER_URL;
  Object.assign(environment, {
    CAMPAIGN_ROOT: options.root,
    CAMPAIGN_PORT: String(port),
    BLAME_ENGINE_LOG: "warn",
    BLAME_ENGINE_BIN: environment.BLAME_ENGINE_BIN ?? join(repository, "target/debug/blame-engine"),
    BLAME_HARNESS_BIN: environment.BLAME_HARNESS_BIN ?? join(repository, "target/debug/blame-harness"),
    BLAME_LIMA_BUNDLE_DIR: limaBundle,
    // The repository's Lima config builds from the Ubuntu cloud image; the packaged
    // app downloads the baked image. /tmp/blc/runtime-home is the repository's runtime
    // resources with the packaged config (see the README next to this file).
    BLAME_RUNTIME_BIN_DIR: join(options.root, "runtime-home/bin"),
  });
  const child = spawn(electron, [fileURLToPath(import.meta.url), join(options.root, profile)], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { text: "" };
  const capture = (data) => {
    output.text += data;
    void appendFile(join(outDirectory, "app.log"), data).catch(() => undefined);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  await until(() => output.text.includes("CAMPAIGN_READY") || child.exitCode !== null, 120_000, "the app to open");
  if (child.exitCode !== null) throw new Error(`The app exited early:\n${output.text.slice(-3000)}`);
  const compact = await connect(port, { compact: true });
  if (!projectWindow) return { child, cdp: compact, output };
  // A hidden launcher window reads previews in the background: the person's
  // own view is a project window, so open one and drive that.
  await mkdir(options.projects, { recursive: true });
  const holder = join(options.projects, "window-holder");
  await mkdir(holder, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: holder }).catch(() => undefined);
  await compact.evaluate(`window.blame.projectWindows.openProject(${JSON.stringify(holder)}).then(() => true, (error) => String(error))`).catch(() => undefined);
  let cdp = compact;
  try {
    cdp = await connect(port, { compact: false, timeoutMs: 60_000 });
    await note("driving a project window");
  } catch {
    await note("no project window opened: driving the launcher window (previews are read in the background)");
  }
  return { child, cdp, output };
}

async function quit(app) {
  if (!app.child || app.child.exitCode !== null) return;
  app.child.kill("SIGTERM");
  await until(() => app.child.exitCode !== null, 20_000, "the app to quit").catch(() => app.child.kill("SIGKILL"));
}

async function connect(port, { compact = false, timeoutMs = 30_000 } = {}) {
  let target;
  await until(async () => {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const pages = targets.filter((entry) => entry.type === "page" && !entry.url.startsWith("devtools"));
      target = compact ? pages[0] : pages.find((entry) => !entry.url.includes("window-role=compact"));
      return Boolean(target);
    } catch {
      return false;
    }
  }, timeoutMs, "the debugging port");
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
    new Promise((resolveSend, reject) => {
      const id = ++next;
      pending.set(id, { resolve: resolveSend, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await until(async () => (await send("Runtime.evaluate", { expression: "Boolean(window.blame && window.blame.workspace)", returnByValue: true }).catch(() => ({ result: {} }))).result?.value === true, 60_000, "the workspace api");
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  return { send, evaluate };
}

/** Calls `window.blame.workspace.<method>(input)` and returns its value or `{ error }`. */
async function workspace(app, method, input) {
  const expression = `(async () => {
    try {
      const value = await window.blame.workspace.${method}(${input === undefined ? "" : JSON.stringify(input)});
      return { value: value ?? null };
    } catch (error) {
      return { error: String(error && error.message || error) };
    }
  })()`;
  return app.cdp.evaluate(expression);
}

// ----------------------------------------------------------------- scenarios

let counter = 0;
// Worktree names derive from the story reference: keep them unique across runs.
const runId = Date.now().toString(36).slice(-5);
const uniqueStory = () => `00000000-0000-4000-8000-${String(Date.now()).slice(-8)}${String(++counter).padStart(4, "0")}`;

/** Creates a worktree in the runtime for a fixture and prepares its preview. */
async function openStory(app, options, name, { variant } = {}) {
  const fixture = fixtures[name];
  const project = await writeFixture(options.projects, name);
  const setup = await fixtureSetup(options, name, project);
  const storyId = uniqueStory();
  const created = await timed(`${name}: create worktree`, () =>
    workspace(app, "createWorktree", {
      repositoryRoot: project,
      runtimeProfile: "local-container",
      storyId,
      storyReference: `CMP-${runId}-${counter}`,
      title: fixture.storyTitle ?? `Campaign ${name}${variant ? ` ${variant}` : ""}`,
      ...(fixture.targetBranch ? { targetBranch: fixture.targetBranch } : {}),
    }),
  );
  if (created.result.error || !created.result.value?.worktree) {
    await check(`${name}: create worktree`, false, created.result.error ?? JSON.stringify(created.result.value));
    return null;
  }
  const { worktree } = created.result.value;
  await check(`${name}: create worktree`, true, `${worktree} in ${created.ms} ms`);
  const prepared = await timed(`${name}: prepare preview`, () =>
    workspace(app, "prepareProjectPreview", {
      worktree,
      previewManifest: setup.previewManifest,
      runConfigurations: setup.runConfigurations,
      runConfigurationId: setup.runConfigurations[0].id,
      hostDependenciesChecked: true,
      runtimeProfile: "local-container",
      databaseMode: null,
    }),
  );
  if (prepared.result.error) {
    await check(`${name}: prepare preview`, false, prepared.result.error);
    return { name, worktree, project, storyId, fixture, prepared: false };
  }
  await check(`${name}: prepare preview`, true, `${prepared.ms} ms`);
  return { name, worktree, project, storyId, fixture, prepared: true, configurationId: setup.runConfigurations[0].id };
}

async function fixtureSetup(options, name, project) {
  const fixture = fixtures[name];
  if (!options.scriptedAgents || !fixture.initializationFile) {
    return { previewManifest: fixture.manifest, runConfigurations: fixture.runConfigurations };
  }
  const { result, ms } = await timed("initialization", () => initializeFixture(project, fixture));
  await check(`${name}: the initialization agent's setup was accepted`, true, `${ms} ms`);
  return result;
}

async function timed(label, action) {
  const begun = Date.now();
  const result = await action();
  return { result, ms: Date.now() - begun, label };
}

async function readState(app, story) {
  const reply = await workspace(app, "projectPreviewRuntimeState", { worktree: story.worktree, workspaceMode: "local-container" });
  return reply.error ? { error: reply.error } : reply.value;
}

/** Starts the preview and follows its lifecycle until it is ready or failed. */
async function startAndWatch(app, story, { timeoutMs = 600_000, label = "start" } = {}) {
  const begun = Date.now();
  const transitions = [];
  const record = (state) => {
    const life = state?.lifecycle;
    const key = life ? `${life.phase}/${life.status}${life.step ? ` — ${life.step}` : ""}${life.failure ? ` — ${life.failure.message}` : ""}` : state?.error ? `error ${state.error}` : "no lifecycle";
    if (transitions.at(-1)?.key !== key) transitions.push({ at: Date.now() - begun, key });
  };
  let controlDone = false;
  const controlRequest = workspace(app, "controlProjectPreview", { action: "start", configurationId: story.configurationId, worktree: story.worktree }).then((value) => ((controlDone = true), value));
  let final;
  let control;
  try {
    final = await until(async () => {
      const state = await readState(app, story);
      record(state);
      if (controlDone) control ??= await controlRequest;
      if (control?.error) {
        // The state follows the failure a moment later.
        await delay(3000);
        const settled = await readState(app, story);
        return { ok: false, state: settled?.lifecycle ? settled : state, error: control.error };
      }
      const life = state?.lifecycle;
      if (life?.status === "error" || life?.phase === "failed") return { ok: false, state };
      const configured = state?.statuses?.[story.configurationId];
      if (life?.status === "ready" && (configured === "running" || configured === undefined) && state.previewUrl) return { ok: true, state };
      if (configured === "error") return { ok: false, state };
      return false;
    }, timeoutMs, `${story.name} to be ready or failed`, 700);
  } catch (error) {
    final = { ok: false, state: await readState(app, story).catch(() => null), timedOut: true, error: error.message };
  }
  const ms = Date.now() - begun;
  await note(`${story.name} ${label} timeline: ${transitions.map((t) => `${(t.at / 1000).toFixed(1)}s ${t.key}`).join(" | ")}`);
  return { ...final, transitions, ms };
}

async function collectDiagnostics(app, options, story, label) {
  const lines = [];
  const state = await readState(app, story).catch(() => null);
  lines.push(`state: ${JSON.stringify(state)?.slice(0, 1500)}`);
  const containers = await storyContainers(options, story);
  lines.push(`containers:\n${containers.stdout}`);
  const names = containers.stdout
    .split("\n")
    .map((line) => line.split(" ")[0])
    .filter(Boolean)
    .slice(0, 6);
  for (const containerName of names) {
    const logs = await vm(options, `docker logs --tail 25 ${containerName} 2>&1`);
    lines.push(`--- ${containerName}\n${logs.stdout || logs.stderr}`);
  }
  await writeFile(join(outDirectory, `diag-${story.name}-${label}.txt`), lines.join("\n")).catch(() => undefined);
}

// Scenario: a project that must start, load, and take an edit.
async function scenarioHealthy(app, options, name) {
  current = `healthy:${name}`;
  const fixture = fixtures[name];
  const story = await openStory(app, options, name);
  if (!story?.prepared) return story;
  const start = await startAndWatch(app, story);
  await check(`${name}: preview ready`, start.ok, start.ok ? `${(start.ms / 1000).toFixed(1)} s, ${start.state.previewUrl}` : JSON.stringify(start.state?.lifecycle ?? start.error));
  if (!start.ok) {
    await collectDiagnostics(app, options, story, "start");
    return story;
  }
  story.url = start.state.previewUrl;
  if (fixture.expectUrlPath)
    await check(`${name}: preview url opens on ${fixture.expectUrlPath}`, new URL(story.url).pathname === fixture.expectUrlPath, story.url);
  const base = new URL("/", story.url).href;
  const page = await get(new URL(fixture.page.path, base).href, { timeoutMs: 60_000 });
  await check(`${name}: first page loads`, page.ok && page.status === 200 && page.body.includes(fixture.page.includes), `${page.status} in ${page.ms} ms ${page.error ?? ""} ${page.body.slice(0, 120).replace(/\s+/g, " ")}`);
  const probe = fixture.manifest.probes?.[0];
  if (probe?.target?.path) {
    const probed = await get(new URL(probe.target.path, story.url).href);
    await check(`${name}: probe route answers`, probed.ok && probed.status < 500, `${probed.status} ${probed.error ?? ""}`);
  }
  for (const extra of fixture.extraPages ?? []) {
    const response = await get(new URL(extra, base).href, { timeoutMs: 90_000 });
    await check(`${name}: ${extra} answers`, response.ok && response.status === 200, `${response.status} in ${response.ms} ms`);
  }
  story.base = base;
  if (advancedFixtures[name]) await checkEmbeddedPreview(app, story);
  if (fixture.visible) await browserCheck(options, story);
  else if (fixture.edit && !fixture.edit.skipEdit) await editAndCheck(app, options, story);
  return story;
}

async function checkEmbeddedPreview(app, story, sessionId) {
  const context = sessionId ? { previewSessionId: sessionId } : { previewWorktree: story.worktree };
  const result = await app.cdp.evaluate(`(async () => {
    const browser = window.blame.previewBrowser;
    const { id } = await browser.create(${JSON.stringify({ storageKey: story.storyId, ...context })});
    let state;
    const unsubscribe = browser.onState({ id }, (update) => { state = update; });
    try {
      const url = ${JSON.stringify(story.url)};
      await browser.setBounds({ id, visible: false, bounds: { x: 0, y: 0, width: 900, height: 640 } });
      const loaded = await browser.load({ id, url });
      const deadline = Date.now() + 15_000;
      while (!state?.application && !state?.error && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 100));
      return { loaded, state };
    } catch (error) {
      return { error: String(error), state };
    } finally {
      unsubscribe();
      await browser.destroy({ id });
    }
  })()`);
  await check(`${story.name}: desktop's embedded preview reports a loaded app`, result.loaded &&
    !result.state?.loading && !result.state?.error && result.state?.application?.status === "ready" &&
    result.state?.url === story.url, JSON.stringify(result.state ?? result.error));
}

/** What a person sees in a browser: the page, no errors, a source edit appearing. */
async function browserCheck(options, story) {
  const { visible, edit } = story.fixture;
  const url = new URL(visible.path ?? "/", story.base).href;
  let browser;
  try {
    browser = await openBrowser(options, url);
    const first = browser.first;
    await check(`${story.name}: browser shows the page`, first.text.includes(visible.before), `${first.loadMs} ms: ${first.text.slice(0, 100).replace(/\s+/g, " ")}`);
    await check(`${story.name}: browser has no console error or failed request`, first.errors.length === 0 && first.failedRequests.length === 0, [...first.errors, ...first.failedRequests].join(" | "));
    if (visible.title) {
      const titled = await until(async () => ((await browser.text()).title === visible.title ? true : false), 15_000, "the page title").catch(() => false);
      await check(`${story.name}: page script ran (title ${JSON.stringify(visible.title)})`, titled, (await browser.text()).title);
    }
    if (story.fixture.browserFlow) await verifyBrowserFlow(browser, story.name, story.fixture.browserFlow);
    if (edit && !edit.skipEdit) {
      const begun = Date.now();
      const sed = `cd ${sq(story.worktree)} && sed -i 's/${edit.from}/${edit.to}/' '${edit.file}'`;
      const edited = await vm(options, sed, 60_000, "blame");
      if (!edited.ok) return check(`${story.name}: edit applied`, false, edited.stderr);
      if (visible.hot) {
        const seen = await until(async () => ((await browser.text()).text.includes(visible.after) ? true : false), 60_000, "the edit on the open page", 500).catch(() => false);
        await check(`${story.name}: open page updates without a reload (hot reload)`, seen, seen ? `${Date.now() - begun} ms` : "not within 60 s");
        if (!seen) {
          const reloaded = await browser.reload();
          await check(`${story.name}: a reload shows the edit`, reloaded.text.includes(visible.after), reloaded.text.slice(0, 100));
        }
      } else {
        const reloaded = await until(async () => {
          const answer = await browser.reload();
          return answer.text.includes(visible.after) ? answer : false;
        }, 60_000, "the edit after a reload", 1500).catch(() => null);
        await check(`${story.name}: a reload shows the edit`, Boolean(reloaded), reloaded ? `${Date.now() - begun} ms` : "not within 60 s");
      }
    }
  } catch (error) {
    await check(`${story.name}: browser check`, false, error.message);
  } finally {
    await browser?.close();
  }
}

async function verifyBrowserFlow(browser, name, flow) {
  const waiting = await until(async () => {
    const page = await browser.text();
    return page.text.includes(flow.initial) ? page : false;
  }, 15_000, flow.initial).catch(() => null);
  await check(`${name}: browser shows the initial state`, waiting, waiting?.text ?? flow.initial);
  if (!waiting) return;
  const clicked = await browser.click(flow.click);
  const result = clicked.clicked ? await until(async () => {
    const page = await browser.text();
    return page.text.includes(flow.result) ? page : false;
  }, 20_000, flow.result).catch(() => null) : null;
  const last = result ?? await browser.text();
  await check(`${name}: browser action returns the expected result`, result, last.text);
  await check(`${name}: browser action has no console error or failed request`, last.errors.length === 0 && last.failedRequests.length === 0, [...last.errors, ...last.failedRequests].join(" | "));
}

async function editAndCheck(app, options, story, { suffix = "" } = {}) {
  const { edit } = story.fixture;
  const begun = Date.now();
  const sed = `cd ${sq(story.worktree)} && sed -i 's/${edit.from}/${edit.to}/' '${edit.file}' && grep -c '${edit.to}' '${edit.file}'`;
  const edited = await vm(options, sed, 60_000, "blame");
  if (!edited.ok) return check(`${story.name}: edit applied${suffix}`, false, edited.stderr);
  const reached = await until(async () => {
    const response = await get(new URL(edit.served, story.url).href, { timeoutMs: 20_000 });
    return response.ok && response.body.includes(edit.includes) ? response : false;
  }, 90_000, "the edit to reach the page", 800).catch(() => null);
  return check(`${story.name}: edit reaches the preview${suffix}`, Boolean(reached), reached ? `${Date.now() - begun} ms` : "never seen within 90 s");
}

// Scenario: a project that must fail, clearly and finally.
async function scenarioFailure(app, options, name) {
  current = `failure:${name}`;
  const fixture = fixtures[name];
  const story = await openStory(app, options, name);
  if (!story?.prepared) return story;
  const start = await startAndWatch(app, story, { timeoutMs: 240_000 });
  let failure = start.state?.lifecycle?.failure?.message ?? "";
  if (!failure && !start.timedOut) {
    // The service status can turn to error before the lifecycle says why.
    const waitedFrom = Date.now();
    await until(async () => {
      const state = await readState(app, story);
      failure = state?.lifecycle?.failure?.message ?? "";
      return failure;
    }, 30_000, "the failure message", 1000).catch(() => undefined);
    await check(`${name}: the lifecycle explains the failure promptly`, Boolean(failure), failure ? `${((Date.now() - waitedFrom) / 1000).toFixed(1)} s after the status turned to error` : "no failure message after 30 s: the state stays pending");
  }
  failure ||= start.error ?? "";
  await check(`${name}: ends in a failure state`, !start.ok && !start.timedOut, start.timedOut ? "still pending after 240 s" : failure.slice(0, 400));
  if (!start.timedOut && fixture.expectFailure)
    await check(`${name}: failure message names the cause`, fixture.expectFailure.includes.test(failure), failure.slice(0, 500));
  await collectDiagnostics(app, options, story, "failure");
  return story;
}

async function scenarioSlow(app, options, name) {
  current = `slow:${name}`;
  const fixture = fixtures[name];
  const story = await openStory(app, options, name);
  if (!story?.prepared) return story;
  const start = await startAndWatch(app, story, { timeoutMs: 300_000 });
  await check(`${name}: becomes ready despite a slow server`, start.ok, `${(start.ms / 1000).toFixed(1)} s ${JSON.stringify(start.state?.lifecycle?.failure ?? "")}`);
  if (start.ok) {
    const page = await get(new URL(fixture.page.path, start.state.previewUrl).href);
    await check(`${name}: page loads`, page.ok && page.body.includes(fixture.page.includes), `${page.status}`);
  } else await collectDiagnostics(app, options, story, "slow");
  return story;
}

async function scenarioLifecycle(app, options, story) {
  current = `lifecycle:${story.name}`;
  const stopped = await workspace(app, "controlProjectPreview", { action: "stop", worktree: story.worktree });
  await check(`${story.name}: stop request`, !stopped.error, stopped.error ?? "");
  const afterStop = await until(async () => {
    const state = await readState(app, story);
    return state?.statuses?.[story.configurationId] === "stopped" ? state : false;
  }, 120_000, "stopped").catch(() => null);
  await check(`${story.name}: reaches stopped`, Boolean(afterStop), JSON.stringify(afterStop?.lifecycle ?? ""));
  const down = await get(story.url, { timeoutMs: 5_000 });
  await check(`${story.name}: url no longer answers while stopped`, !down.ok || down.status === 0, `${down.status} ${down.error ?? ""}`);
  const restart = await startAndWatch(app, story, { label: "restart" });
  await check(`${story.name}: restarts to ready`, restart.ok, `${(restart.ms / 1000).toFixed(1)} s ${JSON.stringify(restart.state?.lifecycle?.failure ?? "")}`);
  if (restart.ok) {
    await check(`${story.name}: same url after restart`, restart.state.previewUrl === story.url, `${story.url} → ${restart.state.previewUrl}`);
    story.url = restart.state.previewUrl;
    const page = await get(new URL(story.fixture.page.path, story.url).href, { timeoutMs: 60_000 });
    await check(`${story.name}: page loads after restart`, page.ok && page.status === 200, `${page.status} in ${page.ms} ms`);
  }
  const restarted = await workspace(app, "controlProjectPreview", { action: "restart", configurationId: story.configurationId, worktree: story.worktree });
  await check(`${story.name}: restart action accepted`, !restarted.error, restarted.error ?? "");
  const again = await until(async () => {
    const state = await readState(app, story);
    return state?.lifecycle?.status === "ready" ? state : state?.lifecycle?.status === "error" ? { failed: state } : false;
  }, 300_000, "ready after restart action").catch(() => null);
  await check(`${story.name}: ready after restart action`, Boolean(again) && !again.failed, JSON.stringify(again?.failed?.lifecycle ?? ""));
}

async function scenarioIsolation(app, options, first) {
  current = "isolation:django-celery";
  if (!first?.url) return void (await check("the first story has a running preview", false));
  const second = await openStory(app, options, first.name, { variant: "isolated" });
  if (!second?.prepared) return;
  try {
    const started = await startAndWatch(app, second);
    await check("the second story also starts", started.ok, JSON.stringify(started.state?.lifecycle?.failure ?? started.error ?? ""));
    if (!started.ok) return;
    second.url = started.state.previewUrl;
    const [firstPage, secondPage, firstDb, secondDb] = await Promise.all([
      get(first.url), get(second.url),
      get(new URL("/status", first.url).href), get(new URL("/status", second.url).href),
    ]);
    await check("the concurrent stories have separate preview ports", new URL(first.url).port !== new URL(second.url).port);
    await check("the edit is isolated to its worktree", firstPage.body.includes("Django queue v2") && secondPage.body.includes("Django queue v1"));
    await check("the worker's database mutation survived restart and stayed in its story",
      firstDb.status === 200 && /"processed":\s*1/.test(firstDb.body) &&
      secondDb.status === 200 && /"processed":\s*0/.test(secondDb.body), `${firstDb.body} / ${secondDb.body}`);
  } finally {
    await scenarioRemove(app, options, second);
  }
}

async function scenarioMigrationRecovery(app, options) {
  const name = "django-celery";
  current = "migration-recovery";
  const story = await openStory(app, options, name, { variant: "recover" });
  if (!story?.prepared) return;
  const settings = sq(join(story.worktree, "settings.py"));
  try {
    const broken = await vm(options, `printf '\\nraise RuntimeError("campaign broken migration settings")\\n' >> ${settings}`, 10_000, "blame");
    if (!(await check("migration failure installed in the story", broken.ok, broken.stderr))) return;
    const failed = await startAndWatch(app, story, { timeoutMs: 90_000 });
    await check("failed migration is surfaced as a setup failure", !failed.ok && !failed.timedOut &&
      /migrate|migration/i.test(JSON.stringify(failed.state?.lifecycle) + failed.error), JSON.stringify(failed.state?.lifecycle ?? failed.error));
    const repaired = await vm(options, `git -C ${sq(story.worktree)} restore -- settings.py`, 10_000, "blame");
    if (!(await check("restored the settings in the same worktree", repaired.ok, repaired.stderr))) return;
    const restarted = await workspace(app, "controlProjectPreview", { action: "restart", configurationId: story.configurationId, worktree: story.worktree });
    const state = restarted.value;
    story.url = state?.previewUrl;
    await check("restart completes after the correction", state?.lifecycle?.status === "ready" && story.url, restarted.error ?? JSON.stringify(state?.lifecycle));
    if (!story.url) return;
    const page = await get(story.url);
    await check("the repaired preview serves the application", page.status === 200 && page.body.includes(story.fixture.visible.before));
  } finally {
    await scenarioRemove(app, options, story);
  }
}

async function scenarioRemove(app, options, story) {
  current = `remove:${story.name}`;
  const before = await storyContainers(options, story);
  const removed = await workspace(app, "removeWorktree", { repositoryRoot: story.project, workspaceMode: "local-container", worktree: story.worktree });
  await check(`${story.name}: removeWorktree`, !removed.error && removed.value !== false, removed.error ?? String(removed.value));
  await delay(3000);
  const gone = await vm(options, `test -e ${sq(story.worktree)} && echo present || echo gone`);
  await check(`${story.name}: worktree directory gone`, gone.stdout.trim() === "gone", gone.stdout.trim());
  const containers = await storyContainers(options, story);
  await check(`${story.name}: its containers are gone`, containers.ok && !containers.stdout.trim(),
    containers.stderr || containers.stdout || `${before.stdout.trim().split("\n").filter(Boolean).length} before removal`);
  if (story.url) {
    const down = await get(story.url, { timeoutMs: 4_000 });
    await check(`${story.name}: url dead after removal`, !down.ok, `${down.status}`);
  }
}

function storyContainers(options, story) {
  const label = sq(`label=com.docker.compose.project.working_dir=${join(story.worktree, ".blame/preview")}`);
  return vm(options, `docker ps -a --filter ${label} --format '{{.Names}} {{.Status}}'`);
}

// Scenario: several stories start at once (a person queues a few stories).
async function scenarioParallel(app, options, names, label) {
  current = `parallel:${label}`;
  const stories = [];
  for (const [index, name] of names.entries()) {
    const story = await openStory(app, options, name, { variant: `${label}-${index}` });
    if (story?.prepared) stories.push(story);
  }
  const memoryBefore = await vm(options, "free -m | sed -n 2p; free -m | sed -n 3p");
  const begun = Date.now();
  const starts = await Promise.all(stories.map((story) => startAndWatch(app, story, { timeoutMs: 900_000, label: `parallel start` })));
  await note(`all ${stories.length} starts settled after ${((Date.now() - begun) / 1000).toFixed(0)} s; memory before: ${memoryBefore.stdout.replace(/\s+/g, " ")}`);
  const memoryAfter = await vm(options, "free -m | sed -n 2p; free -m | sed -n 3p; dmesg 2>/dev/null | grep -ci 'out of memory\\|oom-kill' || true; uptime");
  await note(`memory after: ${memoryAfter.stdout.replace(/\s+/g, " ")}`);
  for (const [index, story] of stories.entries()) {
    const start = starts[index];
    await check(`${story.name}#${index}: ready in parallel start`, start.ok, start.ok ? `${(start.ms / 1000).toFixed(0)} s` : JSON.stringify(start.state?.lifecycle?.failure ?? start.error ?? start.state?.lifecycle));
    if (!start.ok) {
      await collectDiagnostics(app, options, story, `parallel-${index}`);
      continue;
    }
    story.url = start.state.previewUrl;
    story.base = new URL("/", story.url).href;
    const page = await get(new URL(story.fixture.page.path, story.base).href, { timeoutMs: 90_000 });
    await check(`${story.name}#${index}: page loads`, page.ok && page.status === 200 && page.body.includes(story.fixture.page.includes), `${page.status} in ${page.ms} ms`);
  }
  const facts = await Promise.all(stories.map((story) => setupFacts(options, story)));
  await note(`parallel:${label} setup: ${stories.map((story, index) => `${story.name}#${index} ${JSON.stringify(facts[index])}`).join(" | ")}`);
  if (process.env.BLAME_PREVIEW_SHARED_SETUP !== "0" && names[0] === names[1])
    await check(`parallel:${label}: identical stories install once`, facts.filter((entry) => entry.ran && !entry.skipped).length <= 1, JSON.stringify(facts.map((entry) => ({ ran: entry.ran, skipped: entry.skipped }))));
  const ports = stories.filter((story) => story.url).map((story) => new URL(story.url).port);
  await check(`parallel:${label}: every story has its own port`, new Set(ports).size === ports.length, ports.join(","));
  const oom = (memoryAfter.stdout.split("\n")[2] ?? "").trim();
  await check(`parallel:${label}: no out-of-memory kill in the VM`, oom === "0" || oom === "", `oom lines: ${oom}`);
  return stories;
}

// Scenario: the app quits and starts again while previews run.
async function scenarioAppRestart(ctx, options, stories, port) {
  current = "app-restart";
  const running = stories.filter((story) => story?.url);
  await quit(ctx.app);
  await delay(2000);
  const alive = await get(running[0].url, { timeoutMs: 5000 });
  await note(`after the app quit, ${running[0].name} ${alive.ok ? "still answers" : "does not answer"} (${alive.status} ${alive.error ?? ""})`);
  ctx.app = await launch(options, port + 1);
  const app = ctx.app;
  for (const story of running) {
    // What the board does for a story it shows: read its state, and every 30 s ask the recovery poll.
    const begun = Date.now();
    let state = await readState(app, story);
    await note(`${story.name} state right after the app restarted: ${JSON.stringify(state?.lifecycle ?? state?.error)}`);
    const wording = state?.lifecycle?.failure?.message ?? "";
    await check(`${story.name}: state after the app restarted is not misleading`, !/unexpectedly/i.test(wording), wording || state?.lifecycle?.status);
    let recovered = false;
    for (let tick = 0; Date.now() - begun < 150_000; tick += 1) {
      if (tick % 15 === 0) await workspace(app, "ensureProjectPreviewUrl", { worktree: story.worktree }).catch(() => undefined);
      state = await readState(app, story);
      if (state?.lifecycle?.status === "ready" && state.previewUrl) {
        recovered = true;
        break;
      }
      await delay(2000);
    }
    await note(`${story.name}: ${recovered ? `back by itself after ${((Date.now() - begun) / 1000).toFixed(0)} s` : "not back by itself within 150 s"} (auto-start is off by default)`);
    if (!recovered) {
      const start = await startAndWatch(app, story, { label: "start after the app restarted", timeoutMs: 300_000 });
      await check(`${story.name}: one start brings it back`, start.ok, start.ok ? `${(start.ms / 1000).toFixed(0)} s` : JSON.stringify(start.state?.lifecycle?.failure ?? start.error));
      state = start.state;
    }
    if (state?.previewUrl) await check(`${story.name}: same url after the app restarted`, state.previewUrl === story.url, `${story.url} → ${state.previewUrl}`);
    const ready = await until(async () => {
      const response = await get(new URL(story.fixture.page.path, story.base).href, { timeoutMs: 10_000 });
      return response.ok && response.status === 200 ? response : false;
    }, 60_000, `${story.name} to answer`, 1500).catch(() => null);
    await check(`${story.name}: page answers after the app restarted`, Boolean(ready), ready ? `${ready.ms} ms` : "never answered");
  }
}

// Scenario: the ways an agent changes files while a preview runs.
async function scenarioEdits(app, options, story) {
  current = `edits:${story.name}`;
  const { name } = story;
  const w = (command) => vm(options, `cd ${sq(story.worktree)} && ${command}`, 60_000, "blame");
  const seen = async (path, text, timeoutMs = 45_000) => {
    const begun = Date.now();
    const ok = await until(async () => {
      const response = await get(new URL(path, story.base).href, { timeoutMs: 15_000 });
      return response.ok && response.body.includes(text);
    }, timeoutMs, `${text} at ${path}`, 600).then(() => true, () => false);
    return { ok, ms: Date.now() - begun };
  };
  const file = story.fixture.edit.file;
  const servedPath = story.fixture.edit.served;
  // Each style rewrites the page's version text in a different way: what an
  // editor, a formatter or a tool that rewrites whole files would do.
  const styles = [
    ["truncate-write", (from, to) => `sed 's/${from}/${to}/' '${file}' > /tmp/blc-edit && cat /tmp/blc-edit > '${file}'`],
    ["atomic-rename", (from, to) => `sed 's/${from}/${to}/' '${file}' > '${file}.tmp' && mv '${file}.tmp' '${file}'`],
    ["copy-then-remove", (from, to) => `sed 's/${from}/${to}/' '${file}' > '${file}.new' && cp '${file}.new' '${file}' && rm '${file}.new'`],
  ];
  let previous = story.fixture.edit.to;
  for (const [label, build] of styles) {
    const text = `${name}-${label}`;
    const applied = await w(build(previous, text));
    if (!applied.ok) {
      await check(`${name}: edit by ${label}`, false, applied.stderr);
      continue;
    }
    previous = text;
    const result = await seen(servedPath, text);
    await check(`${name}: edit by ${label} reaches the preview`, result.ok, `${result.ms} ms`);
  }
  // A new file the server must pick up.
  const created = await w(`mkdir -p public && echo campaign-new-file > public/new.txt`);
  if (created.ok && story.name === "vite-react") {
    const result = await seen("/new.txt", "campaign-new-file");
    await check(`${name}: a new public file is served`, result.ok, `${result.ms} ms`);
  }
  // A burst of edits: the last one must win.
  const burst = await w(`sed -i "s/${previous}/${name}-burst-0/" '${file}'; for i in $(seq 1 25); do sed -i "s/${name}-burst-[0-9]*/${name}-burst-$i/" '${file}'; sleep 0.08; done; grep -o "${name}-burst-[0-9]*" '${file}' | tail -1`);
  const last = burst.stdout.trim();
  const burstResult = last ? await seen(servedPath, last, 60_000) : { ok: false, ms: 0 };
  await check(`${name}: the last of 25 quick edits wins`, burstResult.ok, `${last} after ${burstResult.ms} ms`);
  // Many files at once, as a branch switch or a generator leaves.
  const many = await w(`mkdir -p public/gen && for i in $(seq 1 600); do echo "gen $i" > public/gen/f$i.txt; done; echo done`);
  await check(`${name}: 600 files written`, many.ok, many.stderr);
  const afterMany = await w(`sed -i "s/${last || previous}/${name}-after-many/" '${file}'`);
  const manyResult = afterMany.ok ? await seen(servedPath, `${name}-after-many`, 60_000) : { ok: false, ms: 0 };
  await check(`${name}: still serves edits after 600 new files`, manyResult.ok, `${manyResult.ms} ms`);
  // A configuration change that makes the dev server restart itself.
  if (story.name === "next-app") {
    const config = await w(`printf 'export default { async rewrites() { return [{ source: "/old", destination: "/about" }]; } };\n' > next.config.mjs`);
    if (config.ok) {
      const rewrite = await seen("/old", "About page v1", 90_000);
      await check(`${name}: next.config change takes effect (server restarts)`, rewrite.ok, `${rewrite.ms} ms`);
    }
    const removed = await w(`rm app/about/page.jsx`);
    if (removed.ok) {
      const gone = await until(async () => (await get(new URL("/about", story.base).href, { timeoutMs: 15_000 })).status === 404, 45_000, "/about to disappear", 700).then(() => true, () => false);
      await check(`${name}: a deleted page returns 404`, gone);
    }
  }
}

// Scenario: once no agent works on a story, a review build replaces the dev server.
async function scenarioReviewBuild(app, options, stories, { minutes = 9 } = {}) {
  current = "review-build";
  const port = (story) => new URL(story.url).port;
  const serving = async (story) => {
    const found = await vm(options, `n=$(docker ps --filter publish=${port(story)} --format '{{.Names}}' | head -1); [ -n "$n" ] && docker inspect -f '{{json .Config.Cmd}}' "$n"`);
    const command = found.stdout.trim();
    return { command, mode: /run build|vite build|preview|next start|run start/.test(command) && !/ dev/.test(command) ? "review" : "development" };
  };
  const outages = new Map(stories.map((story) => [story.name, { worst: 0, since: null, failures: 0 }]));
  const switched = new Map();
  const begun = Date.now();
  while (Date.now() - begun < minutes * 60_000 && switched.size < stories.length) {
    for (const story of stories) {
      // A request counts as use: the preview must not hibernate meanwhile.
      const response = await get(new URL(story.fixture.page.path, story.base).href, { timeoutMs: 8_000 });
      const outage = outages.get(story.name);
      if (response.ok && response.status === 200) outage.since = null;
      else {
        outage.since ??= Date.now();
        outage.failures += 1;
        outage.worst = Math.max(outage.worst, Date.now() - outage.since);
      }
      if (!switched.has(story.name) && (await serving(story)).mode === "review") {
        switched.set(story.name, Date.now() - begun);
        await note(`${story.name} serves its review build after ${((Date.now() - begun) / 1000).toFixed(0)} s`);
      }
    }
    await delay(8_000);
  }
  for (const story of stories) {
    await check(`${story.name}: serves a review build once no agent works on it`, switched.has(story.name), switched.has(story.name) ? `${(switched.get(story.name) / 1000).toFixed(0)} s` : (await serving(story)).command.slice(0, 200));
    const outage = outages.get(story.name);
    await check(`${story.name}: the preview kept answering while it switched`, outage.worst < 15_000, `worst outage ${(outage.worst / 1000).toFixed(1)} s, ${outage.failures} failed requests`);
    if (!switched.has(story.name)) continue;
    const page = await get(new URL(story.fixture.page.path, story.base).href, { timeoutMs: 30_000 });
    await check(`${story.name}: the review build serves the same page`, page.ok && page.status === 200 && page.body.includes(story.fixture.page.includes) || page.body.includes(story.fixture.visible?.after ?? "zzz"), `${page.status} ${page.body.slice(0, 80).replace(/\s+/g, " ")}`);
    const urlState = await readState(app, story);
    await check(`${story.name}: the url is unchanged by the switch`, urlState?.previewUrl === story.url, `${story.url} → ${urlState?.previewUrl}`);
    // A source change under a served build must bring the dev server back.
    const edit = story.fixture.edit;
    const changed = await vm(options, `cd ${sq(story.worktree)} && sed -i 's/${story.fixture.visible.after.split(" ").slice(-2).join(" ")}/${edit.to.split(" ")[0]} review-edit/' '${edit.file}'`, 60_000, "blame");
    const edited = changed.ok ? await until(async () => {
      // A single-page app's text lives in its module, not in the html.
      const response = await get(new URL(edit.served, story.base).href, { timeoutMs: 15_000 });
      return response.ok && response.body.includes("review-edit");
    }, 120_000, "the edit under a served build", 1500).then(() => true, () => false) : false;
    await check(`${story.name}: an edit under a served build shows up (back to development)`, edited, changed.ok ? "" : changed.stderr);
    if (edited) await check(`${story.name}: development server is back`, (await serving(story)).mode === "development", (await serving(story)).command.slice(0, 160));
  }
}

// Scenario: the VM dies under running previews (crash, kill, host sleep).
async function scenarioVmCrash(app, options, stories) {
  current = "vm-crash";
  const running = stories.filter((story) => story?.url);
  const stopped = await execFileAsync(`${limaBundle}/bin/limactl`, ["stop", "--force", "BlameRuntime"], { env: limaEnvironment(options.root), timeout: 120_000 }).then(() => true, () => false);
  await check("vm-crash: the VM was killed", stopped && (await vmStatus(options)) !== "Running", await vmStatus(options));
  for (const story of running) {
    const begun = Date.now();
    let state = await readState(app, story).catch((error) => ({ error: error.message }));
    await note(`${story.name} first read after the crash: ${JSON.stringify(state?.lifecycle ?? state?.error)?.slice(0, 200)}`);
    let recovered = false;
    for (let tick = 0; Date.now() - begun < 180_000; tick += 1) {
      if (tick % 15 === 0) await workspace(app, "ensureProjectPreviewUrl", { worktree: story.worktree }).catch(() => undefined);
      state = await readState(app, story).catch((error) => ({ error: error.message }));
      if (state?.lifecycle?.status === "ready" && state.previewUrl) {
        recovered = true;
        break;
      }
      await delay(2000);
    }
    if (!recovered) {
      const start = await startAndWatch(app, story, { label: "start after the VM crash", timeoutMs: 300_000 });
      await check(`${story.name}: one start brings it back after a VM crash`, start.ok, JSON.stringify(start.state?.lifecycle?.failure ?? start.error ?? ""));
      state = start.state;
    } else await note(`${story.name} recovered by itself after ${((Date.now() - begun) / 1000).toFixed(0)} s`);
    await check(`${story.name}: same url after the VM crash`, state?.previewUrl === story.url, `${story.url} → ${state?.previewUrl}`);
    const page = await until(async () => {
      const response = await get(new URL(story.fixture.page.path, story.base).href, { timeoutMs: 10_000 });
      return response.ok && response.status === 200 ? response : false;
    }, 90_000, "the page", 1500).catch(() => null);
    await check(`${story.name}: page answers after the VM crash`, Boolean(page), page ? `${page.ms} ms` : "never");
  }
}

// Scenario: the runtime VM stops once nothing used it for ten minutes; the next use wakes it.
async function scenarioRuntimeSleep(app, options, stories, { minutes = 24 } = {}) {
  current = "runtime-sleep";
  const running = stories.filter((story) => story?.url);
  const begun = Date.now();
  let stoppedAfter = null;
  while (Date.now() - begun < minutes * 60_000) {
    await delay(30_000);
    if ((await vmStatus(options)) === "Stopped") {
      stoppedAfter = Date.now() - begun;
      break;
    }
  }
  await check("runtime-sleep: the VM stops once idle", stoppedAfter !== null, stoppedAfter ? `${(stoppedAfter / 60_000).toFixed(1)} min after the last use` : `still ${await vmStatus(options)} after ${minutes} min`);
  if (stoppedAfter === null) return;
  for (const story of running) {
    const woke = Date.now();
    const state = await readState(app, story).catch((error) => ({ error: error.message }));
    await note(`${story.name} first read with the VM stopped: ${JSON.stringify(state?.lifecycle ?? state?.error)?.slice(0, 200)}`);
    const page = await until(async () => {
      const response = await get(new URL(story.fixture.page.path, story.base).href, { timeoutMs: 10_000 });
      return response.ok && response.status === 200 ? response : false;
    }, 120_000, "the page after the wake", 1500).catch(() => null);
    // A request from outside cannot wake a stopped VM (documented): the app's own read does.
    if (!page) {
      for (let tick = 0; tick < 60; tick += 1) {
        const next = await readState(app, story).catch(() => null);
        if (next?.lifecycle?.status === "ready") break;
        await delay(2000);
      }
    }
    const final = await get(new URL(story.fixture.page.path, story.base).href, { timeoutMs: 30_000 });
    await check(`${story.name}: page answers after the VM slept`, final.ok && final.status === 200, `${((Date.now() - woke) / 1000).toFixed(0)} s after the first read`);
  }
}

// Scenario: previews left alone hibernate and wake on a request.
async function scenarioIdle(app, options, stories, { minutes = 8 } = {}) {
  current = "idle";
  const running = stories.filter((story) => story?.url);
  const pausedOf = async () => {
    const out = await vm(options, "docker ps -a --format '{{.Names}} {{.State}}'");
    return out.stdout.split("\n").filter(Boolean);
  };
  const deadline = Date.now() + minutes * 60_000;
  let hibernatedAt = null;
  while (Date.now() < deadline) {
    await delay(20_000);
    const states = await pausedOf();
    const paused = states.filter((line) => line.endsWith(" paused")).length;
    const total = states.filter((line) => line.endsWith(" running") || line.endsWith(" paused")).length;
    if (paused && paused === total && !hibernatedAt) {
      hibernatedAt = Date.now();
      await note(`all ${total} containers paused after ${((Date.now() - (deadline - minutes * 60_000)) / 1000).toFixed(0)} s`);
      break;
    }
  }
  await check("idle: previews hibernate (containers paused) within the window", Boolean(hibernatedAt), hibernatedAt ? "" : (await pausedOf()).join("; "));
  const memory = await vm(options, "free -m | sed -n 2p; free -m | sed -n 3p");
  await note(`VM memory while hibernated: ${memory.stdout.replace(/\s+/g, " ")}`);
  for (const story of running) {
    const response = await get(new URL(story.fixture.page.path, story.base).href, { timeoutMs: 60_000 });
    await check(`${story.name}: wakes on a request from outside`, response.ok && response.status === 200, `${response.status} in ${response.ms} ms ${response.error ?? ""}`);
  }
}

// Scenario: something else already uses the port a stopped preview remembers.
async function scenarioPortTaken(app, options, story) {
  current = `port-taken:${story.name}`;
  const { createServer } = await import("node:net");
  await workspace(app, "controlProjectPreview", { action: "stop", worktree: story.worktree });
  await until(async () => (await readState(app, story))?.statuses?.[story.configurationId] === "stopped", 60_000, "stopped", 700).catch(() => undefined);
  const port = Number(new URL(story.url).port);
  const squatter = createServer((socket) => socket.end("HTTP/1.1 200 OK\r\ncontent-length: 8\r\n\r\nsquatter"));
  const taken = await new Promise((done) => (squatter.once("error", () => done(false)), squatter.listen(port, "127.0.0.1", () => done(true))));
  await note(`host port ${port} ${taken ? "held by this script" : "could not be held"}`);
  const restart = await startAndWatch(app, story, { label: "start with the port taken", timeoutMs: 180_000 });
  const url = restart.state?.previewUrl;
  await note(`restart result: ok=${restart.ok} url=${url} failure=${restart.state?.lifecycle?.failure?.message ?? ""}`);
  if (restart.ok && url) {
    const response = await get(new URL(story.fixture.page.path, new URL("/", url)).href, { timeoutMs: 30_000 });
    await check(`${story.name}: the preview url reaches the app, not the squatter`, response.ok && !response.body.includes("squatter") && response.status === 200, `${url} → ${response.status} ${response.body.slice(0, 60)}`);
    story.url = url;
    story.base = new URL("/", url).href;
  } else await check(`${story.name}: start with the port taken ends clearly`, !restart.timedOut, restart.state?.lifecycle?.failure?.message ?? restart.error ?? "");
  await new Promise((done) => squatter.close(done));
}

// Scenario: a dependency is added, then the preview restarts (what an agent leaves behind).
async function scenarioDependencyChange(app, options, story) {
  current = `dependency:${story.name}`;
  const edit = `cd ${sq(story.worktree)} && node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.dependencies["is-odd"] = "^3.0.1";
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\\n");
fs.appendFileSync("server.js", "import isOdd from \\"is-odd\\";\\napp.get(\\"/odd\\", (_req, res) => res.send(String(isOdd(3))));\\n");
'`;
  const edited = await vm(options, edit, 60_000, "blame");
  await check(`${story.name}: package.json and server edited`, edited.ok, edited.stderr);
  await delay(4000);
  const crashed = await get(new URL("/odd", story.base).href, { timeoutMs: 8000 });
  await note(`before a restart, /odd answers ${crashed.status} ${crashed.error ?? ""}`);
  const restart = await workspace(app, "controlProjectPreview", { action: "restart", configurationId: story.configurationId, worktree: story.worktree });
  await check(`${story.name}: restart accepted`, !restart.error, restart.error ?? "");
  const odd = await until(async () => {
    const response = await get(new URL("/odd", story.base).href, { timeoutMs: 8000 });
    return response.ok && response.status === 200 ? response : false;
  }, 180_000, "the new dependency to be installed and used", 2000).catch(() => null);
  await check(`${story.name}: restart installs the new dependency`, Boolean(odd) && odd.body === "true", odd ? odd.body : "never answered");
}

// ------------------------------------------------------------- shared setup
//
// Stories with the same dependencies share their node_modules volumes, so a
// setup task that only fills them runs once. Each project below gets two
// stories one after the other; what must happen to the second one depends on
// what the setup does. Run it with and without `BLAME_PREVIEW_SHARED_SETUP=0`
// to compare the installs; the facts go to `shared-setup.json` in --out.

/** What a start did about its setup tasks, from the story's own logs. */
async function setupFacts(options, story) {
  const read = await vm(options, `cd ${sq(story.worktree)}/.blame/logs && cat timing.jsonl 2>/dev/null; printf '\n---\n'; cat *.log 2>/dev/null`, 60_000);
  const [timing = "", log = ""] = read.stdout.split("\n---\n");
  const installs = timing.split("\n").flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry.label === "dependencies.install" ? [entry.durationMs] : [];
    } catch {
      return [];
    }
  });
  return {
    installMs: installs.reduce((sum, ms) => sum + ms, 0),
    installs: installs.length,
    ran: /Running setup /.test(log) && !/another story ran it/.test(log),
    skipped: /another story ran it/.test(log),
    wrote: /Setup \S+ also wrote ([^,\n]+)/.exec(log)?.[1] ?? null,
    unrecorded: /could not be recorded for other stories \(([^)]*)\)/.exec(log)?.[1] ?? null,
  };
}

const sharedSetupRows = [];

async function sharedSetupStart(app, options, name, label) {
  const story = await openStory(app, options, name, { variant: label });
  if (!story?.prepared) return null;
  const start = await startAndWatch(app, story, { timeoutMs: 600_000, label });
  await check(`${name} ${label}: preview ready`, start.ok, start.ok ? `${(start.ms / 1000).toFixed(1)} s` : JSON.stringify(start.state?.lifecycle?.failure ?? start.error ?? start.state?.lifecycle));
  const facts = await setupFacts(options, story);
  const row = { fixture: name, story: label, ok: start.ok, startMs: start.ms, ...facts };
  sharedSetupRows.push(row);
  await note(`${name} ${label}: ${JSON.stringify(row)}`);
  if (start.ok) {
    story.url = start.state.previewUrl;
    story.base = new URL("/", story.url).href;
    const page = await get(new URL(story.fixture.page.path, story.base).href, { timeoutMs: 60_000 });
    await check(`${name} ${label}: the page works`, page.ok && page.status === 200 && page.body.includes(story.fixture.page.includes), `${page.status} ${page.body.slice(0, 100).replace(/\s+/g, " ")}`);
  }
  return { story, start, facts };
}

async function scenarioSharedSetup(app, options) {
  current = "shared-setup";
  const sharing = process.env.BLAME_PREVIEW_SHARED_SETUP !== "0";
  await note(`shared setup is ${sharing ? "on" : "off (BLAME_PREVIEW_SHARED_SETUP=0)"}`);
  const stories = [];
  const pair = async (name) => {
    const first = await sharedSetupStart(app, options, name, "s1");
    const second = await sharedSetupStart(app, options, name, "s2");
    for (const one of [first, second]) if (one?.story) stories.push(one.story);
    return { first, second };
  };

  // Only fills node_modules: the second story must not run it.
  const plain = await pair("vite-react");
  if (plain.second?.facts)
    await check("vite-react s2: install is skipped only when shared", plain.second.facts.skipped === sharing && plain.second.facts.ran === !sharing, JSON.stringify(plain.second.facts));

  // Nuxt without a postinstall: whatever the engine decides, the page works.
  await pair("nuxt");

  // A postinstall script writes .nuxt into the worktree: every story runs it.
  const postinstall = await pair("nuxt-postinstall");
  if (postinstall.second?.facts) await check("nuxt-postinstall s2: the install runs again", postinstall.second.facts.ran && !postinstall.second.facts.skipped, JSON.stringify(postinstall.second.facts));
  const dotNuxt = postinstall.second?.story ? await vm(options, `test -d ${sq(postinstall.second.story.worktree)}/.nuxt && echo yes || echo no`) : null;
  if (dotNuxt) await check("nuxt-postinstall s2: .nuxt exists in its own worktree", dotNuxt.stdout.trim() === "yes", dotNuxt.stdout.trim());

  // Setup that generates a file (not a plain install): the second story needs it too.
  const writes = await pair("setup-writes");
  if (writes.second?.facts) await check("setup-writes s2: the setup runs again", writes.second.facts.ran && !writes.second.facts.skipped, JSON.stringify(writes.second.facts));

  // A database: the install is shared, the migration is each story's own.
  const database = await pair("express-postgres");
  if (database.second?.facts)
    await check("express-postgres s2: install is skipped only when shared", database.second.facts.skipped === sharing, JSON.stringify(database.second.facts));

  // A failed install leaves nothing a later story could trust.
  for (const label of ["s1", "s2"]) {
    const story = await openStory(app, options, "broken-install", { variant: label });
    if (!story?.prepared) continue;
    const start = await startAndWatch(app, story, { timeoutMs: 240_000, label });
    const facts = await setupFacts(options, story);
    sharedSetupRows.push({ fixture: "broken-install", story: label, ok: start.ok, startMs: start.ms, ...facts });
    await check(`broken-install ${label}: fails on the install, not skipped`, !start.ok && facts.ran && !facts.skipped, JSON.stringify(facts));
    stories.push(story);
  }

  // The volume was recreated or changed since the stamp: the install runs.
  if (sharing && plain.first?.story) {
    const project = await vm(options, `cat ${sq(plain.first.story.worktree)}/.blame/preview/project.json`);
    const volume = Object.keys(JSON.parse(project.stdout || "{}").volumeCreatedAt ?? {})[0];
    await check("vite-react: its node_modules volume is known", Boolean(volume), project.stdout.slice(0, 200));
    if (volume) {
      // An agent installed a package in a container of another story.
      const drift = await vm(options, `docker run --rm -v ${volume}:/m node:22-bookworm sh -c 'mkdir -p /m/agent-added-${runId} && echo {} > /m/agent-added-${runId}/package.json'`, 180_000);
      await check("vite-react: a package is added to the shared volume", drift.ok, drift.stderr.slice(0, 200));
      const changed = await sharedSetupStart(app, options, "vite-react", "s3-after-drift");
      if (changed) {
        stories.push(changed.story);
        await check("vite-react s3: the changed volume runs the install", changed.facts.ran && !changed.facts.skipped, JSON.stringify(changed.facts));
        const left = await vm(options, `docker run --rm -v ${volume}:/m node:22-bookworm ls /m`, 120_000);
        await note(`after the rerun, the volume ${new RegExp(`agent-added-${runId}`).test(left.stdout) ? "still holds" : "no longer holds"} the package the agent added`);
        const again = await sharedSetupStart(app, options, "vite-react", "s4-after-repair");
        if (again) {
          stories.push(again.story);
          await check("vite-react s4: stamped again after the repair, so skipped", again.facts.skipped, JSON.stringify(again.facts));
        }
      }
      // The volume is gone: nothing may claim it is filled.
      for (const story of stories.filter((entry) => entry.name === "vite-react")) await workspace(app, "removeWorktree", { repositoryRoot: story.project, workspaceMode: "local-container", worktree: story.worktree });
      await delay(3000);
      // Containers of earlier stories may still mount it.
      await vm(options, `docker ps -aq --filter volume=${volume} | xargs -r docker rm -f`, 120_000);
      const removed = await vm(options, `docker volume rm ${volume}`);
      await check("vite-react: the shared volume is removed", removed.ok, removed.stderr.slice(0, 200));
      const recreated = await sharedSetupStart(app, options, "vite-react", "s5-new-volume");
      if (recreated) {
        stories.push(recreated.story);
        await check("vite-react s5: a recreated volume runs the install", recreated.facts.ran && !recreated.facts.skipped, JSON.stringify(recreated.facts));
      }
    }
  }
  const median = (values) => (values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null);
  await note(`dependencies.install per story: ${sharedSetupRows.map((row) => `${row.fixture}/${row.story} ${row.installMs} ms`).join(", ")}`);
  await note(`median install ${median(sharedSetupRows.filter((row) => row.ok).map((row) => row.installMs))} ms over ${sharedSetupRows.filter((row) => row.ok).length} starts`);
  await writeFile(join(outDirectory, "shared-setup.json"), JSON.stringify({ sharing, rows: sharedSetupRows }, null, 2));
  return stories;
}

// ----------------------------------------------------------------------- cloud
//
// Cloud Preview against the production API, with the account of the person
// who ran the campaign. The app under test is signed in by a copy of the
// Local Storage of an installed app (`--session-from`): the session token is
// only ever read by the page, never printed. Every sandbox the campaign makes
// is destroyed and every story deleted, also when a scenario fails.

const cloudApi = "https://api.blame.so/api/v1";
const cloudSessions = new Map();

/** Calls the account API from the page with the app's own session. */
async function account(app, path, method = "GET", body) {
  return app.cdp.evaluate(`(async () => {
    const session = JSON.parse(localStorage.getItem("blame.app.cloud-session.v1") || "null");
    if (!session) return { status: 0, error: "no session" };
    try {
      const response = await fetch(${JSON.stringify(cloudApi + path)}, {
        method: ${JSON.stringify(method)},
        headers: { Accept: "application/json", Authorization: "Bearer " + session.token, "Content-Type": "application/json" },
        body: ${body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body))},
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: response.status, json, text: json ? undefined : text.slice(0, 300) };
    } catch (error) {
      return { status: 0, error: String(error && error.message || error) };
    }
  })()`);
}

function recordOf(json) {
  if (Array.isArray(json?.transformerData)) return recordOf(json.transformerData[0]);
  if (json && typeof json === "object" && "data" in json) return recordOf(json.data);
  return json;
}

/** Calls `window.blame.previewRuntime.<method>(input)`; returns the value or `{ error }`. */
async function runtimeCall(app, method, input) {
  return app.cdp.evaluate(`(async () => {
    try {
      return { value: await window.blame.previewRuntime.${method}(${input === undefined ? "" : JSON.stringify(input)}) ?? null };
    } catch (error) {
      return { error: String(error && error.message || error) };
    }
  })()`);
}

const viewState = (view) => `${view?.state?.host}/${view?.state?.engine}/${view?.state?.preview}/${view?.state?.sync}`;

/** Whether the app under test opened a project workspace: the person's own, in an account session. */
async function workspaceWindowOpen(port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json(), () => []);
  return targets.some((target) => target.type === "page" && /window-role=workspace/.test(target.url));
}

async function cloudSetup(app, port) {
  current = "cloud:setup";
  await delay(12_000);
  const opened = await workspaceWindowOpen(port);
  await check("cloud: the test app did not open a workspace of the account", !opened, opened ? "a workspace window opened: stopping before it touches real stories" : "");
  if (opened) return undefined;
  const signedIn = await app.cdp.evaluate(`Boolean(localStorage.getItem("blame.app.cloud-session.v1"))`);
  await check("cloud: the test app holds an account session", signedIn, signedIn ? "" : "no session in the copied Local Storage: sign in the installed app first");
  if (!signedIn) return undefined;
  const connected = await app.cdp.evaluate(`(async () => {
    const session = JSON.parse(localStorage.getItem("blame.app.cloud-session.v1"));
    return window.blame.previewRuntime.configure({ url: ${JSON.stringify(cloudApi)}, token: session.token });
  })()`).catch((error) => String(error));
  await check("cloud: the preview runtime is connected to the production API", connected === true, String(connected));
  const reachable = await account(app, "/projects");
  await check("cloud: the account API accepts the session", reachable.status === 200, `HTTP ${reachable.status} ${reachable.error ?? reachable.text ?? ""}`);
  if (reachable.status !== 200) return undefined;
  const projectName = "[campaign] preview tests";
  const projects = recordOf(reachable.json);
  const existing = Array.isArray(projects) ? projects.find((project) => project.name === projectName) : undefined;
  if (existing?.id) {
    await check("cloud: reusing the campaign project", true);
    return { projectId: existing.id };
  }
  const project = await account(app, "/projects", "POST", { name: projectName, repositoryFingerprint: null });
  const projectId = recordOf(project.json)?.id;
  await check("cloud: a test project exists in the account", Boolean(projectId), `HTTP ${project.status}`);
  return projectId ? { projectId } : undefined;
}

/** Destroys the sandbox of a session and waits for it to be gone. */
async function destroyCloudSession(app, sessionId) {
  const done = await runtimeCall(app, "command", { sessionId, command: { type: "destroy-host" }, operationId: crypto.randomUUID() });
  const gone = await until(async () => {
    const view = await runtimeCall(app, "get", { sessionId });
    if (view.error) return /not found|404/i.test(view.error);
    return ["destroyed", "unprovisioned"].includes(view.value?.state?.host);
  }, 180_000, "the sandbox to be destroyed", 4000).then(() => true, () => false);
  return { requested: !done.error, gone, error: done.error };
}

async function scenarioCloud(app, options, setup, name) {
  current = `cloud:${name}`;
  const fixture = fixtures[name];
  const project = await writeFixture(options.projects, name);
  const initialization = await fixtureSetup(options, name, project);
  const storyTitle = `[campaign] cloud ${name}`;
  const storyResponse = await account(app, "/projects/user-stories", "POST", {
    projectId: setup.projectId,
    title: storyTitle,
    summary: "Created by the preview campaign: safe to delete.",
    status: "backlog",
    runMode: "vercel-compose",
  });
  const storyId = recordOf(storyResponse.json)?.id;
  await check(`${name}: test story created`, Boolean(storyId), `HTTP ${storyResponse.status} ${storyResponse.text ?? ""}`);
  if (!storyId) return;
  const entry = { storyId, sessionId: null };
  cloudSessions.set(storyId, entry);
  try {
    const made = await workspace(app, "createWorktree", { repositoryRoot: project, runtimeProfile: "vercel-compose", storyId, storyReference: `CMP-${runId}-c${++counter}`, title: `Campaign cloud ${name}` });
    await check(`${name}: cloud worktree`, !made.error && made.value?.workspaceMode === "cloud-mirror", made.error ?? JSON.stringify(made.value));
    if (made.error) return;
    const worktree = made.value.worktree;
    const configuration = initialization.runConfigurations[0];
    const prepared = await workspace(app, "prepareProjectPreview", { worktree, previewManifest: initialization.previewManifest, runConfigurations: initialization.runConfigurations, runConfigurationId: configuration.id, hostDependenciesChecked: true, runtimeProfile: "vercel-compose", databaseMode: null });
    await check(`${name}: prepare cloud preview`, !prepared.error, prepared.error ?? "");
    if (prepared.error) return;
    const manifestText = (await workspace(app, "readFile", { root: worktree, path: ".blame/initialization/preview-manifest.json" })).value;
    const begun = Date.now();
    const transitions = [];
    const record = (view) => {
      const key = `${viewState(view)}${view?.failure ? ` failure ${view.failure.code ?? ""} ${view.failure.message ?? ""}` : ""}`;
      if (transitions.at(-1)?.key !== key) transitions.push({ at: Date.now() - begun, key });
    };
    const created = await runtimeCall(app, "create", { userStoryId: storyId, profile: "vercel-compose", previewManifest: JSON.parse(manifestText), cloudUploadConsentAt: new Date().toISOString(), operationId: crypto.randomUUID(), localPath: worktree });
    await check(`${name}: session created`, !created.error, created.error ?? `${created.value?.id} ${viewState(created.value)}`);
    if (created.error) return;
    entry.sessionId = created.value.id;
    const sessionId = entry.sessionId;
    record(created.value);
    let view = created.value;
    if (view.state.host !== "running" || view.desired.host !== "active") {
      const resumed = await runtimeCall(app, "command", { sessionId, command: { type: "resume-host" }, operationId: crypto.randomUUID() });
      if (resumed.error) return void (await check(`${name}: resume host`, false, resumed.error));
      view = resumed.value;
      record(view);
    }
    const imported = await runtimeCall(app, "syncIn", { sessionId, localPath: worktree });
    await check(`${name}: source uploaded to the sandbox`, !imported.error, imported.error ?? `${imported.value?.sourceRevision}`);
    if (imported.error) return;
    const previewService = configuration.previewService;
    const endpoint = initialization.previewManifest.services.find((service) => service.id === previewService)?.endpoints?.find((candidate) => candidate.protocol === "http");
    const started = await runtimeCall(app, "command", { sessionId, command: { type: "start-services", configurationId: configuration.id, serviceIds: configuration.services, primaryRoute: endpoint ? { serviceId: previewService, endpointId: endpoint.id } : undefined }, operationId: crypto.randomUUID() });
    await check(`${name}: start-services accepted`, !started.error, started.error ?? "");
    if (started.error) return;
    const outcome = await until(async () => {
      const current = await runtimeCall(app, "get", { sessionId });
      if (current.error) return { error: current.error };
      record(current.value);
      view = current.value;
      if (view.failure || view.state.engine === "failed" || view.state.host === "failed") return { failed: true };
      return view.state.preview === "ready" && view.state.engine === "running" ? { ready: true } : false;
    }, 600_000, `${name} cloud preview`, 3000).catch((error) => ({ timedOut: error.message }));
    await note(`${name} cloud timeline: ${transitions.map((item) => `${(item.at / 1000).toFixed(0)}s ${item.key}`).join(" | ")}`);
    const ms = Date.now() - begun;
    if (fixture.expectFailure || name === "go-http") {
      await check(`${name}: cloud start outcome`, Boolean(outcome.failed) || Boolean(outcome.ready), outcome.ready ? `ready in ${(ms / 1000).toFixed(0)} s` : `failed: ${view.failure?.message ?? ""}`.slice(0, 600));
      if (!outcome.ready) return;
    } else {
      await check(`${name}: cloud preview ready`, Boolean(outcome.ready), outcome.ready ? `${(ms / 1000).toFixed(0)} s` : `${JSON.stringify(outcome)} ${view.failure?.message ?? ""} ${viewState(view)}`.slice(0, 800));
      if (!outcome.ready) return;
    }
    if (fixture.visible) {
      const route = view.endpointMap?.routes.find((route) => route.routeId === view.endpointMap.primaryRouteId);
      if (route?.publicUrl) {
        const url = new URL(fixture.visible.path ?? fixture.page.path, route.publicUrl).href;
        await checkEmbeddedPreview(app, { name, storyId, url }, sessionId);
      }
    }
    const ticket = await account(app, `/preview-sessions/${sessionId}/access-ticket`, "POST", {});
    const ticketBody = recordOf(ticket.json);
    await check(`${name}: access ticket issued`, ticket.status === 200 && ticketBody?.openUrl, `HTTP ${ticket.status} ${ticket.text ?? ""}`);
    if (!ticketBody?.openUrl) return;
    let browser;
    try {
      browser = await openBrowser(options, ticketBody.openUrl, { ticket: ticketBody.ticket });
      const first = browser.first;
      const expected = fixture.visible?.before ?? fixture.page.includes;
      let text = first;
      if (fixture.page.path !== "/" && !fixture.visible) {
        await browser.goto?.(fixture.page.path);
        text = await browser.text();
      }
      await check(`${name}: the cloud page loads in a browser`, text.text.includes(expected) || text.html > 0 && text.text.includes(fixture.page.includes), `${first.loadMs} ms at ${new URL(first.url).origin}: ${text.text.slice(0, 120).replace(/\s+/g, " ")}`);
      await check(`${name}: no console error or failed request`, first.errors.length === 0 && first.failedRequests.length === 0, [...first.errors, ...first.failedRequests].join(" | "));
      if (fixture.browserFlow) await verifyBrowserFlow(browser, name, fixture.browserFlow);
      // What the sandbox's own services printed, for the report (the stream ends when aborted).
      const logs = await app.cdp.evaluate(`(async () => {
        const session = JSON.parse(localStorage.getItem("blame.app.cloud-session.v1"));
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 6000);
        let text = "";
        try {
          const response = await fetch(${JSON.stringify(`${cloudApi}/preview-sessions/${sessionId}/logs`)}, { headers: { Authorization: "Bearer " + session.token, Accept: "text/event-stream" }, signal: controller.signal });
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
        } catch {}
        return text.slice(-20000);
      })()`).catch(() => "");
      await writeFile(join(outDirectory, `cloud-logs-${name}.txt`), logs).catch(() => undefined);
      if (fixture.edit && !fixture.edit.skipEdit) {
        const begunEdit = Date.now();
        if (options.scriptedAgents) {
          await editFixture(worktree, fixture.edit, { projectId: setup.projectId, storyId, title: storyTitle });
          await check(`${name}: the story agent wrote the expected change`, true, `${Date.now() - begunEdit} ms`);
        } else {
          const path = join(worktree, fixture.edit.file);
          const source = await readFile(path, "utf8");
          await writeFile(path, source.replace(fixture.edit.from, fixture.edit.to));
        }
        const after = fixture.visible?.after ?? fixture.edit.includes;
        const seen = await until(async () => {
          const answer = fixture.visible?.hot ? await browser.text() : await browser.reload();
          return answer.text.includes(after) ? answer : false;
        }, 120_000, "the local edit in the cloud preview", fixture.visible?.hot ? 1500 : 4000).then(() => true, () => false);
        await check(`${name}: the ${options.scriptedAgents ? "agent's" : "local"} edit reaches the cloud preview`, seen, seen ? `${((Date.now() - begunEdit) / 1000).toFixed(1)} s` : "not within 120 s");
        if (!seen && fixture.visible?.hot) {
          const refreshed = await browser.reload();
          await check(`${name}: the cloud preview shows the edit after reload`, refreshed.text.includes(after), refreshed.text.slice(0, 150));
        }
        const status = await runtimeCall(app, "syncStatus", { sessionId });
        await note(`${name} sync status after the edit: ${JSON.stringify(status.value ?? status.error)?.slice(0, 300)}`);
      }
    } catch (error) {
      await check(`${name}: browser check`, false, error.message);
    } finally {
      await browser?.close();
    }
    // Stop and start again: the edit must survive.
    const stopped = await runtimeCall(app, "command", { sessionId, command: { type: "stop-services" }, operationId: crypto.randomUUID() });
    const down = await until(async () => {
      const current = await runtimeCall(app, "get", { sessionId });
      return current.value && !["running", "starting"].includes(current.value.state.engine) ? current.value : false;
    }, 120_000, "services stopped", 3000).catch(() => null);
    await check(`${name}: stop-services`, !stopped.error && Boolean(down), stopped.error ?? viewState(down));
    const restartedAt = Date.now();
    const again = await runtimeCall(app, "command", { sessionId, command: { type: "start-services", configurationId: configuration.id, serviceIds: configuration.services, primaryRoute: endpoint ? { serviceId: previewService, endpointId: endpoint.id } : undefined }, operationId: crypto.randomUUID() });
    const back = again.error ? null : await until(async () => {
      const current = await runtimeCall(app, "get", { sessionId });
      if (current.value?.failure) return { failed: current.value.failure };
      return current.value?.state.preview === "ready" && current.value.state.engine === "running" ? { ready: true } : false;
    }, 300_000, "restart", 3000).catch(() => null);
    await check(`${name}: restart after stop`, Boolean(back?.ready), back?.ready ? `${((Date.now() - restartedAt) / 1000).toFixed(0)} s` : JSON.stringify(again.error ?? back));
    if (back?.ready && fixture.browserFlow && fixture.edit) {
      const reopen = recordOf((await account(app, `/preview-sessions/${sessionId}/access-ticket`, "POST", {})).json);
      let restartedBrowser;
      try {
        if (!reopen?.ticket || !reopen?.openUrl) throw new Error("No access ticket for the restarted preview");
        restartedBrowser = await openBrowser(options, reopen.openUrl, { ticket: reopen.ticket });
        await check(`${name}: restarted preview still shows the change`, restartedBrowser.first.text.includes(fixture.visible.after), restartedBrowser.first.text);
      } finally {
        await restartedBrowser?.close();
      }
    }
  } finally {
    let gone = !entry.sessionId;
    if (entry.sessionId) {
      const usage = (await runtimeCall(app, "get", { sessionId: entry.sessionId })).value?.usage;
      if (usage) await note(`${name} sandbox usage: ${usage.activeSeconds} s active, about $${Number(usage.estimatedCostUsd).toFixed(4)}`);
      const destroyed = await destroyCloudSession(app, entry.sessionId);
      gone = destroyed.gone;
      await check(`${name}: sandbox destroyed afterwards`, destroyed.gone, destroyed.error ?? "");
    }
    const deleted = await account(app, `/projects/user-stories/${storyId}`, "DELETE");
    await check(`${name}: test story deleted`, deleted.status >= 200 && deleted.status < 300, `HTTP ${deleted.status}`);
    if (gone && deleted.status >= 200 && deleted.status < 300) cloudSessions.delete(storyId);
  }
}

async function runCloud(ctx, options) {
  const cloudNames = (options.only ?? ["vite-react", "next-app", "express-postgres", "go-http"]).filter((name) => fixtures[name]);
  const setup = await cloudSetup(ctx.app, ctx.port);
  if (!setup) return;
  try {
    for (const name of cloudNames) await guarded(`cloud ${name}`, () => scenarioCloud(ctx.app, options, setup, name));
  } finally {
    // Whatever failed above, no sandbox stays billed.
    for (const [storyId, entry] of cloudSessions) {
      if (entry.sessionId) await destroyCloudSession(ctx.app, entry.sessionId).catch(() => undefined);
      await account(ctx.app, `/projects/user-stories/${storyId}`, "DELETE").catch(() => undefined);
    }
  }
}

// ----------------------------------------------------------------------- main

const healthy = ["vite-react", "next-app", "next-healthpath", "express-api", "express-postgres", "flask-redis", "web-api-binding", "env-file", "pnpm-monorepo", "astro", "sveltekit", "nuxt", "go-http", "php-builtin", "next-heavy"];
const edge = ["odd-path", ...Object.keys(fixtures).filter((name) => name.startsWith("odd-path-")), "odd-title", "develop-branch", "master-branch", "yarn-app", "next-prisma-mysql", "big-repo"];
const failing = ["broken-install", "crash-on-start", "wrong-port", "loopback-only", "probe-fails"];

async function drive() {
  const options = parseOptions(process.argv.slice(2));
  outDirectory = options.out;
  await mkdir(options.out, { recursive: true });
  await rm(join(options.out, "campaign.log"), { force: true });
  if (options.fresh) {
    await execFileAsync(`${limaBundle}/bin/limactl`, ["delete", "--force", "BlameRuntime"], { env: limaEnvironment(options.root) }).catch(() => undefined);
    await rm(options.root, { force: true, recursive: true });
  }
  await mkdir(options.root, { recursive: true });
  if (!options.cloud) await prepareRuntimeHome(options);
  await rm(options.projects, { force: true, recursive: true });
  const port = 9500 + Math.floor(Math.random() * 300);
  await log(`campaign starts: root ${options.root}, debug port ${port}`);
  const ctx = { app: null, port };
  try {
    if (options.cloud) {
      // A profile of its own, signed in by a copy of the account's Local Storage.
      const profile = join(options.root, "cloud-profile");
      await rm(profile, { force: true, recursive: true });
      await mkdir(profile, { recursive: true });
      await cp(join(options.sessionFrom, "Local Storage"), join(profile, "Local Storage"), { recursive: true });
      const page = join(options.root, "blank.html");
      await writeFile(page, "<!doctype html><title>blank</title>");
      const electron = createRequire(import.meta.url)("electron");
      const cleanEnvironment = { ...process.env, CAMPAIGN_CLEAN_SESSION: page };
      delete cleanEnvironment.ELECTRON_RUN_AS_NODE;
      const cleaned = await new Promise((done) => {
        const child = spawn(electron, [fileURLToPath(import.meta.url), profile], { env: cleanEnvironment, stdio: ["ignore", "pipe", "pipe"] });
        let text = "";
        child.stdout.on("data", (data) => (text += data));
        child.on("exit", () => done(text));
        setTimeout(() => child.kill("SIGKILL"), 30_000).unref();
      });
      await log(`session cleaned: ${/CAMPAIGN_SESSION (.*)/.exec(cleaned)?.[1] ?? "no answer"}`);
      ctx.app = await launch(options, port, { profile: "cloud-profile", projectWindow: false });
      await runCloud(ctx, options);
    } else {
      ctx.app = await launch(options, port);
      await run(ctx, options);
    }
  } catch (error) {
    results.push({ scenario: current, name: "campaign aborted", ok: false, detail: String(error.stack ?? error) });
    await log(`ABORT [${current}] ${error.stack ?? error}`);
    process.exitCode = 1;
  } finally {
    await writeFile(join(outDirectory, "results.json"), JSON.stringify(results, null, 2)).catch(() => undefined);
    if (options.keep && ctx.app?.child?.exitCode === null) {
      await log(`--keep: app left open on port ${port}; send SIGTERM to this process to end`);
      await new Promise((done) => process.once("SIGTERM", done));
    }
    if (ctx.app) await quit(ctx.app);
    // The copy of the account session does not outlive the run.
    if (options.cloud) await rm(join(options.root, "cloud-profile"), { force: true, recursive: true }).catch(() => undefined);
    const failed = results.filter((entry) => !entry.ok);
    await log(`campaign done: ${results.length - failed.length}/${results.length} checks passed`);
    process.exit(process.exitCode ?? (failed.length ? 1 : 0));
  }
}

async function guarded(label, action) {
  try {
    return await action();
  } catch (error) {
    await check(`${label}: scenario error`, false, error.stack ?? error.message);
    return null;
  }
}

async function run(ctx, options) {
  const wants = (name) => !options.only || options.only.includes(name) || options.only.some((entry) => name.startsWith(entry));
  // --- the runtime itself
  current = "runtime";
  if (wants("runtime")) {
    const before = await vmStatus(options);
    await note(`runtime VM before: ${before}`);
    const begun = Date.now();
    await ctx.app.cdp.evaluate(`(async () => { window.__progress = []; try { window.__report = await window.blame.workspace.ensureRuntimeReady((p) => window.__progress.push(JSON.stringify(p))); } catch (error) { window.__report = { error: String(error && error.message || error) }; } window.__done = true; })()`).catch(() => undefined);
    const report = await ctx.app.cdp.evaluate(`({ done: window.__done, report: window.__report })`);
    await check("runtime: ensureRuntimeReady completes", report.done && !report.report?.error, `${((Date.now() - begun) / 1000).toFixed(0)} s ${JSON.stringify(report.report)?.slice(0, 300)}`);
    await check("runtime: VM running afterwards", (await vmStatus(options)) === "Running", await vmStatus(options));
    const docker = await vm(options, "docker version --format '{{.Server.Version}}' && docker compose version --short && nproc && free -m | sed -n 2p && df -h / | tail -1");
    await note(`docker/compose/cpu/mem/disk: ${docker.stdout.replace(/\n/g, " | ")}`);
  }
  const stories = {};
  // --- the healthy projects, one at a time (a cold VM would otherwise swap)
  for (const name of healthy) {
    if (!wants(name) && !wants("healthy")) continue;
    stories[name] = await guarded(name, () => scenarioHealthy(ctx.app, options, name));
  }
  for (const name of edge) {
    if (!wants(name) && !wants("edge")) continue;
    stories[name] = await guarded(name, () => scenarioHealthy(ctx.app, options, name));
  }
  for (const name of Object.keys(advancedFixtures)) {
    if (!wants(name) && !wants("advanced")) continue;
    stories[name] = await guarded(name, () => scenarioHealthy(ctx.app, options, name));
  }
  for (const name of failing) {
    if (!wants(name) && !wants("failing")) continue;
    stories[name] = await guarded(name, () => scenarioFailure(ctx.app, options, name));
  }
  if (wants("slow-start") || wants("failing")) stories["slow-start"] = await guarded("slow-start", () => scenarioSlow(ctx.app, options, "slow-start"));
  // --- lifecycle, ports and dependency changes on running ones
  if (wants("lifecycle"))
    for (const name of ["vite-react", "next-app", "express-api", ...Object.keys(advancedFixtures)]) if (stories[name]?.url) await guarded(name, () => scenarioLifecycle(ctx.app, options, stories[name]));
  if (wants("isolation")) await guarded("isolation", () => scenarioIsolation(ctx.app, options, stories["django-celery"]));
  if (wants("migration-recovery")) await guarded("migration-recovery", () => scenarioMigrationRecovery(ctx.app, options));
  if (wants("port-taken") && stories["express-api"]?.url) await guarded("port-taken", () => scenarioPortTaken(ctx.app, options, stories["express-api"]));
  if (wants("edits")) for (const name of ["vite-react", "next-app"]) if (stories[name]?.url) await guarded(`edits-${name}`, () => scenarioEdits(ctx.app, options, stories[name]));
  if (wants("review-build")) {
    const targets = ["next-app", "vite-react"].map((name) => stories[name]).filter((story) => story?.url && story.fixture.visible);
    if (targets.length) await guarded("review-build", () => scenarioReviewBuild(ctx.app, options, targets));
  }
  if (wants("dependency") && stories["express-api"]?.url) await guarded("dependency", () => scenarioDependencyChange(ctx.app, options, stories["express-api"]));
  if (wants("shared-setup")) await guarded("shared-setup", () => scenarioSharedSetup(ctx.app, options));
  // --- several stories at once
  if (wants("parallel")) {
    await guarded("parallel-heavy", () => scenarioParallel(ctx.app, options, ["next-heavy", "next-heavy", "next-heavy"], "heavy"));
    await guarded("parallel-mixed", () => scenarioParallel(ctx.app, options, ["vite-react", "next-app", "express-postgres", "flask-redis", "pnpm-monorepo"], "mixed"));
  }
  // --- the app quits while previews run
  if (wants("app-restart")) {
    const running = Object.values(stories).filter((story) => story?.url);
    if (running.length) await guarded("app-restart", () => scenarioAppRestart(ctx, options, running.slice(0, 4), ctx.port));
  }
  if (wants("vm-crash")) {
    const running = ["vite-react", "express-api"].map((name) => stories[name]).filter((story) => story?.url);
    if (running.length) await guarded("vm-crash", () => scenarioVmCrash(ctx.app, options, running));
  }
  if (wants("runtime-sleep")) {
    const running = ["vite-react", "express-api"].map((name) => stories[name]).filter((story) => story?.url);
    if (running.length) await guarded("runtime-sleep", () => scenarioRuntimeSleep(ctx.app, options, running));
  }
  // --- previews left alone
  if (wants("idle")) {
    const running = Object.values(stories).filter((story) => story?.url);
    if (running.length) await guarded("idle", () => scenarioIdle(ctx.app, options, running.slice(0, 4)));
  }
  if (wants("remove"))
    for (const [name, story] of Object.entries(stories)) if (story?.worktree) await guarded(name, () => scenarioRemove(ctx.app, options, story));
}

// ------------------------------------------------------------- inside Electron

/**
 * Keeps only the account session in a copied Local Storage: the rest (recent
 * projects, last route) would make the app reopen the person's own workspace.
 * It runs in a page of its own, so the token never reaches this script.
 */
async function cleanSession(profile, page) {
  const { app, BrowserWindow } = await import("electron");
  app.setPath("userData", profile);
  app.dock?.hide();
  // Not awaited: an ESM entry that awaits `ready` at top level never starts the app.
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false });
    await window.loadURL(pathToFileURL(page).href);
    const result = await window.webContents.executeJavaScript(`(() => {
      const key = "blame.app.cloud-session.v1";
      const value = localStorage.getItem(key);
      const others = localStorage.length - (value === null ? 0 : 1);
      localStorage.clear();
      if (value !== null) localStorage.setItem(key, value);
      return { session: value !== null, removedKeys: others };
    })()`);
    console.log(`CAMPAIGN_SESSION ${JSON.stringify(result)}`);
    // Chromium flushes Local Storage to disk a moment after a write.
    await delay(1500);
    window.destroy();
    app.exit(0);
  });
}

async function inElectron() {
  const profile = process.argv.at(-1);
  if (process.env.CAMPAIGN_CLEAN_SESSION) return cleanSession(profile, process.env.CAMPAIGN_CLEAN_SESSION);
  const { app, BrowserWindow } = await import("electron");
  for (const name of ["appData", "userData", "sessionData"]) app.setPath(name, profile);
  app.setAppLogsPath(join(profile, "logs"));
  app.getAppPath = () => application;
  app.setAsDefaultProtocolClient = () => false;
  app.commandLine.appendSwitch("remote-debugging-port", process.env.CAMPAIGN_PORT);
  process.env.LIMA_HOME = join(process.env.CAMPAIGN_ROOT, "lima");
  process.env.BLAME_CLOUD_WORKTREE_ROOT = join(process.env.CAMPAIGN_ROOT, "cloud-worktrees");
  const fail = (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    app.exit(1);
  };
  // The app logs an unhandled rejection and goes on: so does the campaign.
  process.once("uncaughtException", fail);
  process.on("unhandledRejection", (reason) => console.error(`[unhandledRejection] ${reason instanceof Error ? reason.stack : String(reason)}`));
  void app.whenReady().then(prepare).catch(fail);

  async function prepare() {
    // A fresh profile shows the provider onboarding: the workspace API is
    // exposed there too, which is all the campaign needs.
    await windowShowing(BrowserWindow, "");
    console.log("CAMPAIGN_READY");
  }
  await import(pathToFileURL(join(application, "out/main/index.js")).href);
}

async function windowShowing(BrowserWindow, text, timeoutMs = 90_000) {
  const check = `document.readyState === "complete" && Boolean(document.body?.innerText.includes(${JSON.stringify(text)})) && Boolean(window.blame?.workspace)`;
  const begun = Date.now();
  while (Date.now() - begun < timeoutMs) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isLoading()) continue;
      if (await window.webContents.executeJavaScript(check).catch(() => false)) return window;
    }
    await delay(100);
  }
  throw new Error(`No window showed "${text}"`);
}

if (process.versions.electron) await inElectron();
else await drive();
