import assert from "node:assert/strict";
import test from "node:test";
import { inspectWorktreeRemoval } from "./worktree-removal.ts";
import { isProjectFolder } from "./worktree-safety.ts";
import type { WorkspaceExecution, WorkspaceMode } from "./workspace-mode.ts";

const repositoryRoot = String.raw`C:\Users\René O'Neil\Mon projet`;
const worktree = "/home/blame/.local/share/blame/runtime/worktrees/app/story-1";

function fixture(
  input: {
    execution?: WorkspaceExecution;
    registered?: boolean;
    exists?: boolean;
    gitError?: Error;
  } = {},
) {
  const calls: string[] = [];
  return {
    calls,
    dependencies: {
      isProjectFolder: (root: string, path: string) =>
        isProjectFolder(root, path, async () => false),
      runGit: async (
        root: string,
        args: string[],
        execution?: WorkspaceExecution,
      ) => {
        calls.push("repository");
        // A host project path would select native Git without an explicit
        // execution mode. Reproduce a Windows machine with Git only in WSL.
        if ((execution ?? "native") !== (input.execution ?? "virtualized"))
          throw new Error("git is not recognized on the Windows host");
        assert.equal(root, repositoryRoot);
        assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
        if (input.gitError) throw input.gitError;
        return { stdout: "/mnt/c/Users/René O'Neil/Mon projet\n", stderr: "" };
      },
      worktreeRegistered: async (
        _root: string,
        _path: string,
        mode?: WorkspaceMode,
      ) => {
        calls.push("registration");
        assert.equal(
          mode,
          input.execution === "native" ? "cloud-mirror" : "local-container",
        );
        return input.registered ?? true;
      },
      pathExists: async () => {
        calls.push("exists");
        return input.exists ?? true;
      },
    },
  };
}

for (const workspaceMode of [undefined, "local-container"] as const) {
  test(`can remove a WSL story without Windows Git (mode=${workspaceMode})`, async () => {
    const { calls, dependencies } = fixture();
    assert.deepEqual(
      await inspectWorktreeRemoval(
        { repositoryRoot, worktree, workspaceMode },
        dependencies,
      ),
      { mode: "local-container", state: "registered" },
    );
    assert.deepEqual(calls, ["repository", "registration"]);
  });
}

test("cloud worktrees keep using native Git", async () => {
  const { dependencies } = fixture({ execution: "native" });
  assert.deepEqual(
    await inspectWorktreeRemoval(
      { repositoryRoot, worktree, workspaceMode: "cloud-mirror" },
      dependencies,
    ),
    { mode: "cloud-mirror", state: "registered" },
  );
});

test("direct stories and project folders need no Git to release their sessions", async () => {
  for (const input of [
    { repositoryRoot, worktree, workspaceMode: "direct" as const },
    { repositoryRoot, worktree: repositoryRoot },
  ]) {
    const { calls, dependencies } = fixture({
      gitError: new Error("Git unavailable"),
    });
    assert.equal(
      (await inspectWorktreeRemoval(input, dependencies)).state,
      "project",
    );
    assert.deepEqual(calls, []);
  }
});

test("a different main checkout is protected from removal too", async () => {
  const { calls, dependencies } = fixture();
  dependencies.isProjectFolder = (root, path) =>
    isProjectFolder(root, path, async () => true);
  assert.equal(
    (await inspectWorktreeRemoval({ repositoryRoot, worktree }, dependencies))
      .state,
    "project",
  );
  assert.deepEqual(calls, []);
});

for (const exists of [true, false]) {
  test(`distinguishes an unregistered worktree from an already removed one (exists=${exists})`, async () => {
    const { calls, dependencies } = fixture({ registered: false, exists });
    assert.equal(
      (await inspectWorktreeRemoval({ repositoryRoot, worktree }, dependencies))
        .state,
      exists ? "unregistered" : "missing",
    );
    assert.deepEqual(calls, ["repository", "registration", "exists"]);
  });
}

test("repository failures stop removal instead of falling through to directory deletion", async () => {
  const gitError = new Error("fatal: not a git repository");
  const { calls, dependencies } = fixture({ gitError });
  await assert.rejects(
    inspectWorktreeRemoval({ repositoryRoot, worktree }, dependencies),
    (error) => error === gitError,
  );
  assert.deepEqual(calls, ["repository"]);
});
