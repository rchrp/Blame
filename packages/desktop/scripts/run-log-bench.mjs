// Measures what a new chunk of a run's output costs the logs panel as the
// log grows, without a runtime, an account or a project:
//
//   pnpm --filter @blame/desktop exec electron scripts/run-log-bench.mjs \
//     [--streams build,dev-server,progress] [--sizes 16384,262144,1048576]
//     [--measured 40] [--out results.json]
//
// It builds the app's bench page (packages/app/bench/run-log.html: the
// project runner and its logs panel fed through a stand-in terminal) and,
// for each kind of output and each log size, writes that much output then
// measures the next chunks one at a time: characters handed to string
// scans, React commits (the panel's and the runner's other readers'),
// characters written into the DOM, time until laid out again (noisy on a
// loaded Mac: compare the counts first), the page's JavaScript heap once
// collected and the renderer's memory.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";

const options = parseOptions(process.argv);
const appDirectory = fileURLToPath(new URL("../../app/", import.meta.url));
const appRequire = createRequire(join(appDirectory, "package.json"));
const scratch = await mkdtemp(join(tmpdir(), "blame-run-log-bench-"));
// One profile for every run: Electron writes it again as it quits.
app.setPath("userData", join(tmpdir(), "blame-run-log-bench-profile"));
app.commandLine.appendSwitch("js-flags", "--expose-gc");
app.commandLine.appendSwitch("enable-precise-memory-info");
// Each case closes its window: the bench goes on.
app.on("window-all-closed", () => {});

void app
  .whenReady()
  .then(main)
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

async function main() {
  const vite = await import(pathToFileURL(appRequire.resolve("vite")).href);
  const outDir = join(scratch, "page");
  await vite.build({
    build: {
      emptyOutDir: true,
      outDir,
      rollupOptions: { input: join(appDirectory, "bench/run-log.html") },
    },
    configFile: join(appDirectory, "vite.config.ts"),
    logLevel: "warn",
    // React's profiling build, whose Profiler reports commits: a plugin of
    // its own, so that its alias comes before the app's.
    plugins: [
      {
        name: "run-log-bench:react-profiling",
        config: () => ({
          resolve: {
            alias: [
              {
                find: /^react-dom\/client$/,
                replacement: appRequire.resolve("react-dom/profiling"),
              },
            ],
          },
        }),
      },
    ],
    root: appDirectory,
  });
  const server = await vite.preview({
    build: { outDir },
    configFile: join(appDirectory, "vite.config.ts"),
    logLevel: "warn",
    preview: { port: 0 },
    root: appDirectory,
  });
  const url = `${server.resolvedUrls.local[0]}bench/run-log.html`;
  const results = [];
  try {
    for (const stream of options.streams) {
      for (const size of options.sizes) {
        const row = { stream, size, ...(await measure(url, stream, size)) };
        results.push(row);
        console.log(JSON.stringify(row));
      }
    }
    console.table(
      results.map((row) => ({
        stream: row.stream,
        logKb: Math.round(row.logChars / 1024),
        scanned: row.scannedPerChunk,
        commits: row.commitsPerChunk,
        consumer: row.consumerRendersPerChunk,
        commitMs: row.commitMsPerChunk,
        domChars: row.domCharsPerChunk,
        layoutMs: row.layoutMsMedian,
        heapMb: Math.round(row.heapAfter / 1024 / 102.4) / 10,
        domKb: Math.round(row.domTextChars / 1024),
        rendererMb: row.rendererMb,
      })),
    );
    if (options.out)
      await writeFile(
        options.out,
        `${JSON.stringify({ options, results }, null, 2)}\n`,
      );
  } finally {
    await new Promise((resolve) => server.httpServer.close(resolve));
    await rm(scratch, { force: true, recursive: true });
    app.exit(0);
  }
}

// Each case in a window of its own: a renderer that holds nothing else.
async function measure(url, stream, size) {
  const window = new BrowserWindow({
    height: 800,
    show: true,
    width: 1100,
    webPreferences: { backgroundThrottling: false, sandbox: true },
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(`page: ${event.message}`);
  });
  try {
    await window.loadURL(url);
    await waitFor(() =>
      window.webContents.executeJavaScript("Boolean(window.runLogBench)"),
    );
    const result = await window.webContents.executeJavaScript(
      `window.runLogBench.run(${JSON.stringify({ measured: options.measured, size, stream })})`,
    );
    return { ...rounded(result), rendererMb: rendererMemory(window) };
  } finally {
    window.destroy();
  }
}

function rendererMemory(window) {
  const pid = window.webContents.getOSProcessId();
  const metric = app.getAppMetrics().find((item) => item.pid === pid);
  return metric ? Math.round(metric.memory.workingSetSize / 1024) : null;
}

function rounded(result) {
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) => [
      key,
      Math.round(value * 100) / 100,
    ]),
  );
}

function parseOptions(argv) {
  const value = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
  };
  return {
    measured: Number(value("measured", "40")),
    out: value("out"),
    sizes: value("sizes", "16384,262144,1048576,4194304")
      .split(",")
      .map(Number),
    streams: value("streams", "build,dev-server,progress").split(","),
  };
}

async function waitFor(check, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (!(await check())) {
    if (Date.now() - startedAt > timeoutMs)
      throw new Error("The bench page did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
