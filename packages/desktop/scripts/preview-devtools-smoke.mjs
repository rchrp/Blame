import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, WebContentsView } from "electron";
import { PreviewDevtoolsMcpService } from "../src/main/preview-runtime/preview-devtools-mcp-service.ts";
import { electronCdpDebuggee } from "../src/main/preview-browser/electron-cdp-debuggee.ts";
import { previewNavigationPolicy } from "../src/main/preview-browser/preview-navigation-policy.ts";
import { startPreviewCdpProxy } from "../src/main/preview-browser/preview-cdp-proxy.ts";

const artifacts = await mkdtemp(join(tmpdir(), "blame-preview-smoke-"));
const hidden = process.argv.includes("--hidden");
app.setPath("userData", join(artifacts, "electron"));
app.disableHardwareAcceleration();
const service = new PreviewDevtoolsMcpService();
const fixture = await readFile(
  new URL("./fixtures/preview-devtools.html", import.meta.url),
);
const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(fixture);
});
await listen(server);
const currentUrl = `http://127.0.0.1:${server.address().port}/`;
const previewOrigin = new URL(currentUrl).origin;
const input = {
  currentUrl,
  openEndpoint: () =>
    startPreviewCdpProxy(
      electronCdpDebuggee(view.webContents, {
        contentSize: () => {
          const { height, width } = view.getBounds();
          return { height, width };
        },
      }),
      previewNavigationPolicy(previewOrigin),
    ),
  previewOrigin,
  scope: "smoke",
  worktree: artifacts,
};
const timeout = setTimeout(() => {
  console.error("Preview smoke timed out");
  app.exit(1);
}, 90_000);
let owner;
let view;
const results = [];

void app.whenReady().then(runSmoke);

async function runSmoke() {
  owner = new BrowserWindow({ show: true, width: 1200, height: 900 });
  try {
    await assertNoListeningPorts("before any DevTools session");
    for (let iteration = 0; iteration < 3; iteration += 1)
      await inspectRecreatedPage(iteration);
    console.log(
      JSON.stringify({
        status: "passed",
        browser: process.versions.chrome,
        hidden,
        artifacts,
        runs: results,
      }),
    );
  } catch (error) {
    process.exitCode = 1;
    console.error(error);
  } finally {
    clearTimeout(timeout);
    await service.dispose();
    owner.destroy();
    server.close();
    app.exit(process.exitCode ?? 0);
  }
}

async function inspectRecreatedPage(iteration) {
  const started = Date.now();
  await recreatePage();
  const pageIdentity = `browser-${iteration}`;
  const call = (toolName, args) =>
    service.call({ ...input, pageIdentity, toolName, arguments: args });
  await service.prepare({ ...input, pageIdentity });
  assert.match(
    textContent(await call("take_snapshot")),
    /Preview inspection smoke/,
  );
  const animationMs = await verifyInteractions(call);
  await verifyNavigationScope(call);
  const screenshotBytes = await saveScreenshot(call, iteration);
  assert.equal(view.webContents.getBackgroundThrottling(), true);
  assert.equal(view.getVisible(), !hidden);
  results.push({
    iteration,
    durationMs: Date.now() - started,
    animationMs,
    screenshotBytes,
  });
}

async function recreatePage() {
  if (view) {
    owner.contentView.removeChildView(view);
    view.webContents.close();
  }
  view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  owner.contentView.addChildView(view);
  view.setBounds({ width: 1100, height: 800, x: 0, y: 0 });
  view.setVisible(!hidden);
  await view.webContents.loadURL(currentUrl);
}

async function saveScreenshot(call, iteration) {
  const screenshot = await call("take_screenshot", { format: "png" });
  const image = screenshot.content.find((block) => block.type === "image");
  assert.ok(image?.data, textContent(screenshot));
  await writeFile(
    join(artifacts, `preview-${iteration}.png`),
    Buffer.from(image.data, "base64"),
  );
  return Buffer.from(image.data, "base64").length;
}

async function verifyInteractions(call) {
  view.setBounds({ width: 941, height: 620, x: 0, y: 0 });
  const snapshot = textContent(await call("take_snapshot"));
  const advance = snapshot.match(/uid=(\S+) button "Advance project"/u)?.[1];
  const drop = snapshot.match(/uid=(\S+) button "Drop project here"/u)?.[1];
  assert.ok(advance && drop, snapshot);
  assertToolSuccess(await call("click", { uid: advance }));
  assertToolSuccess(await call("press_key", { key: "ArrowRight" }));
  assertToolSuccess(await call("drag", { from_uid: advance, to_uid: drop }));
  await verifyWheelAndState();
  return verifyAnimation(call);
}

async function verifyWheelAndState() {
  view.webContents.sendInputEvent({
    type: "mouseWheel",
    x: 200,
    y: 250,
    deltaX: 100,
    deltaY: 0,
    modifiers: ["shift"],
    canScroll: true,
  });
  const state = await view.webContents.executeJavaScript(
    `new Promise(resolve => setTimeout(() => resolve({ ...window.inspection, width: innerWidth, height: innerHeight }), 100))`,
  );
  assert.equal(state.width, 941);
  assert.equal(state.height, 620);
  assert.ok(
    state.clicks >= 1 &&
      state.keys >= 1 &&
      state.drops >= 1 &&
      state.wheels >= 1,
    JSON.stringify(state),
  );
}

async function verifyNavigationScope(call) {
  await assert.rejects(
    call("navigate_page", { type: "url", url: "https://example.com/" }),
    /can only open this story's preview/,
  );
  const location = await call("evaluate_script", {
    function: "() => location.href",
  });
  assert.match(textContent(location), new RegExp(previewOrigin));
  assertToolSuccess(await call("navigate_page", { type: "url", url: "/" }));
}

// Linux only: the Electron process must not listen on any TCP port other
// than the fixture server and the per-session proxy it opens on purpose.
async function assertNoListeningPorts(label) {
  if (process.platform !== "linux") return;
  const { readdir, readlink } = await import("node:fs/promises");
  const inodes = new Set();
  for (const fd of await readdir("/proc/self/fd")) {
    const target = await readlink(`/proc/self/fd/${fd}`).catch(() => "");
    const match = target.match(/^socket:\[(\d+)\]$/u);
    if (match) inodes.add(match[1]);
  }
  const listening = [];
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const rows = (await readFile(table, "utf8").catch(() => "")).split("\n");
    for (const row of rows.slice(1)) {
      const fields = row.trim().split(/\s+/u);
      if (fields[3] === "0A" && inodes.has(fields[9]))
        listening.push(parseInt(fields[1].split(":")[1], 16));
    }
  }
  const unexpected = listening.filter((port) => port !== server.address().port);
  assert.deepEqual(unexpected, [], `listening ports ${label}`);
}

async function verifyAnimation(call) {
  const animation = await call("evaluate_script", {
    waitForStableDom: false,
    function:
      "async () => { const start = performance.now(); for(let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); return { elapsed: performance.now() - start }; }",
  });
  assertToolSuccess(animation);
  const elapsed = Number(
    textContent(animation).match(/"elapsed"\s*:\s*([\d.]+)/u)?.[1],
  );
  assert.ok(elapsed < 1000, textContent(animation));
  return elapsed;
}

function textContent(result) {
  return (
    result.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n") ?? ""
  );
}

function assertToolSuccess(result) {
  assert.notEqual(result.isError, true, textContent(result));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}
