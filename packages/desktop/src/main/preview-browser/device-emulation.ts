import type { WebContents } from "electron";
export function previewDeviceSize(device: "phone" | "tablet") {
  return device === "phone"
    ? { width: 390, height: 844 }
    : { width: 820, height: 1180 };
}
type Emulation = {
  device: "phone" | "tablet";
  bounds?: { width: number; height: number };
};
const emulations = new WeakMap<WebContents, Emulation>();

/**
 * Emulates a phone or tablet. Electron crashes when device emulation starts
 * before the page has a renderer, so it is applied once the page is ready
 * and again after each navigation.
 */
export function emulatePreviewDevice(
  contents: WebContents,
  device: "phone" | "tablet",
  bounds?: { width: number; height: number },
) {
  const known = emulations.has(contents);
  emulations.set(contents, { device, bounds });
  if (!known) {
    // The first request must already carry the mobile user agent.
    contents.setUserAgent(
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    );
    contents.on("dom-ready", () => applyEmulation(contents));
  }
  if (contents.getURL() && !contents.isLoading()) applyEmulation(contents);
}

function applyEmulation(contents: WebContents) {
  const emulation = emulations.get(contents);
  if (!emulation || contents.isDestroyed()) return;
  const size = previewDeviceSize(emulation.device);
  const { bounds } = emulation;
  contents.enableDeviceEmulation({
    screenPosition: "mobile",
    screenSize: size,
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: 3,
    viewSize: size,
    scale: bounds
      ? Math.max(
          0.01,
          Math.min(bounds.width / size.width, bounds.height / size.height),
        )
      : 1,
  });
  // No touch emulation: it needs the page's debugger, which the agent's
  // DevTools connection must be able to take.
}
