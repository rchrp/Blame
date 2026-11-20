// Measures what the desktop main process costs from launch to the backlog and
// through the first agent request, on the built app (out/), with its own
// profile and no Blame Runtime:
//
//   pnpm --filter @blame/desktop exec electron-vite build
//   node scripts/main-process-bench.mjs [--rounds 5] [--out results.json] \
//     [--modules] [application ...]
//
// Each application is a directory holding an out/ build (default: this
// package); several are launched in turn every round, so their timings share
// the Mac's load. A first launch prepares a profile (local workspace, AI
// preferences, one project in a scratch folder) that every measured launch
// copies, so each one opens straight on the backlog. The MCP settings (in
// the app's data folder) and the Lima home stay in that profile too. It reports, per launch: the time to
// the first window and to the backlog; the main process and renderer
// footprints 3 s after the backlog shows; the engine host, which the
// backlog starts: when it was started, how long it took to load and to
// answer its first request, and its footprint; how long a `running` call
// then takes; and the main process footprint after it. With
// --modules it also lists the modules the main process loaded (slower:
// compare its timings only with another --modules run).
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const resultPrefix = "MAIN_PROCESS_BENCH ";

if (process.versions.electron) await runInElectron();
else await runBench();

async function runBench() {
  const options = parseOptions(process.argv.slice(2));
  const scratch = await mkdtemp(join(tmpdir(), "blame-main-process-bench-"));
  const results = [];
  try {
    const template = join(scratch, "template");
    await prepareProject(join(scratch, "project"));
    await launch(options.applications[0], template, "prepare", scratch);
    for (let round = 1; round <= options.rounds; round += 1) {
      for (const application of options.applications) {
        const profile = join(scratch, `profile-${round}`);
        await cp(template, profile, { recursive: true });
        const mode = options.modules ? "modules" : "measure";
        const result = await launch(application, profile, mode, scratch);
        await assertNoRuntime(profile);
        await rm(profile, { force: true, recursive: true });
        results.push({ application, round, ...result });
        console.log(JSON.stringify({ application, round, ...result }));
      }
    }
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
  const summary = summarize(results);
  console.table(summary);
  if (options.out)
    await writeFile(
      options.out,
      `${JSON.stringify({ options, results, summary }, null, 2)}\n`,
    );
}

function parseOptions(argv) {
  const options = { applications: [], modules: false, rounds: 5 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--rounds") options.rounds = Number(argv[++index]);
    else if (argument === "--out") options.out = resolve(argv[++index]);
    else if (argument === "--modules") options.modules = true;
    else options.applications.push(resolve(argument));
  }
  if (!options.applications.length)
    options.applications.push(resolve(import.meta.dirname, ".."));
  return options;
}

async function prepareProject(directory) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "bench-project", version: "1.0.0" })}\n`,
  );
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: directory });
}

function launch(application, profile, mode, scratch) {
  const electron = createRequire(import.meta.url)("electron");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_RENDERER_URL;
  // The app must not reach the person's Blame Runtime.
  delete environment.BLAME_RUNTIME_BIN_DIR;
  environment.MAIN_PROCESS_BENCH_LAUNCHED_AT = String(Date.now());
  const args = [
    fileURLToPath(import.meta.url),
    mode,
    application,
    profile,
    scratch,
  ];
  return new Promise((resolveRun, reject) => {
    const child = spawn(electron, args, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => {
        output = (output + data).slice(-200_000);
        if (process.env.MAIN_PROCESS_BENCH_DEBUG) process.stderr.write(data);
      });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      const line = output
        .split("\n")
        .find((entry) => entry.startsWith(resultPrefix));
      if (code === 0 && line)
        resolveRun(JSON.parse(line.slice(resultPrefix.length)));
      else
        reject(
          new Error(
            `Bench launch failed (${signal || code}):\n${output.slice(-5_000)}`,
          ),
        );
    });
  });
}

// No virtual machine may have been created in the launch's own Lima home.
async function assertNoRuntime(profile) {
  const instances = await readdir(join(profile, "lima")).catch(() => []);
  const created = instances.filter((name) => !name.startsWith("_"));
  if (created.length)
    throw new Error(`A launch created a runtime: ${created.join(", ")}`);
}

function summarize(results) {
  const keys = [
    "windowMs",
    "backlogMs",
    "mainFootprintMiB",
    "rendererFootprintMiB",
    "workersAtBacklog",
    "workerForkMs",
    "workerReadyMs",
    "workerFirstResponseMs",
    "sessionsListMs",
    "mainAfterAgentMiB",
    "workerFootprintMiB",
    "mainModules",
  ];
  const byApplication = Map.groupBy(results, (result) => result.application);
  return Object.fromEntries(
    [...byApplication].map(([application, entries]) => [
      application,
      Object.fromEntries(
        keys
          .filter((key) => entries.some((entry) => entry[key] !== undefined))
          .map((key) => [key, median(entries.map((entry) => entry[key]))]),
      ),
    ]),
  );
}

function median(values) {
  const sorted = values
    .filter((value) => value !== undefined)
    .sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10;
}

async function runInElectron() {
  const launchedAt = Number(process.env.MAIN_PROCESS_BENCH_LAUNCHED_AT);
  const [mode, application, profile, scratch] = process.argv.slice(-4);
  const modules = new Set();
  if (mode === "modules")
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context);
        modules.add(result.url);
        return result;
      },
    });
  const { app, BrowserWindow, dialog, utilityProcess } =
    await import("electron");
  const marks = {};
  const mark = (name) => {
    marks[name] ??= Date.now() - launchedAt;
  };
  // The engine host: when the app starts it, when it has loaded and when it
  // answers its first request.
  const worker = {};
  const fork = utilityProcess.fork;
  utilityProcess.fork = (modulePath, ...rest) => {
    const child = fork.call(utilityProcess, modulePath, ...rest);
    if (modulePath.endsWith("engine-host-process.js") && !worker.child) {
      worker.child = child;
      worker.forkedAt = performance.now();
      mark("workerForkMs");
      child.on("message", (message) => {
        const elapsed = Math.round(performance.now() - worker.forkedAt);
        if (message?.kind === "ready") worker.readyMs ??= elapsed;
        if (message?.kind === "response") worker.firstResponseMs ??= elapsed;
      });
    }
    return child;
  };
  for (const name of ["appData", "userData", "sessionData"])
    app.setPath(name, profile);
  app.setAppLogsPath(join(profile, "logs"));
  app.getAppPath = () => application;
  app.setAsDefaultProtocolClient = () => false;
  process.env.LIMA_HOME = join(profile, "lima");
  process.env.BLAME_WSL_DISTRO = "BlameMainProcessBench";
  const fail = (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    app.exit(1);
  };
  process.once("uncaughtException", fail);
  process.once("unhandledRejection", fail);
  setTimeout(() => fail(new Error("Bench launch timed out")), 100_000);
  // The app replaces its first window once it knows the project: follow
  // whichever window shows the screen awaited.
  app.on("browser-window-created", (_event, window) => {
    window.once("ready-to-show", () => mark("windowMs"));
  });
  void app
    .whenReady()
    .then(() => (mode === "prepare" ? prepare() : measure()))
    .catch(fail);

  async function prepare() {
    const project = join(scratch, "project");
    const window = await windowShowing(BrowserWindow, "");
    await window.webContents.executeJavaScript(`(async () => {
      const session = await window.blame.localApi.session();
      const model = { providerId: "anthropic", modelId: "claude-sonnet-5-5", credentialLabel: null, reasoningEffort: null };
      const response = await fetch(session.url.replace(/\\/$/, "") + "/account/ai-preferences", {
        method: "PUT",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + session.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ agentModel: model, alternativeModel: model }),
      });
      if (!response.ok) throw new Error("AI preferences: " + response.status + " " + await response.text());
      localStorage.setItem("blame.app.workspace-start.v1", "local");
      localStorage.setItem("blame.runtime-offer-done.v1", "true");
    })()`);
    // The project is opened as a person would, from the welcome screen.
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [project],
    });
    window.webContents.reload();
    const welcome = await windowShowing(BrowserWindow, "Open Project");
    await welcome.webContents
      .executeJavaScript(`[...document.querySelectorAll("button")]
      .find((button) => button.innerText.startsWith("Open Project")).click()`);
    await windowShowing(BrowserWindow, "Agent Queue");
    // The renderer writes its storage to disk on the way out.
    await delay(1_000);
    console.log(`${resultPrefix}{}`);
    app.exit(0);
  }

  async function measure() {
    const window = await windowShowing(BrowserWindow, "Agent Queue");
    mark("backlogMs");
    const contents = window.webContents;
    // Let the first screen's requests settle before reading memory.
    await delay(3_000);
    const result = {
      ...marks,
      mainFootprintMiB: await footprintMiB(process.pid),
      rendererFootprintMiB: await footprintMiB(contents.getOSProcessId()),
      workersAtBacklog: worker.child?.pid ? 1 : 0,
    };
    // A request the backlog does not make, on the host it started.
    const startedAt = performance.now();
    await contents.executeJavaScript('window.blame.engine.call("running")');
    result.sessionsListMs = Math.round(performance.now() - startedAt);
    await delay(3_000);
    result.mainAfterAgentMiB = await footprintMiB(process.pid);
    result.workerReadyMs = worker.readyMs;
    result.workerFirstResponseMs = worker.firstResponseMs;
    if (worker.child?.pid)
      result.workerFootprintMiB = await footprintMiB(worker.child.pid);
    if (mode === "modules") {
      result.mainModules = modules.size;
      result.agentRuntimeModules = [...modules]
        .filter((url) => url.includes("/packages/agent-runtime/"))
        .map((url) => url.replace(/^.*\/packages\/agent-runtime\//, ""))
        .sort();
      result.engineLoaded = [...modules].some(
        (url) =>
          url.endsWith("/packages/agent-runtime/dist/index.js") ||
          url.includes("/@cline/sdk/"),
      );
    }
    console.log(`${resultPrefix}${JSON.stringify(result)}`);
    app.exit(0);
  }

  await import(pathToFileURL(join(application, "out/main/index.js")).href);
}

async function windowShowing(BrowserWindow, text, timeoutMs = 60_000) {
  const check = `document.readyState === "complete" && Boolean(document.body?.innerText.includes(${JSON.stringify(text)}))`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isLoading()) continue;
      const showing = await window.webContents
        .executeJavaScript(check)
        .catch(() => false);
      if (showing) return window;
    }
    await delay(50);
  }
  const screens = await Promise.all(
    BrowserWindow.getAllWindows().map((window) =>
      window.webContents
        .executeJavaScript("document.body?.innerText.slice(0, 600)")
        .catch((error) => String(error)),
    ),
  );
  throw new Error(
    `Timed out waiting for "${text}", on:\n${screens.join("\n---\n")}`,
  );
}

async function footprintMiB(pid) {
  const { stdout } = await execFileAsync("footprint", [
    "-f",
    "bytes",
    "--noCategories",
    "-p",
    String(pid),
  ]);
  const bytes = Number(/Footprint: (\d+) B/.exec(stdout)?.[1]);
  if (!bytes) throw new Error(`No footprint for ${pid}: ${stdout}`);
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
