import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, nativeImage } from "electron";
import { PreviewDevtoolsMcpService } from "../src/main/preview-runtime/preview-devtools-mcp-service.ts";
import { electronCdpDebuggee } from "../src/main/preview-browser/electron-cdp-debuggee.ts";
import { previewNavigationPolicy } from "../src/main/preview-browser/preview-navigation-policy.ts";
import { startPreviewCdpProxy } from "../src/main/preview-browser/preview-cdp-proxy.ts";
import {
  agentPreviewBrowser,
  destroyAgentPreviewBrowser,
  ensureAgentPreviewBrowser,
  holdAgentPreviewBrowser,
  releaseAgentPreviewSession,
} from "../src/main/preview-browser/agent-preview-browser.ts";

// What goes wrong in a long agent run, against the real Electron browser and
// chrome-devtools-mcp: a tool stuck past its timeout, a long wait, a
// renderer crash in the middle of a call, the dev server restarting, and a
// long chain of calls. Each time the next call must work, with the page,
// viewport and emulation the agent had set.

const artifacts = await mkdtemp(join(tmpdir(), "blame-preview-robustness-"));
app.setPath("userData", join(artifacts, "electron"));
app.disableHardwareAcceleration();
const partition = "persist:blame-preview-robustness";
const scope = "robustness";
const service = new PreviewDevtoolsMcpService();
const fixture = await readFile(
  new URL("./fixtures/preview-devtools.html", import.meta.url),
);
const second = `<!doctype html><html><head><style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px sans-serif; background: #f8fafc; color: #0f172a; }
  @media (prefers-color-scheme: dark) { body { background: #111827; color: #f8fafc; } }
</style></head><body><h1>Second page</h1></body></html>`;
let server = createServer(serve);
await listen(server, 0);
const port = server.address().port;
const currentUrl = `http://127.0.0.1:${port}/`;
const previewOrigin = new URL(currentUrl).origin;
const timeout = setTimeout(() => {
  console.error("Preview robustness smoke timed out");
  app.exit(1);
}, 300_000);
const report = [];

// The same path as the app: each connection makes sure the agent browser
// exists (reopening it after a crash) and exposes where its page is.
const input = {
  currentUrl,
  async openEndpoint() {
    const agent = await ensureAgentPreviewBrowser(scope, {
      initialUrl: currentUrl,
      partition,
      previewOrigin,
    });
    const proxy = await startPreviewCdpProxy(
      electronCdpDebuggee(agent.webContents, {
        activity: agent.touch,
        viewport: {
          get: () => agent.viewport,
          set: (size) => {
            agent.viewport = size;
          },
        },
      }),
      previewNavigationPolicy(previewOrigin),
    );
    return {
      ...proxy,
      pageUrl: () =>
        agent.webContents.isDestroyed() ? "" : agent.webContents.getURL(),
    };
  },
  pageIdentity: "robustness-preview",
  previewOrigin,
  scope,
  worktree: artifacts,
};
const call = (toolName, args = {}) =>
  service.call({ ...input, toolName, arguments: args });

void app.whenReady().then(run);

async function run() {
  const owner = new BrowserWindow({ show: false });
  try {
    await step("set up dark, 941×620, /second", setUp);
    await step("a tool stuck past its timeout", stuckTool);
    await step("a 30 s wait_for that never matches", longWait);
    await step("renderer crash during a call", rendererCrash);
    await step("dev server restart", devServerRestart);
    await step("20 chained calls", chainedCalls);
    await step("run hold keeps the browser", runHold);
    console.log(JSON.stringify({ status: "passed", artifacts, report }));
  } catch (error) {
    process.exitCode = 1;
    console.error(error);
    console.log(JSON.stringify({ status: "failed", report }));
  } finally {
    clearTimeout(timeout);
    await service.dispose();
    destroyAgentPreviewBrowser(scope);
    owner.destroy();
    server.close();
    app.exit(process.exitCode ?? 0);
  }
}

async function setUp() {
  assertToolSuccess(await call("resize_page", { width: 941, height: 620 }));
  assertToolSuccess(await call("emulate", { colorScheme: "dark" }));
  assertToolSuccess(
    await call("navigate_page", { type: "url", url: "/second" }),
  );
  await expectAgentState("after setup");
}

// evaluate_script has no timeout of its own: the service cuts it at 15 s,
// while chrome-devtools-mcp keeps waiting for it and holds its tool lock.
async function stuckTool() {
  const started = Date.now();
  await assert.rejects(
    call("evaluate_script", {
      function: "() => new Promise((resolve) => setTimeout(resolve, 60000))",
    }),
    /evaluate_script did not finish within 15 s\. The browser connection was reset/u,
  );
  const cut = Date.now() - started;
  const next = Date.now();
  const snapshot = await call("take_snapshot");
  const recovered = Date.now() - next;
  assert.match(
    textContent(snapshot),
    /reconnected after the previous call ran out of time.*Restored: viewport 941×620, emulation \(dark color scheme\)/u,
  );
  assert.match(textContent(snapshot), /Second page/u);
  // Without the reset, this call would queue behind the stuck one.
  assert.ok(recovered < 10_000, `next call took ${recovered} ms`);
  await expectAgentState("after the reset");
  return { cutAfterMs: cut, nextCallMs: recovered };
}

// A wait the agent asked for: the browser gives up at 30 s, before the
// service (35 s), so the connection stays and nothing is restored.
async function longWait() {
  const started = Date.now();
  const result = await call("wait_for", {
    text: ["This text never appears"],
    timeout: 30_000,
  }).catch((error) => ({ thrown: error.message }));
  const waited = Date.now() - started;
  assert.ok(!result.thrown, result.thrown);
  assert.equal(result.isError, true, textContent(result));
  assert.ok(waited >= 29_000 && waited < 35_000, `waited ${waited} ms`);
  const next = await call("take_snapshot");
  assert.doesNotMatch(textContent(next), /reconnected/u);
  return {
    waitedMs: waited,
    browserMessage: textContent(result).slice(0, 120),
  };
}

async function rendererCrash() {
  const agent = agentPreviewBrowser(scope);
  const running = call("evaluate_script", {
    function: "() => new Promise((resolve) => setTimeout(resolve, 8000))",
  }).then(
    (value) => ({ value }),
    (error) => ({ error: error.message }),
  );
  await delay(1_000);
  agent.webContents.forcefullyCrashRenderer();
  const outcome = await running;
  const started = Date.now();
  const snapshot = await call("take_snapshot");
  const recovered = Date.now() - started;
  assert.notEqual(agentPreviewBrowser(scope)?.id, agent.id, "a new browser");
  assert.match(
    textContent(snapshot),
    /reconnected because the preview browser closed.*Restored: viewport 941×620, emulation \(dark color scheme\), page \/second/u,
  );
  await expectAgentState("after the crash");
  return {
    duringCrash: outcome.error ?? textContent(outcome.value).slice(0, 120),
    nextCallMs: recovered,
  };
}

async function devServerRestart() {
  await new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  const down = await call("navigate_page", { type: "reload" }).catch(
    (error) => ({ thrown: error.message }),
  );
  server = createServer(serve);
  await listen(server, port);
  assertToolSuccess(
    await call("navigate_page", { type: "url", url: "/second" }),
  );
  assert.match(textContent(await call("take_snapshot")), /Second page/u);
  await expectAgentState("after the restart");
  return {
    whileDown: down.thrown ?? textContent(down).slice(0, 120),
  };
}

async function chainedCalls() {
  const durations = [];
  for (let index = 0; index < 20; index += 1) {
    const toolName = [
      "take_snapshot",
      "evaluate_script",
      "list_console_messages",
      "take_screenshot",
    ][index % 4];
    const args =
      toolName === "evaluate_script"
        ? {
            function: `() => { console.log("step ${index}"); return ${index}; }`,
          }
        : toolName === "take_screenshot"
          ? { format: "png" }
          : {};
    const started = Date.now();
    const result = await call(toolName, args);
    durations.push(Date.now() - started);
    assertToolSuccess(result);
    assert.doesNotMatch(textContent(result), /reconnected/u);
  }
  return {
    calls: durations.length,
    totalMs: durations.reduce((sum, value) => sum + value, 0),
    slowestMs: Math.max(...durations),
  };
}

// The hold only changes the idle delay; it must not close or replace the
// browser, and releasing an unknown session is harmless.
async function runHold() {
  const before = agentPreviewBrowser(scope)?.id;
  holdAgentPreviewBrowser(scope, "session-1");
  assertToolSuccess(await call("take_snapshot"));
  releaseAgentPreviewSession("session-1");
  releaseAgentPreviewSession("unknown-session");
  assert.equal(agentPreviewBrowser(scope)?.id, before);
  assertToolSuccess(await call("take_snapshot"));
}

async function expectAgentState(label) {
  const agent = agentPreviewBrowser(scope);
  assert.equal(new URL(agent.webContents.getURL()).pathname, "/second", label);
  const shot = await call("take_screenshot", { format: "png" });
  const block = shot.content.find((entry) => entry.type === "image");
  assert.ok(block?.data, `${label}: ${textContent(shot)}`);
  const image = nativeImage.createFromBuffer(Buffer.from(block.data, "base64"));
  const { width, height } = image.getSize();
  const brightness = averageBrightness(image.toBitmap());
  assert.deepEqual([width, height], [941, 620], label);
  assert.ok(brightness < 80, `${label}: capture is not dark (${brightness})`);
}

async function step(name, action) {
  const started = Date.now();
  const details = await action();
  report.push({ step: name, ms: Date.now() - started, ...(details ?? {}) });
}

function serve(request, response) {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(request.url?.startsWith("/second") ? second : fixture);
}

function averageBrightness(bitmap) {
  let total = 0;
  let samples = 0;
  for (let index = 0; index < bitmap.length; index += 4 * 97) {
    total += (bitmap[index] + bitmap[index + 1] + bitmap[index + 2]) / 3;
    samples += 1;
  }
  return total / samples;
}

function textContent(result) {
  return (
    result?.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n") ?? ""
  );
}

function assertToolSuccess(result) {
  assert.notEqual(result.isError, true, textContent(result));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listen(target, listenPort) {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(listenPort, "127.0.0.1", resolve);
  });
}
