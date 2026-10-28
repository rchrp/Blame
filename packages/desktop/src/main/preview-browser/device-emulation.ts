import type { WebContents } from "electron";
export function previewDeviceSize(device: "phone" | "tablet") {
  return device === "phone"
    ? { width: 390, height: 844 }
    : { width: 820, height: 1180 };
}
export function emulatePreviewDevice(
  contents: WebContents,
  device: "phone" | "tablet",
  bounds?: { width: number; height: number },
) {
  const size = previewDeviceSize(device);
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
  contents.setUserAgent(
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  );
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  void contents.debugger
    .sendCommand("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    })
    .catch(() => undefined);
}
