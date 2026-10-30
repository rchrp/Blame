import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findHostGit,
  hostGitCommand,
  HostGitMissingError,
  isHostGitMissingError,
} from "./host-git.ts";
import { run, runtimeExecutableCommand } from "./workspace-runtime.ts";

const windowsEnv = {
  LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local`,
  ProgramFiles: String.raw`C:\Program Files`,
  "ProgramFiles(x86)": String.raw`C:\Program Files (x86)`,
  USERPROFILE: String.raw`C:\Users\dev`,
};

function onlyExisting(...paths: string[]) {
  return (path: string) => paths.includes(path);
}

test("Windows without Git on PATH explains what to install", () => {
  const error = (() => {
    try {
      hostGitCommand({
        env: { ...windowsEnv, Path: String.raw`C:\Windows\System32` },
        exists: () => false,
        listDirectory: () => [],
        platform: "win32",
      });
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(error instanceof HostGitMissingError);
  assert.equal(isHostGitMissingError(error), true);
  assert.match(error.message, /Git for Windows/);
  assert.match(error.message, /https:\/\/git-scm\.com\/download\/win/);
  assert.match(error.message, /winget install --id Git\.Git/);
  assert.doesNotMatch(error.message, /cmd\.exe/);
});

test("Windows finds git.exe on PATH whatever the variable's case", () => {
  const git = String.raw`D:\Tools\Git\cmd\git.exe`;
  assert.equal(
    findHostGit({
      env: { ...windowsEnv, Path: String.raw`C:\Windows;"D:\Tools\Git\cmd"` },
      exists: onlyExisting(git),
      platform: "win32",
    }),
    git,
  );
});

test("Windows finds Git installed outside PATH", () => {
  const env = { ...windowsEnv, PATH: String.raw`C:\Windows\System32` };
  const programFiles = String.raw`C:\Program Files\Git\cmd\git.exe`;
  const perUser = String.raw`C:\Users\dev\AppData\Local\Programs\Git\cmd\git.exe`;
  const scoop = String.raw`C:\Users\dev\scoop\shims\git.exe`;
  for (const git of [programFiles, perUser, scoop]) {
    assert.equal(
      findHostGit({ env, exists: onlyExisting(git), platform: "win32" }),
      git,
    );
  }
});

test("Windows falls back to the newest GitHub Desktop Git", () => {
  const root = String.raw`C:\Users\dev\AppData\Local\GitHubDesktop`;
  const git = `${root}\\app-3.10.1\\resources\\app\\git\\cmd\\git.exe`;
  const older = `${root}\\app-3.9.0\\resources\\app\\git\\cmd\\git.exe`;
  assert.equal(
    findHostGit({
      env: { ...windowsEnv, PATH: "" },
      exists: onlyExisting(git, older),
      listDirectory: (path) =>
        path === root ? ["app-3.9.0", "app-3.10.1", "packages"] : [],
      platform: "win32",
    }),
    git,
  );
});

test("BLAME_GIT_PATH overrides the search", () => {
  const git = String.raw`E:\PortableGit\cmd\git.exe`;
  assert.equal(
    findHostGit({
      env: { ...windowsEnv, BLAME_GIT_PATH: git, PATH: "" },
      exists: onlyExisting(git),
      platform: "win32",
    }),
    git,
  );
});

test("macOS and Linux keep PATH lookup and report a missing Git", () => {
  assert.equal(
    findHostGit({
      env: { PATH: "/opt/tools/bin:/usr/bin" },
      exists: onlyExisting("/usr/bin/git"),
      platform: "darwin",
    }),
    "git",
  );
  assert.equal(
    findHostGit({
      env: { PATH: "/opt/tools/bin" },
      exists: onlyExisting("/opt/homebrew/bin/git"),
      platform: "darwin",
    }),
    "/opt/homebrew/bin/git",
  );
  assert.throws(
    () =>
      hostGitCommand({
        env: { PATH: "/opt/tools/bin" },
        exists: () => false,
        platform: "linux",
      }),
    /Git is not installed on this computer/,
  );
});

test("native Windows Git runs git.exe directly, never through cmd.exe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blame-host-git-"));
  const git = join(directory, "git.exe");
  await writeFile(git, "");
  try {
    const spec = runtimeExecutableCommand(
      { args: ["init"], command: "git", cwd: String.raw`C:\Projects\app` },
      "win32",
      { BLAME_GIT_PATH: git, PATH: String.raw`C:\Windows\System32` },
    );
    assert.deepEqual(spec, {
      args: ["init"],
      command: git,
      cwd: String.raw`C:\Projects\app`,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

// The 2026-10-27 regression: starting a story ran `git init` through
// cmd.exe and surfaced its localized "not recognized" message.
test("Windows looks for Git only under the environment's folders", () => {
  const probed: string[] = [];
  findHostGit({
    env: {
      Path: String.raw`X:\bin`,
      ProgramFiles: String.raw`X:\Program Files`,
      SystemDrive: "X:",
    },
    exists: (path) => {
      probed.push(path);
      return false;
    },
    listDirectory: () => [],
    platform: "win32",
  });
  assert.ok(probed.includes(String.raw`X:\Program Files\Git\cmd\git.exe`));
  assert.deepEqual(
    probed.filter((path) => !path.startsWith("X:\\")),
    [],
  );
});

// The 2026-10-27 regression: starting a story ran `git init` through
// cmd.exe and surfaced its localized "not recognized" message. Every place
// Git could be installed points at an empty folder, even on a machine (or CI
// runner) that has Git.
test("a story's git init without Git fails with the install instructions", async () => {
  const empty = await mkdtemp(join(tmpdir(), "blame-no-git-"));
  try {
    await assert.rejects(
      run("git", ["init"], {
        cwd: empty,
        env: {
          LOCALAPPDATA: empty,
          Path: empty,
          ProgramFiles: empty,
          "ProgramFiles(x86)": empty,
          ProgramW6432: empty,
          SCOOP: empty,
          SystemDrive: empty,
          SystemRoot: empty,
          USERPROFILE: empty,
        },
        execution: "native",
        platform: "win32",
      }),
      (error: Error) => {
        assert.ok(isHostGitMissingError(error), error.message);
        assert.match(error.message, /Install Git for Windows/);
        assert.doesNotMatch(error.message, /cmd\.exe|n'est pas reconnu/);
        return true;
      },
    );
  } finally {
    await rm(empty, { force: true, recursive: true });
  }
});

test("other native Windows commands keep cmd.exe's own quoting", () => {
  const spec = runtimeExecutableCommand(
    { args: ["install", "a & b"], command: "pnpm" },
    "win32",
    { PATH: String.raw`C:\Windows\System32` },
  );
  assert.equal(spec.command, "cmd.exe");
  assert.deepEqual(spec.args, [
    "/d",
    "/s",
    "/c",
    'call "pnpm" "install" "a ^& b"',
  ]);
  // Without this, Node re-quotes the line as \"pnpm\" and cmd.exe cannot
  // find the command.
  assert.equal(spec.windowsVerbatimArguments, true);
});

test(
  "cmd.exe runs a native command line exactly as written",
  { skip: process.platform !== "win32" },
  async () => {
    const { stdout } = await run("where", ["cmd"], { execution: "native" });
    assert.match(stdout, /cmd\.exe/i);
  },
);

test(
  "this machine's Git runs natively",
  { skip: process.platform !== "win32" },
  async () => {
    const { stdout } = await run("git", ["--version"], {
      execution: "native",
    });
    assert.match(stdout, /^git version/);
  },
);

test("desktop code starts host Git only through hostGitCommand", async () => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const offenders: string[] = [];
  for (const file of await sourceFiles(root)) {
    const source = await readFile(file, "utf8");
    if (
      // `fns.execFileAsync("git", …)` is injectable and resolves Git itself.
      /(?<![.\w])(?:execFile|execFileAsync|execFileSync|spawn|spawnSync|execa)\(\s*["'`]git["'`]/.test(
        source,
      )
    )
      offenders.push(relative(root, file));
  }
  assert.deepEqual(offenders, []);
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
        ? [path]
        : [];
    }),
  );
  return files.flat();
}
