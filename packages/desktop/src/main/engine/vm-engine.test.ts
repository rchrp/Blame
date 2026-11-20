import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  installScript,
  vmHarnessLauncher,
  vmEngineDataDir,
  vmEngineInstallDir,
  vmEngineInstallRoot,
  vmServeCommand,
} from "./vm-engine.ts";

test("each engine and harness build gets its own folder in the VM", () => {
  const a = vmEngineInstallDir("a".repeat(64), "c".repeat(64));
  const b = vmEngineInstallDir("b".repeat(64), "c".repeat(64));
  const c = vmEngineInstallDir("a".repeat(64), "d".repeat(64));
  assert.match(a, new RegExp(`^${vmEngineInstallRoot}/[0-9a-f]{16}$`));
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(a, vmEngineInstallDir("a".repeat(64), "c".repeat(64)));
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

test("the install checks both copies and makes them executable (the Windows package drops the bit)", () => {
  assert.equal(installScript.match(/sha256sum -c/g)?.length, 2);
  assert.match(installScript, /head -c "\$engine_size" > "\$staging\/blame-engine"/);
  assert.match(installScript, /chmod 755 "\$staging\/blame-engine" "\$staging\/blame-harness"/);
  assert.match(installScript, /mv "\$staging" "\$dir"/);
});

test("the launcher runs blame-harness with the payload the runtime installed", () => {
  const root = mkdtempSync(join(tmpdir(), "vm-harness-launcher-"));
  try {
    const install = join(root, "engine");
    const harness = join(root, "lib/node_modules/@blame/semantic-harness-runtime/harness");
    const bin = join(root, "bin");
    for (const directory of [install, harness, bin]) mkdirSync(directory, { recursive: true });
    // npm makes a package's command executable.
    writeFileSync(join(harness, "rust-harness-compiler.js"), "");
    chmodSync(join(harness, "rust-harness-compiler.js"), 0o755);
    symlinkSync(join(harness, "rust-harness-compiler.js"), join(bin, "blame-semantic-harness"));
    writeFileSync(join(install, "harness"), vmHarnessLauncher);
    // Stands in for blame-harness: says what it was given.
    writeFileSync(
      join(install, "blame-harness"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" "$BLAME_HARNESS_COMPILER" "$BLAME_HARNESS_NODE_ASSETS" "$BLAME_HARNESS_NODE_MODULES"\n',
    );
    chmodSync(join(install, "harness"), 0o755);
    chmodSync(join(install, "blame-harness"), 0o755);
    const output = execFileSync(join(install, "harness"), {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin` },
    }).split("\n");
    const real = execFileSync("realpath", [harness], { encoding: "utf8" }).trim();
    assert.equal(output[0], "serve --asks");
    assert.deepEqual(JSON.parse(output[1]!), ["node", join(real, "rust-harness-compiler.js")]);
    assert.equal(output[2], real);
    assert.equal(output[3], join(real, "..", "node_modules").replace(/\/harness\/\.\.\//u, "/"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
