import { deviceRuntime, type DeviceScope } from "./device-runtime.ts";

export async function deviceAction(
  scope: DeviceScope,
  args: Record<string, unknown>,
) {
  const runtime = deviceRuntime();
  const availability = await runtime.availability(scope);
  if (args.action === "status")
    return { ...runtime.service.status(scope.storyId), availability };
  if (args.action === "build_and_run") return runtime.start(scope);
  if (availability.status !== "ready")
    return {
      status: "unavailable",
      availability,
      message: "Set up this device on your computer before using it.",
    };
  const { driver, handle, target, environment } = runtime.service.active(
      scope.storyId,
    ),
    input = driver.input(handle);
  const point = (name: string, maximum: number) => {
    const value = Number(args[name]);
    if (!Number.isFinite(value) || value < 0 || value > maximum)
      throw new Error(`Choose ${name} inside the device screen.`);
    return value;
  };
  const text = (name: string, max = 64000) => {
    const value = args[name];
    if (typeof value !== "string" || value.length > max || value.includes("\0"))
      throw new Error(`Invalid device ${name}.`);
    return value;
  };
  switch (args.action) {
    case "screenshot":
      return {
        status: "ready",
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: (await driver.screen(handle).screenshot()).toString("base64"),
          },
        ],
      };
    case "describe_ui":
      return {
        status: "ready",
        nodes: (await driver.describeUi(handle)).slice(0, 400),
        units: "points",
      };
    case "tap":
      await input.tap(
        point("x", handle.pointWidth),
        point("y", handle.pointHeight),
      );
      break;
    case "swipe":
      await input.swipe(
        point("x", handle.pointWidth),
        point("y", handle.pointHeight),
        point("toX", handle.pointWidth),
        point("toY", handle.pointHeight),
      );
      break;
    case "type":
      await input.type(text("text"));
      break;
    case "key":
      await input.key(text("key", 100));
      break;
    case "button":
      await input.button(text("button", 30));
      break;
    case "open_url": {
      const url = text("url", 2048);
      if (
        !/^[a-z][a-z0-9+.-]*:/i.test(url) ||
        /^(?:file|javascript|data):/i.test(url) ||
        /[\r\n]/.test(url)
      )
        throw new Error("Enter an app deep link or an HTTP URL.");
      await input.openUrl(url);
      break;
    }
    case "appearance":
      if (args.value !== "light" && args.value !== "dark")
        throw new Error("Choose light or dark appearance.");
      await input.appearance(args.value);
      break;
    case "restart":
      if (target.toolchain === "flutter") return runtime.start(scope);
      await driver.terminate(handle, target);
      await driver.launch(handle, target, environment);
      break;
    case "logs":
      return {
        status: "ready",
        logs: runtime.service.status(scope.storyId).logs.slice(-200),
      };
    default:
      throw new Error("Unknown device action.");
  }
  return { status: "ready", message: "Done" };
}
