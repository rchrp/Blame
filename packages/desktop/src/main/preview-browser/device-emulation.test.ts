import assert from "node:assert/strict";
import test from "node:test";
import { emulatePreviewDevice, previewDeviceSize } from "./device-emulation.ts";

test("phone and tablet emulation waits for the page and keeps the logical viewport", () => {
  assert.deepEqual(previewDeviceSize("phone"), { width: 390, height: 844 });
  assert.deepEqual(previewDeviceSize("tablet"), { width: 820, height: 1180 });
  const calls: unknown[] = [];
  const listeners = new Map<string, () => void>();
  let url = "";
  const contents = {
    enableDeviceEmulation: (value: unknown) => calls.push(value),
    setUserAgent: (value: unknown) => calls.push(value),
    on: (event: string, listener: () => void) => listeners.set(event, listener),
    getURL: () => url,
    isLoading: () => false,
    isDestroyed: () => false,
    debugger: {
      attach() {
        throw new Error("The agent needs the page's debugger.");
      },
    },
  };
  // Electron crashes when emulation starts before the page has a renderer.
  emulatePreviewDevice(contents as never, "phone");
  assert.equal(calls.length, 1);
  assert.match(String(calls[0]), /Mobile/);
  url = "http://localhost:5173/";
  listeners.get("dom-ready")?.();
  emulatePreviewDevice(contents as never, "phone", { width: 195, height: 422 });
  assert.deepEqual(calls.at(-1), {
    screenPosition: "mobile",
    screenSize: { width: 390, height: 844 },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: 3,
    viewSize: { width: 390, height: 844 },
    scale: 0.5,
  });
  assert.equal(calls.filter((call) => typeof call === "string").length, 1);
});
