import assert from "node:assert/strict";
import test from "node:test";

import {
  runtimeToolCommand,
  runtimeToolEnvironment,
  setupPath,
} from "./host-tool-path.ts";

test("adds Windows package manager shim paths", () => {
  const path = setupPath({
    env: {
      APPDATA: String.raw`C:\Users\dev\AppData\Roaming`,
      LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local`,
      PATH: String.raw`C:\Windows\System32`,
      ProgramFiles: String.raw`C:\Program Files`,
      USERPROFILE: String.raw`C:\Users\dev`,
    },
    execPath: String.raw`C:\Blame\Blame.exe`,
    platform: "win32",
  });
  const entries = path.split(";");

  assert.equal(
    entries.includes(String.raw`C:\Blame\resources\runtime\windows\bin`),
    true,
  );
  assert.equal(
    entries.includes(String.raw`C:\Users\dev\AppData\Roaming\npm`),
    true,
  );
  assert.equal(
    entries.includes(String.raw`C:\Users\dev\AppData\Local\pnpm`),
    true,
  );
  assert.equal(entries.includes(String.raw`C:\Program Files\nodejs`), true);
});

test("puts the packaged macOS runtime commands on the runtime tools' PATH", () => {
  const env = runtimeToolEnvironment({
    env: { HOME: "/Users/dev", PATH: "/usr/bin:/bin" },
    execPath: "/Applications/Blame.app/Contents/MacOS/Blame",
    platform: "darwin",
  });

  assert.equal(env.HOME, "/Users/dev");
  assert.equal(
    env.PATH?.split(":").includes(
      "/Applications/Blame.app/Contents/Resources/runtime/macos/bin",
    ),
    true,
  );
  assert.equal(env.PATH?.split(":").includes("/usr/bin"), true);
});

test("resolves Windows runtime wrapper commands from packaged resources", () => {
  const command = runtimeToolCommand("blame-wsl2-runtime", {
    env: {
      PATH: String.raw`C:\Windows\System32`,
    },
    execPath: String.raw`C:\Blame\Blame.exe`,
    platform: "win32",
  });

  assert.equal(command, "blame-wsl2-runtime.cmd");
});

test("adds macOS packaged runtime shim path", () => {
  const path = setupPath({
    env: {
      HOME: "/Users/dev",
      PATH: "/usr/bin",
    },
    execPath: "/Applications/Blame.app/Contents/MacOS/Blame",
    platform: "darwin",
  });
  const entries = path.split(":");

  assert.equal(
    entries.includes(
      "/Applications/Blame.app/Contents/Resources/runtime/macos/bin",
    ),
    true,
  );
});

test("adds the explicit macOS development runtime shim path", () => {
  const path = setupPath({
    env: {
      BLAME_RUNTIME_BIN_DIR:
        "/workspace/Blame/packages/desktop/resources/runtime/macos/bin",
      HOME: "/Users/dev",
      PATH: "/usr/bin",
    },
    execPath:
      "/workspace/Blame/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    platform: "darwin",
  });
  const entries = path.split(":");

  assert.equal(
    entries[1],
    "/workspace/Blame/packages/desktop/resources/runtime/macos/bin",
  );
});
