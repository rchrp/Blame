import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtemp,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { app, BrowserWindow, nativeImage, WebContentsView } from "electron";
import {
  agentBrowserExecutable,
  configureAgentBrowserHome,
} from "../src/main/preview-runtime/agent-browser-cli.ts";
import { PreviewDevtoolsService } from "../src/main/preview-runtime/preview-devtools-service.ts";
import { electronCdpDebuggee } from "../src/main/preview-browser/electron-cdp-debuggee.ts";
import { previewNavigationPolicy } from "../src/main/preview-browser/preview-navigation-policy.ts";
import { startPreviewCdpProxy } from "../src/main/preview-browser/preview-cdp-proxy.ts";
import {
  agentPreviewPageState,
  agentPreviewViewport,
  destroyAgentPreviewBrowser,
  ensureAgentPreviewBrowser,
} from "../src/main/preview-browser/agent-preview-browser.ts";
import {
  agentScreenshotStore,
  storePreviewDevtoolsScreenshots,
} from "../src/main/agent-screenshots/agent-screenshots-service.ts";

// Drives agent-browser against the agent's offscreen browser while the
// user's preview view stays hidden, through the scoped CDP proxy. No
// Chromium debugging port is opened, and agent-browser never launches a
// browser of its own.

const artifacts = await mkdtemp(join(tmpdir(), "blame-preview-smoke-"));
app.setPath("userData", join(artifacts, "electron"));
app.disableHardwareAcceleration();
configureAgentBrowserHome(join(artifacts, "agent-browser"));
const partition = "persist:blame-preview-smoke";
const service = new PreviewDevtoolsService();
const fixture = await readFile(
  new URL("./fixtures/preview-devtools.html", import.meta.url),
);
const server = createServer((request, response) => {
  if (request.url?.startsWith("/api/")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"saved":true}');
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(fixture);
});
await listen(server);
const currentUrl = `http://127.0.0.1:${server.address().port}/`;
const previewOrigin = new URL(currentUrl).origin;
const timeout = setTimeout(() => {
  console.error("Preview smoke timed out");
  app.exit(1);
}, 120_000);
let owner;
let userView;
let agent;
let exitCode = 0;
const results = [];

void app.whenReady().then(runSmoke);

async function runSmoke() {
  owner = new BrowserWindow({ show: true, width: 1200, height: 900 });
  try {
    await assertNoListeningPorts("before any DevTools session");
    await openHiddenUserPreview();
    for (let iteration = 0; iteration < 2; iteration += 1)
      await inspectAgentBrowser(iteration);
    assertNoBrowserLaunched();
    console.log(
      JSON.stringify({
        status: "passed",
        browser: process.versions.chrome,
        artifacts,
        runs: results,
      }),
    );
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    clearTimeout(timeout);
    await service.dispose();
    destroyAgentPreviewBrowser("smoke");
    owner.destroy();
    server.close();
    app.exit(exitCode);
  }
}

async function openHiddenUserPreview() {
  userView = new WebContentsView({
    webPreferences: { partition, sandbox: true, contextIsolation: true },
  });
  owner.contentView.addChildView(userView);
  userView.setBounds({ width: 0, height: 0, x: 0, y: 0 });
  userView.setVisible(false);
  await userView.webContents.loadURL(`${currentUrl}#user`);
}

// Each iteration recreates the agent browser, as the idle timeout does.
async function inspectAgentBrowser(iteration) {
  const started = Date.now();
  destroyAgentPreviewBrowser("smoke");
  agent = await ensureAgentPreviewBrowser("smoke", {
    initialUrl: currentUrl,
    partition,
    previewOrigin,
  });
  const input = {
    currentUrl,
    openEndpoint: () =>
      startPreviewCdpProxy(
        electronCdpDebuggee(agent.webContents, {
          activity: agent.use,
          viewport: () => agent.viewport,
        }),
        previewNavigationPolicy(previewOrigin),
      ),
    pageIdentity: agent.id,
    previewOrigin,
    scope: "smoke",
    worktree: artifacts,
  };
  const call = (toolName, args) =>
    service.call({ ...input, toolName, arguments: args });
  assert.equal(userView.getVisible(), false);
  assert.match(
    textContent(await call("take_snapshot", { mode: "text" })),
    /Preview inspection smoke/,
  );
  assertToolSuccess(await call("emulate", { colorScheme: "light" }));
  const light = await screenshot(call, `light-${iteration}`);
  assert.deepEqual(
    [light.width, light.height],
    [agentPreviewViewport.width, agentPreviewViewport.height],
  );
  assert.ok(
    light.brightness > 200,
    `light capture is too dark: ${light.brightness}`,
  );
  assertToolSuccess(
    await call("evaluate_script", {
      expression:
        'console.warn("agent console check"), fetch("/api/save", { method: "POST", headers: { Authorization: "Bearer smoke-secret" } }).then((response) => response.status)',
    }),
  );
  assert.match(
    textContent(await call("list_console_messages")),
    /\[warning\] agent console check/,
  );
  await verifyNetwork(call);
  await verifyInteractions(call);
  await verifyResize(call, iteration);
  const dark = await verifyDarkMode(call, iteration);
  await verifyNavigationScope(call);
  assert.equal(userView.webContents.getURL(), `${currentUrl}#user`);
  results.push({
    iteration,
    durationMs: Date.now() - started,
    light: [light.width, light.height, Math.round(light.brightness)],
    dark: [dark.width, dark.height, Math.round(dark.brightness)],
  });
}

// The request is listed, and its detail hides the credential it carried.
async function verifyNetwork(call) {
  const list = textContent(
    await call("list_network_requests", { filter: "/api/" }),
  );
  const id = list.match(/^\[(\S+)\] POST \/api\/save 200/mu)?.[1];
  assert.ok(id, list);
  const detail = textContent(await call("get_network_request", { id }));
  assert.match(detail, /"Authorization": "<redacted>"/u);
  assert.doesNotMatch(detail, /smoke-secret/u);
}

async function verifyInteractions(call) {
  const snapshot = textContent(await call("take_snapshot"));
  const advance = snapshot.match(/button "Advance project" \[ref=(e\d+)/u)?.[1];
  const drop = snapshot.match(/button "Drop project here" \[ref=(e\d+)/u)?.[1];
  assert.ok(advance && drop, snapshot);
  assertToolSuccess(await call("click", { target: `@${advance}` }));
  assertToolSuccess(await call("press_key", { key: "ArrowRight" }));
  assertToolSuccess(
    await call("drag", { from: `@${advance}`, to: `@${drop}` }),
  );
  const state = await agent.webContents.executeJavaScript("window.inspection");
  assert.ok(
    state.clicks >= 1 && state.keys >= 1 && state.drops >= 1,
    JSON.stringify(state),
  );
  const animation = await call("evaluate_script", {
    expression:
      "(async () => { const start = performance.now(); for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); return { elapsed: performance.now() - start }; })()",
  });
  const elapsed = Number(
    textContent(animation).match(/"elapsed"\s*:\s*([\d.]+)/u)?.[1],
  );
  assert.ok(elapsed < 1000, textContent(animation));
}

async function verifyResize(call, iteration) {
  assertToolSuccess(
    await call("emulate", { viewport: { width: 941, height: 620 } }),
  );
  const size = await agent.webContents.executeJavaScript(
    "({ width: innerWidth, height: innerHeight })",
  );
  assert.deepEqual(size, { width: 941, height: 620 });
  const resized = await screenshot(call, `resized-${iteration}`);
  assert.deepEqual([resized.width, resized.height], [941, 620]);
  assertToolSuccess(await call("emulate", { viewport: null }));
}

async function verifyDarkMode(call, iteration) {
  assertToolSuccess(await call("emulate", { colorScheme: "dark" }));
  const dark = await screenshot(call, `dark-${iteration}`);
  await verifyStoredScreenshot(call);
  assert.ok(
    dark.brightness < 80,
    `dark capture is too light: ${dark.brightness}`,
  );
  assert.deepEqual(
    [dark.width, dark.height],
    [agentPreviewViewport.width, agentPreviewViewport.height],
  );
  assertToolSuccess(await call("emulate", { colorScheme: "auto" }));
  return dark;
}

// The main process path: the original is stored, the model gets a named,
// bounded copy, and the page state is recorded.
async function verifyStoredScreenshot(call) {
  const result = await call("take_screenshot");
  const stored = await storePreviewDevtoolsScreenshots(result, {
    page: await agentPreviewPageState("smoke"),
    runId: "smoke-run",
    scope: "smoke",
    sessionId: "smoke-session",
    toolCallId: "smoke-call",
  });
  const [reference] = stored._meta.blameScreenshots;
  assert.equal(reference.colorScheme, "dark");
  assert.deepEqual(reference.viewport, agentPreviewViewport);
  assert.equal(reference.pageUrl, agent.webContents.getURL());
  assert.match(
    stored.content.at(-1).text,
    new RegExp(`screenshot:${reference.id} \\(1440×900, dark\\)`),
  );
  const saved = await agentScreenshotStore().read(reference.id);
  assert.equal(saved.metadata.toolCallId, "smoke-call");
  assert.equal(saved.metadata.width, 1440);
  const modelImage = stored.content.find((block) => block.type === "image");
  const { width } = nativeImage
    .createFromBuffer(Buffer.from(modelImage.data, "base64"))
    .getSize();
  assert.ok(width <= 1568);
}

async function verifyNavigationScope(call) {
  const outside = await call("navigate_page", {
    type: "url",
    url: "https://example.com/",
  });
  assert.equal(outside.isError, true);
  assert.match(textContent(outside), /can only open this story's preview/);
  // A page script cannot take the browser off the preview either.
  assertToolSuccess(
    await call("evaluate_script", {
      expression: 'location.href = "https://example.com/", 1',
    }),
  );
  assert.equal(new URL(agent.webContents.getURL()).origin, previewOrigin);
  assertToolSuccess(
    await call("navigate_page", { type: "url", url: "/?agent=1" }),
  );
  assert.equal(agent.webContents.getURL(), `${currentUrl}?agent=1`);
}

async function screenshot(call, name) {
  const result = await call("take_screenshot");
  const block = result.content.find((entry) => entry.type === "image");
  assert.ok(block?.data, textContent(result));
  const buffer = Buffer.from(block.data, "base64");
  await writeFile(join(artifacts, `${name}.png`), buffer);
  const image = nativeImage.createFromBuffer(buffer);
  const { width, height } = image.getSize();
  return { brightness: averageBrightness(image.toBitmap()), height, width };
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

// agent-browser only attached to the proxy: no Chrome for Testing was
// downloaded into its home, and no other browser process runs from it.
function assertNoBrowserLaunched() {
  const processes = execFileSync("ps", ["-axo", "ppid=,command="], {
    encoding: "utf8",
  });
  assert.doesNotMatch(processes, /Chrome for Testing|chrome-headless-shell/u);
  const home = join(artifacts, "agent-browser");
  const downloaded = execFileSync("find", [home, "-iname", "*chrome*"], {
    encoding: "utf8",
  }).trim();
  assert.equal(downloaded, "", `agent-browser downloaded ${downloaded}`);
  assert.ok(agentBrowserExecutable());
}

// Linux only: the Electron process must not listen on any TCP port other
// than the fixture server.
async function assertNoListeningPorts(label) {
  if (process.platform !== "linux") return;
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

function listen(target) {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolve);
  });
}
