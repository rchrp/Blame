import assert from "node:assert/strict";
import test from "node:test";

import { desktopRuntimeEnvironment } from "./desktop-runtime-environment.ts";
import { runtimeHubPortConflict } from "./runtime-hub-port.ts";

const env = { BLAME_CLINE_HUB_PORT: "25463", LIMA_HOME: "/lima" };

test("the installed app and a dev build use their own hub port", () => {
  const build = (isPackaged: boolean, platform: NodeJS.Platform) =>
    desktopRuntimeEnvironment({
      env: {},
      home: "/Users/raph",
      isPackaged,
      platform,
    }).BLAME_CLINE_HUB_PORT;
  assert.equal(build(true, "darwin"), "25463");
  assert.equal(build(false, "darwin"), "25464");
  assert.equal(build(true, "win32"), "25463");
  assert.equal(build(false, "win32"), "25464");
});

test("names another Blame runtime holding the hub port", async () => {
  const message = await runtimeHubPortConflict(env, "darwin", {
    listener: async () => ({ pid: 65259, processName: "limactl" }),
    runtimeForwarder: async () => 55575,
  });
  assert.equal(
    message,
    "Another Blame runtime, such as a Blame Dev build's, is using port 25463 on this Mac, so Blame can't reach its own runtime. Quit it, then restart Blame.",
  );
});

test("names any other program holding the hub port", async () => {
  const message = await runtimeHubPortConflict(env, "darwin", {
    listener: async () => ({ pid: 812, processName: "node" }),
    runtimeForwarder: async () => 55575,
  });
  assert.match(message ?? "", /^node \(process 812\) is using port 25463/);
});

test("says nothing when the port is this runtime's or cannot be told", async () => {
  const check = (listener?: { pid?: number }, forwarder?: number) =>
    runtimeHubPortConflict(env, "darwin", {
      listener: async () => listener,
      runtimeForwarder: async () => forwarder,
    });
  assert.equal(await check({ pid: 55575 }, 55575), undefined);
  assert.equal(await check(undefined, 55575), undefined);
  assert.equal(await check({ pid: 812 }, undefined), undefined);
  assert.equal(
    await runtimeHubPortConflict(env, "win32", {
      listener: async () => ({ pid: 812 }),
      runtimeForwarder: async () => 55575,
    }),
    undefined,
  );
});
