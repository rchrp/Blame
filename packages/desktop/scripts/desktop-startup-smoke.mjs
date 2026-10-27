import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

if (process.versions.electron) await checkStartup();
else await launch();

async function launch() {
  const profile = await mkdtemp(join(tmpdir(), "blame-startup-smoke-"));
  const application = resolve(process.argv[2] || join(import.meta.dirname, ".."));
  const electron = createRequire(import.meta.url)("electron");
  const args = [import.meta.filename, application, profile];
  const linux = process.platform === "linux";
  if (linux) args.unshift("--no-sandbox");
  const headless = linux && !process.env.DISPLAY;
  const environment = { ...process.env, OTEL_SDK_DISABLED: "true" };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_RENDERER_URL;
  try {
    await new Promise((resolveRun, reject) => {
      const child = spawn(headless ? "xvfb-run" : electron,
        headless ? ["-a", electron, ...args] : args,
        { env: environment, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (data) => { output = (output + data).slice(-50_000); });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        if (code === 0 && output.includes("Desktop startup smoke passed")) {
          console.log("Desktop startup smoke passed: main, preload, renderer and IPC");
          resolveRun();
        } else reject(new Error(`Desktop startup failed (${signal || code}):\n${output}`));
      });
    });
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

async function checkStartup() {
  const { app } = await import("electron");
  // Electron retains Chromium flags in argv on Linux; our inputs are always last.
  const [application, profile] = process.argv.slice(-2);
  for (const name of ["appData", "userData", "sessionData"]) app.setPath(name, profile);
  app.setAppLogsPath(join(profile, "logs"));
  // Load the actual built application and isolate OS integration from the user.
  app.getAppPath = () => application;
  app.setAsDefaultProtocolClient = () => false;
  process.env.LIMA_HOME = join(profile, "lima");
  process.env.BLAME_WSL_DISTRO = "BlameStartupSmoke";
  function fail(error) {
    console.error(error instanceof Error ? error.stack : String(error));
    app.exit(1);
  }
  process.once("uncaughtException", fail);
  process.once("unhandledRejection", fail);
  setTimeout(() => fail(new Error("Desktop startup timed out")), 60_000);
  app.on("browser-window-created", (_event, window) => {
    window.webContents.once("preload-error", (_event, _path, error) => fail(error));
    window.webContents.once("render-process-gone", (_event, details) => fail(new Error(details.reason)));
    window.webContents.once("did-fail-load", (_event, code, reason) => fail(new Error(`${code}: ${reason}`)));
    window.webContents.once("did-finish-load", () => {
      void (async () => {
        for (let attempt = 0; attempt < 40; attempt++) {
          const ready = await window.webContents.executeJavaScript(`(async () => {
            if (!document.querySelector('#root')?.textContent?.trim() || !window.blame?.updates) return false;
            return typeof (await window.blame.updates.getStatus()).currentVersion === 'string';
          })()`);
          if (ready) {
            console.log("Desktop startup smoke passed");
            app.exit(0);
            return;
          }
          await new Promise(resolveWait => setTimeout(resolveWait, 250));
        }
        throw new Error("Renderer or preload API did not initialize");
      })().catch(fail);
    });
  });
  try {
    await import(pathToFileURL(join(application, "out/main/index.js")).href);
  } catch (error) { fail(error); }
}
