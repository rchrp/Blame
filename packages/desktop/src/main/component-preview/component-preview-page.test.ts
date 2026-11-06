import assert from "node:assert/strict";
import test from "node:test";
import {
  openComponentPreviewPage,
  type ComponentPreviewWindow,
} from "./component-preview-page.ts";

const origin = "http://127.0.0.1:41234";
const pageUrl = `${origin}/__blame_component_preview__/t?file=card.blame-preview.tsx`;

// A BrowserWindow that behaves like Electron's: before a document has
// loaded, the DevTools protocol never answers.
function fakeWindow(options: { hang?: string; loadHangs?: boolean } = {}) {
  const calls: string[] = [];
  const commands: Array<{ method: string; params: unknown }> = [];
  const state = { attached: false, destroyed: false, loaded: false };
  const window = {
    destroy: () => {
      state.destroyed = true;
    },
    isDestroyed: () => state.destroyed,
    webContents: {
      debugger: {
        attach: () => {
          calls.push("attach");
          state.attached = true;
        },
        isAttached: () => state.attached,
        sendCommand: (method: string, params: unknown) => {
          calls.push(method);
          commands.push({ method, params });
          if (!state.loaded || method === options.hang)
            return new Promise(() => undefined);
          return Promise.resolve(
            method === "Page.captureScreenshot" ? { data: "iVBORw0KGgo=" } : {},
          );
        },
      },
      executeJavaScriptInIsolatedWorld: async (
        _world: number,
        scripts: Array<{ code: string }>,
      ) =>
        scripts[0]!.code.includes("blamePreviewStatus")
          ? { height: 1_200, message: null, overlay: null, status: "ready" }
          : true,
      loadURL: (url: string) => {
        calls.push(`load ${url}`);
        if (options.loadHangs) return new Promise<void>(() => undefined);
        state.loaded = true;
        return Promise.resolve();
      },
      on: () => undefined,
      setAudioMuted: () => undefined,
      setWindowOpenHandler: () => undefined,
      stop: () => undefined,
    },
  };
  return {
    calls,
    commands,
    state,
    window: window as unknown as ComponentPreviewWindow,
  };
}

test("a page loads about:blank before its first emulation", async () => {
  const fake = fakeWindow();
  const page = await openComponentPreviewPage(fake.window, {
    commandTimeoutMs: 1_000,
    origin,
  });
  const capture = await page.capture({
    theme: "dark",
    timeoutMs: 5_000,
    url: pageUrl,
    width: 390,
  });
  assert.deepEqual(fake.calls, [
    "load about:blank",
    "attach",
    "Emulation.setDeviceMetricsOverride",
    "Emulation.setEmulatedMedia",
    `load ${pageUrl}`,
    "Page.captureScreenshot",
  ]);
  assert.deepEqual(fake.commands[1]!.params, {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  assert.equal(capture.status, "ready");
  assert.deepEqual(capture.viewport, { height: 900, width: 390 });
  assert.ok(capture.image?.length);
  // The screenshot covers the page's full height.
  assert.deepEqual((fake.commands.at(-1)!.params as { clip: unknown }).clip, {
    height: 1_200,
    scale: 1,
    width: 390,
    x: 0,
    y: 0,
  });
});

test("a DevTools command that never answers fails after its timeout", async () => {
  const fake = fakeWindow({ hang: "Emulation.setDeviceMetricsOverride" });
  const page = await openComponentPreviewPage(fake.window, {
    commandTimeoutMs: 20,
    origin,
  });
  await assert.rejects(
    page.capture({
      theme: "light",
      timeoutMs: 5_000,
      url: pageUrl,
      width: 1_280,
    }),
    /did not answer Emulation\.setDeviceMetricsOverride/u,
  );
});

test("a page that cannot open about:blank is closed", async () => {
  const fake = fakeWindow({ loadHangs: true });
  let closed = 0;
  await assert.rejects(
    openComponentPreviewPage(fake.window, {
      commandTimeoutMs: 20,
      onClose: () => {
        closed += 1;
      },
      origin,
    }),
    /did not open/u,
  );
  assert.equal(closed, 1);
  assert.equal(fake.state.destroyed, true);
  assert.deepEqual(fake.calls, ["load about:blank"]);
});
