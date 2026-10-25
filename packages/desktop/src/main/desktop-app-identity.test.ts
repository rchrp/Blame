import {
  desktopRuntimeEnvironment,
  runtimeDistroName,
} from "./desktop-runtime-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { desktopAppIdentity } from "./desktop-app-identity.ts";

test("uses the release identity for packaged applications", () => {
  assert.deepEqual(desktopAppIdentity(true), {
    appId: "dev.blame.desktop",
    name: "Blame",
  });
});

test("uses a separate identity for local development", () => {
  assert.deepEqual(desktopAppIdentity(false), {
    appId: "dev.blame.desktop.development",
    name: "Blame Dev",
  });
});

test("isolates development runtime state while preserving production and overrides", () => {
  const base = {
    env: {},
    home: "/Users/example",
    isPackaged: true,
    platform: "darwin" as const,
  };
  assert.equal(
    desktopRuntimeEnvironment(base).LIMA_HOME,
    "/Users/example/Library/Application Support/Blame/runtime/lima",
  );
  assert.equal(
    desktopRuntimeEnvironment({ ...base, isPackaged: false }).LIMA_HOME,
    "/Users/example/Library/Application Support/Blame Dev/runtime/lima",
  );
  assert.equal(
    desktopRuntimeEnvironment({
      ...base,
      isPackaged: false,
      env: { LIMA_HOME: "/custom/lima" },
    }).LIMA_HOME,
    "/custom/lima",
  );
  for (const isPackaged of [true, false]) {
    const env = desktopRuntimeEnvironment({
      ...base,
      isPackaged,
      platform: "win32",
    });
    assert.equal(
      runtimeDistroName(env),
      isPackaged ? "BlameRuntime" : "BlameRuntimeDev",
    );
  }
  assert.equal(
    runtimeDistroName(
      desktopRuntimeEnvironment({
        ...base,
        platform: "win32",
        env: { BLAME_WSL_DISTRO: "Custom" },
      }),
    ),
    "Custom",
  );
  assert.deepEqual(
    desktopRuntimeEnvironment({ ...base, platform: "linux" }),
    {},
  );
});
