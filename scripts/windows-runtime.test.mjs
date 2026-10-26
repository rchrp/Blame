import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "scripts/fixtures/windows-runtime");
const powershell =
  process.env.BLAME_TEST_POWERSHELL ||
  (process.platform === "win32" ? "powershell.exe" : "pwsh");
const available =
  spawnSync(powershell, ["-NoProfile", "-Command", "exit 0"], {
    timeout: 30_000,
  }).status === 0;

test(
  "Windows runtime preserves native arguments, streams and lifecycle failures",
  {
    skip:
      !available && process.platform !== "win32"
        ? "PowerShell is not installed"
        : false,
    timeout: 120_000,
  },
  async () => {
    assert.ok(available, "Windows PowerShell is required on Windows");
    const temporary = await mkdtemp(join(tmpdir(), "blame-wsl-test-"));
    try {
      const runtime = join(temporary, "René O'Neil [test] $cash & tools");
      const scripts = join(runtime, "scripts");
      await mkdir(scripts, { recursive: true });
      await mkdir(join(runtime, "payloads"));
      const runtimeScript = join(scripts, "blame-wsl2-runtime.ps1");
      const source = join(root, "packages/desktop/resources/runtime/windows");
      await copyFile(
        join(source, "scripts/blame-wsl2-runtime.ps1"),
        runtimeScript,
      );
      await copyFile(
        join(source, "manifest.json"),
        join(runtime, "manifest.json"),
      );
      await writeFile(
        join(scripts, "provision-blame-runtime.sh"),
        "echo provision\r\n",
      );
      await writeFile(
        join(runtime, "payloads/blame-semantic-harness.tgz"),
        "fixture",
      );
      const shadowModuleRoot = join(temporary, "foreign-modules");
      const shadowModule = join(
        shadowModuleRoot,
        "Microsoft.PowerShell.Utility",
      );
      await mkdir(shadowModule, { recursive: true });
      await writeFile(
        join(shadowModule, "Microsoft.PowerShell.Utility.psd1"),
        `@{
  RootModule = 'Microsoft.PowerShell.Utility.psm1'
  ModuleVersion = '99.0.0'
  FunctionsToExport = @('Get-FileHash', 'ConvertFrom-Json')
  CmdletsToExport = @()
  AliasesToExport = @()
}`,
      );
      await writeFile(
        join(shadowModule, "Microsoft.PowerShell.Utility.psm1"),
        "throw 'An incompatible inherited Utility module was selected.'\n",
      );
      const modules = spawnSync(
        powershell,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(fixture, "check-module-loading.ps1"),
          "-RuntimeScript",
          runtimeScript,
          "-ShadowModuleRoot",
          shadowModuleRoot,
          "-ExpectedHash",
          createHash("sha256").update("fixture").digest("hex"),
        ],
        { cwd: temporary, encoding: "utf8", timeout: 30_000 },
      );
      assert.equal(modules.status, 0, modules.stderr + modules.stdout);
      assert.match(modules.stdout, /Runtime module isolation checks passed/);
      if (process.platform !== "win32") {
        const shellQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
        const executable = join(temporary, "wsl.exe");
        await writeFile(
          executable,
          `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(fixture, "fake-wsl.mjs"))} "$@"\n`,
        );
        await chmod(executable, 0o755);
      }
      const result = spawnSync(
        powershell,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(fixture, "check-runtime.ps1"),
          "-RuntimeScript",
          runtimeScript,
          "-FixtureRoot",
          temporary,
          "-NativeFixture",
          join(fixture, "fake-wsl.cs"),
        ],
        { cwd: temporary, encoding: "utf8", timeout: 90_000 },
      );
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /Windows runtime process checks passed/);

      // Invoke the actual script entry point too: it must preserve the command's
      // output, literal argv and nonzero exit status without NativeCommandError.
      const args = ["root", "printf", "%s", "$HOME $(whoami)", 'a"b', ""];
      const command = spawnSync(
        powershell,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          runtimeScript,
          ...args,
        ],
        {
          cwd: temporary,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            PATH: `${temporary}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
            BLAME_WSL_DISTRO: "BlameRuntime",
            BLAME_TEST_WSL_LOG: join(temporary, "command.jsonl"),
          },
        },
      );
      assert.equal(command.status, 29, command.stderr + command.stdout);
      assert.deepEqual(JSON.parse(command.stdout), [
        "-d",
        "BlameRuntime",
        "-u",
        "root",
        "--exec",
        ...args.slice(1),
      ]);
      assert.equal(command.stderr, "command warning");
      assert.ok(
        (await readFile(join(temporary, "calls.jsonl"), "utf8")).length > 0,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
