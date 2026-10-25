import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runtimeCommand,
  runtimeAccessiblePath,
  runtimeHostPath,
  runtimeManagedPath,
  runtimeVmInternalPath,
  storyBranch,
  worktreePath,
  worktreeRoot,
  writeFileAtomic,
  ensureRuntimeGitUserIdentity,
  resetRuntimeGitIdentityConfiguredForTesting,
  findProjectFilesByName,
} from "./workspace-runtime.ts";
import { sanitizeWorkspaceConfigFiles } from "./workspace-config-sanitizer.ts";

test("replaces runtime state files atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blame-runtime-state-"));
  const path = join(directory, "state.json");
  try {
    await writeFileAtomic(path, '{"status":"running"}');
    await writeFileAtomic(path, '{"status":"stopped"}');
    assert.equal(await readFile(path, "utf8"), '{"status":"stopped"}');
    assert.deepEqual(await readdir(directory), ["state.json"]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("uses the VM-native worktree root on virtualized platforms", () => {
  assert.equal(
    worktreeRoot("win32"),
    "/home/blame/.local/share/blame/runtime/worktrees",
  );
  assert.equal(
    worktreeRoot("darwin", { HOME: "/Users/dev" }),
    "/home/blame/.local/share/blame/runtime/worktrees",
  );
  assert.equal(
    worktreeRoot("linux", { HOME: "/home/dev" }),
    "/home/dev/.local/share/blame/runtime/worktrees",
  );
});

test("uses native host worktree roots for managed cloud previews", () => {
  assert.equal(
    worktreeRoot("darwin", { HOME: "/Users/dev" }, "cloud-mirror"),
    "/Users/dev/Library/Application Support/Blame/cloud/worktrees",
  );
  assert.equal(
    worktreeRoot(
      "win32",
      { LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local` },
      "cloud-mirror",
    ),
    String.raw`C:\Users\dev\AppData\Local\Blame\cloud\worktrees`,
  );
  assert.equal(
    worktreeRoot("linux", { HOME: "/home/dev" }, "cloud-mirror"),
    "/home/dev/.local/share/blame/cloud/worktrees",
  );
});

test("builds stable worktree paths for every desktop platform", () => {
  const expectedRuntime =
    "/home/blame/.local/share/blame/runtime/worktrees/Blame/story-42-add-login";

  assert.equal(
    worktreePath({
      env: { HOME: "/home/dev" },
      platform: "linux",
      repositoryRoot: "/mnt/dev/web/Blame",
      storyId: "42",
      title: "Add login",
    }),
    "/home/dev/.local/share/blame/runtime/worktrees/Blame/story-42-add-login",
  );
  assert.equal(
    worktreePath({
      env: { HOME: "/Users/blame" },
      platform: "darwin",
      repositoryRoot: "/Users/blame/Blame",
      storyId: "42",
      title: "Add login",
    }),
    expectedRuntime,
  );
  assert.equal(
    worktreePath({
      platform: "win32",
      repositoryRoot: String.raw`C:\Users\blame\Blame`,
      storyId: "42",
      title: "Add login",
    }),
    expectedRuntime,
  );
});

test("builds native cloud worktree paths on macOS and Windows", () => {
  assert.equal(
    worktreePath({
      env: { HOME: "/Users/dev" },
      mode: "cloud-mirror",
      platform: "darwin",
      repositoryRoot: "/Users/dev/Blame",
      storyId: "42",
      title: "Add login",
    }),
    "/Users/dev/Library/Application Support/Blame/cloud/worktrees/Blame/story-42-add-login",
  );
  assert.equal(
    worktreePath({
      env: { LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local` },
      mode: "cloud-mirror",
      platform: "win32",
      repositoryRoot: String.raw`C:\Users\dev\Blame`,
      storyId: "42",
      title: "Add login",
    }),
    String.raw`C:\Users\dev\AppData\Local\Blame\cloud\worktrees\Blame\story-42-add-login`,
  );
});

test("findProjectFilesByName searches arbitrary paths without excluding project-like build folders", async () => {
  let args: string[] = [];
  const paths = await findProjectFilesByName("/workspace", "package.json", {
    run: async (_command, receivedArgs) => {
      args = receivedArgs;
      return {
        stdout:
          "/workspace/package.json\n/workspace/unusual/build/app/package.json\n",
      };
    },
  });

  assert.deepEqual(paths, [
    "/workspace/package.json",
    "/workspace/unusual/build/app/package.json",
  ]);
  assert.ok(args.includes("node_modules"));
  assert.ok(args.includes(".blame-preview"));
  assert.ok(args.includes(".generated"));
  assert.equal(args.includes("build"), false);
  assert.equal(args.includes("dist"), false);
});

test("keeps story branch naming unchanged", () => {
  assert.equal(storyBranch("42", "Add login"), "blame/story-42-add-login");
});

test("routes commands through the platform runtime", () => {
  assert.deepEqual(runtimeCommand("git", ["status"], { platform: "linux" }), {
    args: ["status"],
    command: "git",
    cwd: undefined,
  });
  assert.deepEqual(runtimeCommand("git", ["status"], { platform: "darwin" }), {
    args: ["git", "status"],
    command: "blame-lima-runtime",
  });
  assert.deepEqual(runtimeCommand("git", ["status"], { platform: "win32" }), {
    args: ["git", "status"],
    command: "blame-wsl2-runtime",
  });
  assert.deepEqual(
    runtimeCommand("git", ["status"], {
      cwd: "/Users/dev/Blame",
      execution: "native",
      platform: "darwin",
    }),
    { args: ["status"], command: "git", cwd: "/Users/dev/Blame" },
  );
});

test("runs runtime cwd commands inside WSL2 or Lima", () => {
  assert.deepEqual(
    runtimeCommand("git", ["status"], {
      cwd: "/home/blame/project",
      platform: "win32",
    }),
    {
      args: ["sh", "-lc", "cd '/home/blame/project' && exec 'git' 'status'"],
      command: "blame-wsl2-runtime",
    },
  );
  assert.deepEqual(
    runtimeCommand("git", ["status"], {
      cwd: String.raw`C:\Users\vanwa\Downloads\projet_test\raphtest`,
      platform: "win32",
    }),
    {
      args: [
        "sh",
        "-lc",
        "cd '/mnt/c/Users/vanwa/Downloads/projet_test/raphtest' && exec 'git' 'status'",
      ],
      command: "blame-wsl2-runtime",
    },
  );
});

test("routes root runtime commands through WSL2 or Lima", () => {
  assert.deepEqual(
    runtimeCommand("rm", ["-rf", "/home/blame/project"], {
      platform: "win32",
      user: "root",
    }),
    {
      args: ["root", "rm", "-rf", "/home/blame/project"],
      command: "blame-wsl2-runtime",
    },
  );
  assert.deepEqual(
    runtimeCommand("rm", ["-rf", "/home/blame/project"], {
      cwd: "/home/blame",
      platform: "darwin",
      user: "root",
    }),
    {
      args: [
        "root",
        "sh",
        "-lc",
        "cd '/home/blame' && exec 'rm' '-rf' '/home/blame/project'",
      ],
      command: "blame-lima-runtime",
    },
  );
});

test("converts Windows host paths to WSL paths for runtime access", () => {
  assert.equal(
    runtimeAccessiblePath(
      String.raw`C:\Users\vanwa\Downloads\projet_test\raphtest`,
      "win32",
    ),
    "/mnt/c/Users/vanwa/Downloads/projet_test/raphtest",
  );
  assert.equal(
    runtimeAccessiblePath(
      "/home/blame/.local/share/blame/runtime/worktrees/Test",
      "win32",
    ),
    "/home/blame/.local/share/blame/runtime/worktrees/Test",
  );
});

test("converts WSL runtime paths to host UNC paths for Windows agents", () => {
  assert.equal(
    runtimeHostPath(
      "/home/blame/.local/share/blame/runtime/worktrees/Test/story",
      "win32",
    ),
    String.raw`\\wsl.localhost\BlameRuntime\home\blame\.local\share\blame\runtime\worktrees\Test\story`,
  );
  assert.equal(
    runtimeHostPath("/home/dev/project", "win32"),
    "/home/dev/project",
  );
});

test("keeps macOS managed worktree paths accessible to local agents", () => {
  const path =
    "/Users/dev/Library/Application Support/Blame/runtime/worktrees/Test/story";

  assert.equal(runtimeHostPath(path, "darwin"), path);
  assert.equal(runtimeAccessiblePath(path, "darwin"), path);
});

test("detects runtime-managed paths only on Windows and macOS", () => {
  const path = "/home/blame/.local/share/blame/runtime/worktrees/repo/story";

  assert.equal(runtimeManagedPath(path, "linux"), false);
  assert.equal(runtimeManagedPath(path, "darwin"), true);
  assert.equal(runtimeManagedPath(path, "win32"), true);
  assert.equal(
    runtimeManagedPath(
      "/Users/dev/Library/Application Support/Blame/runtime/worktrees/repo/story",
      "darwin",
    ),
    true,
  );
  assert.equal(
    runtimeManagedPath(
      "/Users/dev/Library/Application Support/Blame/cloud/worktrees/repo/story",
      "darwin",
    ),
    false,
  );
  assert.equal(
    runtimeManagedPath(
      String.raw`C:\Users\dev\AppData\Local\Blame\cloud\worktrees\repo\story`,
      "win32",
    ),
    false,
  );
});

test("distinguishes VM-internal worktrees from legacy macOS shared worktrees", () => {
  assert.equal(
    runtimeVmInternalPath(
      "/home/blame/.local/share/blame/runtime/worktrees/repo/story",
      "darwin",
    ),
    true,
  );
  assert.equal(
    runtimeVmInternalPath(
      "/Users/dev/Library/Application Support/Blame/runtime/worktrees/repo/story",
      "darwin",
    ),
    false,
  );
});

test("sanitizeWorkspaceConfigFiles: merges configs and deletes duplicate sub-package files", async () => {
  let rootFileWritten = "";
  let fileDeleted = "";
  const worktree =
    "/home/blame/.local/share/blame/runtime/worktrees/repo/story";
  const rootConfigPath = `${worktree}/pnpm-workspace.yaml`;
  const subConfigPath = `${worktree}/apps/web/pnpm-workspace.yaml`;

  const mockFns = {
    run: async () => ({
      stdout: `${rootConfigPath}\n${subConfigPath}\n`,
      stderr: "",
    }),
    readFile: async (p: string) => {
      if (p === rootConfigPath) {
        return "packages:\n  - apps/*\n";
      }
      if (p === subConfigPath) {
        return "allowBuilds:\n  sharp: true\nignoredBuiltDependencies:\n  - sharp\n";
      }
      throw new Error("unexpected file read");
    },
    writeFile: async (p: string, data: string) => {
      if (p === rootConfigPath) {
        rootFileWritten = data;
        return;
      }
      throw new Error("unexpected file write");
    },
    pathExists: async (p: string) => {
      return p === rootConfigPath;
    },
    joinWorkspacePath: (dir: string, ...parts: string[]) =>
      [dir, ...parts].join("/"),
    rm: async (p: string) => {
      fileDeleted = p;
    },
    readdirHost: async () => [],
    platform: "win32" as const,
  };

  await sanitizeWorkspaceConfigFiles(worktree, mockFns);

  assert.equal(fileDeleted, subConfigPath);
  assert.match(rootFileWritten, /allowBuilds/);
  assert.match(rootFileWritten, /sharp: true/);
  assert.match(rootFileWritten, /ignoredBuiltDependencies/);
});

test("sanitizeWorkspaceConfigFiles: handles host paths on Windows/non-managed with readdirHost", async () => {
  let rootFileWritten = "";
  let fileDeleted = "";

  const mockFns = {
    run: async () => {
      throw new Error("should not be called for host paths");
    },
    readFile: async (p: string) => {
      if (p === "/host/pnpm-workspace.yaml") {
        return "packages:\n  - apps/*\n";
      }
      if (p === "/host/apps/web/pnpm-workspace.yaml") {
        return "allowBuilds:\n  sharp: true\n";
      }
      throw new Error("unexpected file read");
    },
    writeFile: async (p: string, data: string) => {
      if (p === "/host/pnpm-workspace.yaml") {
        rootFileWritten = data;
        return;
      }
      throw new Error("unexpected file write");
    },
    pathExists: async (p: string) => {
      return p === "/host/pnpm-workspace.yaml";
    },
    joinWorkspacePath: (dir: string, ...parts: string[]) =>
      [dir, ...parts].join("/"),
    rm: async (p: string) => {
      fileDeleted = p;
    },
    readdirHost: async (dir: string) => {
      if (dir === "/host") {
        return [
          {
            name: "pnpm-workspace.yaml",
            isFile: () => true,
            isDirectory: () => false,
          },
          { name: "apps", isFile: () => false, isDirectory: () => true },
        ] as any;
      }
      if (dir === "/host/apps") {
        return [
          { name: "web", isFile: () => false, isDirectory: () => true },
        ] as any;
      }
      if (dir === "/host/apps/web") {
        return [
          {
            name: "pnpm-workspace.yaml",
            isFile: () => true,
            isDirectory: () => false,
          },
        ] as any;
      }
      return [];
    },
  };

  // "/host" is not runtime-managed on any OS platform.
  await sanitizeWorkspaceConfigFiles("/host", mockFns);

  assert.equal(fileDeleted, "/host/apps/web/pnpm-workspace.yaml");
  assert.match(rootFileWritten, /allowBuilds/);
  assert.match(rootFileWritten, /sharp: true/);
});

test("sanitizeWorkspaceConfigFiles: deletes duplicate lockfiles on VM/managed paths", async () => {
  const deletedFiles: string[] = [];
  const worktree =
    "/home/blame/.local/share/blame/runtime/worktrees/repo/story";

  const mockFns = {
    run: async (cmd: string, args: string[]) => {
      const nameArg = args[args.indexOf("-name") + 1];
      if (nameArg === "pnpm-workspace.yaml") {
        return { stdout: `${worktree}/pnpm-workspace.yaml\n`, stderr: "" };
      }
      if (nameArg === "pnpm-lock.yaml") {
        return {
          stdout: `${worktree}/pnpm-lock.yaml\n${worktree}/apps/web/pnpm-lock.yaml\n`,
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
    readFile: async () => "",
    writeFile: async () => {},
    pathExists: async () => false,
    joinWorkspacePath: (dir: string, ...parts: string[]) =>
      [dir, ...parts].join("/"),
    rm: async (p: string) => {
      deletedFiles.push(p);
    },
    readdirHost: async () => [],
    platform: "win32" as const,
  };

  await sanitizeWorkspaceConfigFiles(worktree, mockFns);

  assert.deepEqual(deletedFiles, [`${worktree}/apps/web/pnpm-lock.yaml`]);
});

test("sanitizeWorkspaceConfigFiles: deletes duplicate lockfiles on host/non-managed paths", async () => {
  const deletedFiles: string[] = [];

  const mockFns = {
    run: async () => {
      throw new Error("should not be called for host paths");
    },
    readFile: async () => "",
    writeFile: async () => {},
    pathExists: async () => false,
    joinWorkspacePath: (dir: string, ...parts: string[]) =>
      [dir, ...parts].join("/"),
    rm: async (p: string) => {
      deletedFiles.push(p);
    },
    readdirHost: async (dir: string) => {
      if (dir === "/host") {
        return [
          {
            name: "pnpm-lock.yaml",
            isFile: () => true,
            isDirectory: () => false,
          },
          { name: "apps", isFile: () => false, isDirectory: () => true },
        ] as any;
      }
      if (dir === "/host/apps") {
        return [
          { name: "web", isFile: () => false, isDirectory: () => true },
        ] as any;
      }
      if (dir === "/host/apps/web") {
        return [
          {
            name: "pnpm-lock.yaml",
            isFile: () => true,
            isDirectory: () => false,
          },
        ] as any;
      }
      return [];
    },
    platform: "win32" as const,
  };

  await sanitizeWorkspaceConfigFiles("/host", mockFns);

  assert.deepEqual(deletedFiles, ["/host/apps/web/pnpm-lock.yaml"]);
});

test("ensureRuntimeGitUserIdentity: reads host identity and configures global config inside VM", async () => {
  resetRuntimeGitIdentityConfiguredForTesting();
  const runCalls: [string, string[]][] = [];
  const execCalls: string[][] = [];

  const mockFns = {
    execFileAsync: async (cmd: string, args: string[]) => {
      execCalls.push([cmd, ...args]);
      if (args[args.length - 1] === "user.name") {
        return { stdout: "Host User\n", stderr: "" };
      }
      if (args[args.length - 1] === "user.email") {
        return { stdout: "host@example.com\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    run: async (cmd: string, args: string[]) => {
      runCalls.push([cmd, args]);
      return { stdout: "", stderr: "" };
    },
  };

  await ensureRuntimeGitUserIdentity(mockFns);

  assert.deepEqual(execCalls, [
    ["git", "config", "--global", "user.name"],
    ["git", "config", "--global", "user.email"],
  ]);
  assert.deepEqual(runCalls, [
    ["git", ["config", "--global", "user.name", "Host User"]],
    ["git", ["config", "--global", "user.email", "host@example.com"]],
  ]);

  // Subsequent call should be a no-op due to caching
  runCalls.length = 0;
  execCalls.length = 0;
  await ensureRuntimeGitUserIdentity(mockFns);
  assert.equal(execCalls.length, 0);
  assert.equal(runCalls.length, 0);
});

test("ensureRuntimeGitUserIdentity: falls back to defaults if host reads fail", async () => {
  resetRuntimeGitIdentityConfiguredForTesting();
  const runCalls: [string, string[]][] = [];
  const originalUser = process.env.USER;
  const originalUsername = process.env.USERNAME;
  delete process.env.USER;
  delete process.env.USERNAME;

  try {
    const mockFns = {
      execFileAsync: async () => {
        throw new Error("config not found");
      },
      run: async (cmd: string, args: string[]) => {
        runCalls.push([cmd, args]);
        return { stdout: "", stderr: "" };
      },
    };

    await ensureRuntimeGitUserIdentity(mockFns);

    assert.deepEqual(runCalls, [
      ["git", ["config", "--global", "user.name", "Blame User"]],
      ["git", ["config", "--global", "user.email", "blame@example.local"]],
    ]);
  } finally {
    process.env.USER = originalUser;
    process.env.USERNAME = originalUsername;
  }
});

test("resolves Windows worktrees in the selected development distribution", () => {
  assert.equal(
    runtimeHostPath(
      "/home/blame/.local/share/blame/runtime/worktrees/Test/story",
      "win32",
      { BLAME_WSL_DISTRO: "BlameRuntimeDev" },
    ),
    String.raw`\\wsl.localhost\BlameRuntimeDev\home\blame\.local\share\blame\runtime\worktrees\Test\story`,
  );
});
