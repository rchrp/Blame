import assert from "node:assert/strict";
import { test } from "node:test";
import {
  installScript,
  vmEngineDataDir,
  vmEngineInstallDir,
  vmEngineInstallRoot,
  vmServeCommand,
} from "./vm-engine.ts";

test("each engine build gets its own folder in the VM", () => {
  const a = vmEngineInstallDir("a".repeat(64));
  const b = vmEngineInstallDir("b".repeat(64));
  assert.match(a, new RegExp(`^${vmEngineInstallRoot}/[0-9a-f]{16}$`));
  assert.notEqual(a, b);
  assert.equal(a, vmEngineInstallDir("a".repeat(64)));
});

test("on macOS the VM's engine is served through the Lima wrapper", () => {
  const command = vmServeCommand(
    { platform: "darwin", wrapper: "/app/bin/blame-lima-runtime", env: {} },
    "/usr/local/lib/blame/engine/0123456789abcdef",
  );
  assert.equal(command.command, "/app/bin/blame-lima-runtime");
  assert.deepEqual(command.args, [
    "/usr/local/lib/blame/engine/0123456789abcdef/blame-engine",
    "serve",
    "--data-dir",
    vmEngineDataDir,
    "--harness-command",
    "/usr/local/lib/blame/engine/0123456789abcdef/harness",
  ]);
});

test("on Windows it runs in the distro as the blame user, without a shell", () => {
  const command = vmServeCommand(
    { platform: "win32", distro: "BlameRuntime", wsl: "wsl.exe", env: {} },
    "/usr/local/lib/blame/engine/0123456789abcdef",
  );
  assert.equal(command.command, "wsl.exe");
  assert.deepEqual(command.args.slice(0, 6), [
    "-d",
    "BlameRuntime",
    "-u",
    "blame",
    "--exec",
    "/usr/local/lib/blame/engine/0123456789abcdef/blame-engine",
  ]);
});

test("the install checks the copy and makes it executable (the Windows package drops the bit)", () => {
  assert.match(installScript, /sha256sum -c/);
  assert.match(installScript, /chmod 755 "\$staging\/blame-engine"/);
  assert.match(installScript, /mv "\$staging" "\$dir"/);
});
