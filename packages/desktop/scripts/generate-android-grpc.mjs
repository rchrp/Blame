import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname } from "node:path";

// Source: Android Emulator 37.2.12, archive build 16428233, SHA-256
// b08fc43d8608d2955f607f1b287beb525041e730086bdca3af152accac3af9c1.
const source = new URL(
  "../src/main/preview-devices/protocol/emulator_controller.proto",
  import.meta.url,
);
if (
  createHash("sha256").update(readFileSync(source)).digest("hex") !==
  "564e00a929e7e4a7af78269a738ea715f32d88c0fc9f92659bb8a1251c9d558f"
)
  throw new Error("Review the pinned emulator proto before regenerating.");
const require = createRequire(import.meta.url);
const protobuf = require(
  require.resolve("protobufjs", {
    paths: [dirname(require.resolve("@grpc/proto-loader"))],
  }),
);
const root = new protobuf.Root();
root.loadSync(source.pathname);
root.resolveAll();
const schema = root.toJSON();
const service =
  schema.nested.android.nested.emulation.nested.control.nested
    .EmulatorController;
const used = new Set([
  "streamScreenshot",
  "getScreenshot",
  "sendTouch",
  "sendKey",
]);
service.methods = Object.fromEntries(
  Object.entries(service.methods).filter(([name]) => used.has(name)),
);
writeFileSync(
  new URL(
    "../src/main/preview-devices/protocol/emulator-controller-schema.json",
    import.meta.url,
  ),
  JSON.stringify(schema, null, 2) + "\n",
);
