import assert from "node:assert/strict";
import test from "node:test";
import { desktopResourcePaths } from "./desktop-resource-paths.ts";

test("resolves packaged resources independently from the main process chunk", () => {
  assert.deepEqual(desktopResourcePaths("/opt/Blame/resources/app.asar"), {
    agentRuntime:
      "/opt/Blame/resources/app.asar/out/main/agent-runtime-process.js",
    linuxWindowIcon: "/opt/Blame/resources/app.asar/icons/prod/icon.png",
    preload: "/opt/Blame/resources/app.asar/out/preload/index.js",
    renderer: "/opt/Blame/resources/app.asar/out/renderer/index.html",
  });
});
