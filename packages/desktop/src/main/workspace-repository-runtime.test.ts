import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runtimeAgentClient, runtimeAgentSupported } from "./runtime-agent.ts";
import { ensureGitRepository } from "./workspace-git.ts";
import {
  resetRuntimeGitIdentityConfigured,
  runtimeAccessiblePath,
} from "./workspace-runtime.ts";

const exec = promisify(execFile);

test(
  "prepares a runtime repository and its initial commit without host Git",
  {
    skip: !runtimeAgentSupported(process.platform),
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "blame-runtime-repository-"));
    const directory = join(root, "projet-équipe");
    await mkdir(directory);
    await writeFile(join(directory, "source.txt"), "keep me\n");
    t.after(() => rm(root, { recursive: true, force: true }));
    const { stdout } = await exec(
      process.platform === "win32" ? "where.exe" : "which",
      ["git"],
    );
    const git = stdout.trim().split(/\r?\n/)[0]!;
    const environment = { ...process.env };
    const operations: string[][] = [];
    let guestDirectory = directory;
    const client = runtimeAgentClient();
    t.mock.method(
      client,
      "exec",
      async (input: { command: string; args: string[]; cwd?: string }) => {
        assert.equal(input.command, "git");
        operations.push(input.args);
        // Keep global identity/safe-directory writes out of the real account.
        if (input.args[0] === "config") return { stdout: "", stderr: "" };
        assert.equal(input.cwd, runtimeAccessiblePath(guestDirectory));
        return exec(git, input.args, { cwd: guestDirectory, env: environment });
      },
    );
    const hostPath = process.env.PATH;
    resetRuntimeGitIdentityConfigured();
    try {
      process.env.PATH = "";
      assert.equal(await ensureGitRepository(directory, "virtualized"), true);
      assert.ok(operations.some((args) => args[0] === "init"));
      assert.ok(operations.some((args) => args.includes("commit")));
      operations.length = 0;
      assert.equal(await ensureGitRepository(directory, "virtualized"), false);
      assert.equal(
        operations.some((args) => args[0] === "init"),
        false,
      );

      // An opened subfolder needs its own repository, not its parent's HEAD.
      guestDirectory = join(directory, "nested");
      await mkdir(guestDirectory);
      await writeFile(join(guestDirectory, "nested.txt"), "nested\n");
      assert.equal(
        await ensureGitRepository(guestDirectory, "virtualized"),
        true,
      );
      assert.match(
        await readFile(join(guestDirectory, ".git", "HEAD"), "utf8"),
        /^ref: refs\/heads\//,
      );
      assert.equal(
        await readFile(join(directory, "source.txt"), "utf8"),
        "keep me\n",
      );
    } finally {
      if (hostPath === undefined) delete process.env.PATH;
      else process.env.PATH = hostPath;
      resetRuntimeGitIdentityConfigured();
    }
  },
);
