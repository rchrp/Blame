// Measures what the app's interface costs the GPU and the compositor when
// nothing changes on screen, without a runtime, an account or an agent:
//
//   pnpm --filter @blame/desktop exec electron scripts/idle-gpu-bench.mjs \
//     [--seconds 20] [--rounds 3] [--states blank,board,drawer,agent] \
//     [--warmup-seconds 6] [--trace-seconds 5] [--theme light] \
//     [--vibrancy active|followWindow|inactive] [--out results.json] \
//     [--screenshots directory] [--css "extra rules"]
//
// It builds the app's bench page (packages/app/bench/idle-gpu.html: the
// board, the drawer on an idle preview, an agent writing, and the activity
// indicators alone with --states waiting) and shows each state
// in a window made like the app's, with a native page as the preview. For
// each state it reports the CPU of the GPU process, of the page's renderer
// and of the main process, the frames the window's compositor drew and swapped
// per second, the memory of the GPU process and of the renderer, and the
// Mac's GPU utilization (system-wide: compare with blank).
// The window stays on top: it must stay visible for the effects to run.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { app, BrowserWindow, ipcMain, WebContentsView } from "electron";

const options = parseOptions(process.argv);
const execFileAsync = promisify(execFile);
// An idle app page: a dark header, a bright hero and a light body, so the
// glow takes different colors on each edge.
const previewPage = `<!doctype html><html><body style="margin:0;font:16px system-ui">
<header style="height:64px;background:#0f172a;color:#fff;display:flex;align-items:center;padding:0 24px">Acme</header>
<section style="height:320px;background:linear-gradient(90deg,#f97316,#db2777);color:#fff;padding:48px 24px;font-size:40px">Invoices, sorted.</section>
<main style="padding:24px;background:#f8fafc;height:2000px">Your invoices</main>
</body></html>`;

const appDirectory = fileURLToPath(new URL("../../app/", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "blame-idle-gpu-bench-"));
// Its own profile, one for every run: Electron writes it again as it quits.
app.setPath("userData", join(tmpdir(), "blame-idle-gpu-bench-profile"));

let window;
let preview;
let origin;
// Electron emits ready only once the entry module has run: wait for it from
// a callback, not from a top-level await.
void app
  .whenReady()
  .then(main)
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

async function main() {
  const vite = await import(
    pathToFileURL(
      createRequire(join(appDirectory, "package.json")).resolve("vite"),
    ).href
  );
  const outDir = join(scratch, "page");
  await vite.build({
    build: {
      emptyOutDir: true,
      outDir,
      rollupOptions: { input: join(appDirectory, "bench/idle-gpu.html") },
    },
    configFile: join(appDirectory, "vite.config.ts"),
    logLevel: "warn",
    root: appDirectory,
  });
  const server = await vite.preview({
    build: { outDir },
    configFile: join(appDirectory, "vite.config.ts"),
    logLevel: "warn",
    preview: { port: 0 },
    root: appDirectory,
  });
  origin = server.resolvedUrls.local[0];

  // As the app's main window (main/index.ts): frameless, transparent, with the
  // system's blur behind it.
  window = new BrowserWindow({
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    frame: false,
    height: 900,
    show: false,
    transparent: process.platform !== "win32",
    width: 1440,
    ...(process.platform === "darwin"
      ? { vibrancy: "under-window", visualEffectState: options.vibrancy }
      : {}),
    webPreferences: {
      contextIsolation: true,
      preload: fileURLToPath(
        new URL("./idle-gpu-bench-preload.cjs", import.meta.url),
      ),
      sandbox: true,
    },
  });
  // The page's warnings and errors, its workers' too.
  window.webContents.on("console-message", (event) => {
    if (event.level === "warning" || event.level === "error")
      console.error(`page ${event.level}: ${event.message}`);
  });
  preview = new WebContentsView();
  window.contentView.addChildView(preview);
  preview.setVisible(false);
  await preview.webContents.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(previewPage)}`,
  );
  ipcMain.on("bench:bounds", (_event, bounds) => {
    preview.setBounds(roundBounds(bounds));
    preview.setVisible(true);
  });
  // As capturePreviewBrowser (preview-browser-manager.ts) for the glow.
  ipcMain.handle("bench:capture", async () => {
    if (!preview.getVisible()) return null;
    const image = await preview.webContents.capturePage();
    if (image.isEmpty()) return null;
    const { height, width } = image.getSize();
    return image
      .resize({
        height: Math.max(1, Math.round((64 * height) / width)),
        quality: "better",
        width: 64,
      })
      .toDataURL();
  });

  const results = [];
  try {
    window.show();
    for (let round = 1; round <= options.rounds; round += 1) {
      for (const state of options.states) {
        const result = await measureState(state);
        results.push({ round, state, ...result });
        console.log(JSON.stringify({ round, state, ...result }));
      }
    }
    const summary = summarize(results);
    console.table(summary);
    if (options.out) {
      await writeFile(
        options.out,
        `${JSON.stringify({ options, results, summary }, null, 2)}\n`,
      );
    }
  } finally {
    await new Promise((resolve) => server.httpServer.close(resolve));
    await rm(scratch, { force: true, recursive: true });
    app.exit(0);
  }
}

async function measureState(state) {
  preview.setVisible(false);
  await window.webContents.loadURL(
    `${origin}bench/idle-gpu.html?state=${state}&theme=${options.theme}`,
  );
  await waitFor(() =>
    window.webContents.executeJavaScript("window.idleGpuBenchReady === true"),
  );
  if (options.css) await window.webContents.insertCSS(options.css);
  // The drawer slides in, the glow takes its first colors.
  await delay(options.warmupSeconds * 1_000);
  const cpu = await measureCpu(options.seconds);
  const frames = await measureFrames(options.traceSeconds);
  const visible = await window.webContents.executeJavaScript(
    "document.visibilityState",
  );
  if (options.screenshots) await screenshot(state);
  return { ...cpu, ...frames, visible };
}

// The page with its timers stopped and its CSS animations at the same
// instant, to compare two versions; the native preview is not in it, nor do
// the borders' frames stop.
async function screenshot(state) {
  await window.webContents.executeJavaScript(
    `for (let id = window.setTimeout(() => {}); id > 0; id -= 1) window.clearTimeout(id);
    document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 4000 })`,
  );
  await delay(300);
  const image = await window.webContents.capturePage();
  await writeFile(join(options.screenshots, `${state}.png`), image.toPNG());
}

async function measureCpu(seconds) {
  const pids = {
    preview: preview.webContents.getOSProcessId(),
    renderer: window.webContents.getOSProcessId(),
  };
  const before = processTimes(pids);
  const utilization = [];
  const startedAt = performance.now();
  while (performance.now() - startedAt < seconds * 1_000) {
    await delay(1_000);
    const value = await gpuUtilization();
    if (value !== undefined) utilization.push(value);
  }
  const elapsed = (performance.now() - startedAt) / 1_000;
  const after = processTimes(pids);
  const percent = (key) =>
    round(((after[key] - before[key]) / elapsed) * 100, 1);
  return {
    browserCpu: percent("browser"),
    gpuCpu: percent("gpu"),
    gpuUtilization: utilization.length
      ? round(utilization.reduce((a, b) => a + b, 0) / utilization.length, 1)
      : null,
    previewCpu: percent("preview"),
    rendererCpu: percent("renderer"),
    ...memory(pids),
  };
}

// Megabytes each process holds at the end of the sample.
function memory(pids) {
  const metrics = app.getAppMetrics();
  const megabytes = (predicate) =>
    round(
      metrics
        .filter(predicate)
        .reduce((sum, metric) => sum + metric.memory.workingSetSize, 0) / 1024,
      0,
    );
  return {
    gpuMemoryMb: megabytes((metric) => metric.type === "GPU"),
    rendererMemoryMb: megabytes((metric) => metric.pid === pids.renderer),
  };
}

// Seconds of CPU each process used since it started.
function processTimes(pids) {
  const metrics = app.getAppMetrics();
  const seconds = (predicate) =>
    metrics
      .filter(predicate)
      .reduce((sum, metric) => sum + (metric.cpu.cumulativeCPUUsage ?? 0), 0);
  return {
    browser: seconds((metric) => metric.type === "Browser"),
    gpu: seconds((metric) => metric.type === "GPU"),
    preview: seconds((metric) => metric.pid === pids.preview),
    renderer: seconds((metric) => metric.pid === pids.renderer),
  };
}

// The frames viz drew and swapped for the window, and the render passes it
// drew for them: one more for each blur or filter it redraws.
async function measureFrames(seconds) {
  const events = await traceEvents(seconds, ["viz", "cc", "gpu"]);
  const count = (name) =>
    events.filter(
      (event) => event.name === name && (event.ph === "X" || event.ph === "B"),
    ).length;
  return {
    drawnFps: round(count("Display::DrawAndSwap") / seconds, 1),
    renderPassesPerSecond: round(
      count("DirectRenderer::DrawRenderPass") / seconds,
      1,
    ),
  };
}

// A trace of every process, read back as JSON through the page's DevTools
// protocol (contentTracing now writes protobuf).
async function traceEvents(seconds, categories) {
  const devtools = window.webContents.debugger;
  if (!devtools.isAttached()) devtools.attach("1.3");
  await devtools.sendCommand("Tracing.start", {
    streamFormat: "json",
    traceConfig: { includedCategories: categories },
    transferMode: "ReturnAsStream",
  });
  await delay(seconds * 1_000);
  const complete = new Promise((resolve) => {
    const onMessage = (_event, method, params) => {
      if (method !== "Tracing.tracingComplete") return;
      devtools.off("message", onMessage);
      resolve(params.stream);
    };
    devtools.on("message", onMessage);
  });
  await devtools.sendCommand("Tracing.end");
  const stream = await complete;
  let text = "";
  for (;;) {
    const chunk = await devtools.sendCommand("IO.read", { handle: stream });
    text += chunk.base64Encoded
      ? Buffer.from(chunk.data, "base64").toString("utf8")
      : chunk.data;
    if (chunk.eof) break;
  }
  await devtools.sendCommand("IO.close", { handle: stream });
  const trace = JSON.parse(text);
  return Array.isArray(trace) ? trace : trace.traceEvents;
}

async function gpuUtilization() {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileAsync("ioreg", [
      "-r",
      "-d",
      "1",
      "-c",
      "IOAccelerator",
    ]);
    const match = /"Device Utilization %"=(\d+)/.exec(stdout);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function summarize(rows) {
  const keys = [
    "gpuCpu",
    "rendererCpu",
    "browserCpu",
    "previewCpu",
    "drawnFps",
    "renderPassesPerSecond",
    "gpuMemoryMb",
    "rendererMemoryMb",
    "gpuUtilization",
  ];
  return Object.fromEntries(
    options.states.map((state) => {
      const stateRows = rows.filter((row) => row.state === state);
      return [
        state,
        Object.fromEntries(
          keys.map((key) => [
            key,
            median(stateRows.map((row) => row[key]).filter(Number.isFinite)),
          ]),
        ),
      ];
    }),
  );
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : round((sorted[middle - 1] + sorted[middle]) / 2, 1);
}

function parseOptions(argv) {
  const value = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
  };
  return {
    out: value("out"),
    // Extra rules, to tell what one effect costs (one off, one changed).
    css: value("css"),
    rounds: Number(value("rounds", "3")),
    screenshots: value("screenshots"),
    seconds: Number(value("seconds", "20")),
    states: value("states", "blank,board,drawer,agent").split(","),
    theme: value("theme", "light"),
    traceSeconds: Number(value("trace-seconds", "5")),
    vibrancy: value("vibrancy", "active"),
    warmupSeconds: Number(value("warmup-seconds", "6")),
  };
}

async function waitFor(check, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (!(await check())) {
    if (Date.now() - startedAt > timeoutMs)
      throw new Error("The bench page did not start");
    await delay(100);
  }
}

function roundBounds({ height, width, x, y }) {
  return {
    height: Math.round(height),
    width: Math.round(width),
    x: Math.round(x),
    y: Math.round(y),
  };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
