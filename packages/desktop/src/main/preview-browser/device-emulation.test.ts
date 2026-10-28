import assert from "node:assert/strict";
import test from "node:test";
import { emulatePreviewDevice, previewDeviceSize } from "./device-emulation.ts";

test("phone and tablet emulation keeps the logical viewport while fitting the panel", () => {
  assert.deepEqual(previewDeviceSize("phone"), { width: 390, height: 844 });
  assert.deepEqual(previewDeviceSize("tablet"), { width: 820, height: 1180 });
  const calls: unknown[] = [];
  const contents = {
    enableDeviceEmulation: (value: unknown) => calls.push(value),
    setUserAgent: (value: unknown) => calls.push(value),
    debugger: {
      isAttached: () => false,
      attach() {},
      sendCommand: async (...values: unknown[]) => {
        calls.push(values);
      },
    },
  };
  emulatePreviewDevice(contents as never, "phone", { width: 195, height: 422 });
  assert.deepEqual(calls[0], {
    screenPosition: "mobile",
    screenSize: { width: 390, height: 844 },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: 3,
    viewSize: { width: 390, height: 844 },
    scale: 0.5,
  });
  assert.match(String(calls[1]), /Mobile/);
  assert.deepEqual(calls[2], [
    "Emulation.setTouchEmulationEnabled",
    { enabled: true, maxTouchPoints: 5 },
  ]);
});
