// The git flows' agents through the engine host, against the real
// `blame-engine`, the real harness runner and a mock Anthropic server: a
// commit message from its result tool, and merge conflicts resolved in the
// worktree by an agent the contract makes read code first. Skipped when the
// binary is not built.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EngineHost } from "./host.js";
import { FakeApi, MockModel, testModel, tools } from "./testing.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const binary =
  process.env.BLAME_ENGINE_BIN ?? join(root, "target/debug/blame-engine");
const runner = fileURLToPath(
  new URL("../harness/semantic-harness-runner.js", import.meta.url),
);
const model = { providerId: "anthropic", modelId: testModel };

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A project whose story worktree changed shared.txt as main did. */
function conflictingProject(directory: string) {
  const project = join(directory, "project");
  const story = join(directory, "story");
  mkdirSync(project);
  git(project, "init", "--initial-branch=main");
  git(project, "config", "user.email", "blame@example.com");
  git(project, "config", "user.name", "Blame Test");
  writeFileSync(join(project, ".gitignore"), ".blame/\n");
  writeFileSync(join(project, "shared.txt"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "base");
  git(project, "worktree", "add", "-b", "story/review", story);
  writeFileSync(join(story, "shared.txt"), "story\n");
  git(story, "commit", "-am", "story");
  writeFileSync(join(project, "shared.txt"), "target\n");
  git(project, "commit", "-am", "target");
  return { project, story };
}

describe(
  "git flow tasks",
  { skip: !existsSync(binary) && "no engine binary" },
  () => {
    let mock: MockModel;
    let api: FakeApi;
    let host: EngineHost;
    let directory: string;
    let dataDir: string;

    before(async () => {
      mock = await MockModel.start([]);
      api = await FakeApi.start();
      api.modelBase = mock.base;
      directory = mkdtempSync(join(tmpdir(), "blame-git-tasks-"));
      dataDir = mkdtempSync(join(tmpdir(), "blame-git-tasks-data-"));
      host = new EngineHost({
        binary,
        dataDir,
        clientVersion: "test",
        harnessCommand: [process.execPath, runner, "--serve"],
        env: { ...process.env, BLAME_ENGINE_LOG: "warn" },
        emit: () => undefined,
      });
      await host.call("connect", { api: api.connection() });
    });

    after(async () => {
      await host.shutdown();
      await mock.close();
      await api.close();
      rmSync(directory, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    });

    it("writes the commit message of the selected changes", async () => {
      const project = join(directory, "commit");
      mkdirSync(project);
      git(project, "init", "--initial-branch=main");
      git(project, "config", "user.email", "blame@example.com");
      git(project, "config", "user.name", "Blame Test");
      writeFileSync(join(project, "README.md"), "base\n");
      git(project, "add", ".");
      git(project, "commit", "-m", "docs: start");
      writeFileSync(join(project, "card.ts"), "export const card = 1;\n");
      mock.script(
        tools({
          name: "submit_commit_message",
          input: { message: "```\nfeat(card): add card payments\n```" },
        }),
      );
      const result = await host.call("generateCommitMessage", {
        model,
        repositoryRoot: project,
        worktree: project,
        selectedPaths: ["card.ts"],
        title: "Git commit",
      });
      assert.deepEqual(result, { message: "feat(card): add card payments" });
      const sent = mock.requests.at(-1)!.body as {
        tools: Array<{ name: string }>;
      };
      assert.deepEqual(
        sent.tools.map((tool) => tool.name),
        ["submit_commit_message"],
      );
      assert.match(mock.sent().at(-1)!, /card\.ts/, "the changes are in it");
    });

    it("resolves merge conflicts after reading them, and stages the files", async () => {
      const { project, story } = conflictingProject(directory);
      assert.throws(() => git(story, "merge", "main"));
      const asked = mock.requests.length;
      mock.script(
        // Refused: the contract wants code read first.
        tools({
          name: "submit_merge_resolution",
          input: { resolved: true, reason: "Done." },
        }),
        tools({ name: "read_code", input: { target: "shared.txt" } }),
        tools({
          name: "edit_code",
          input: {
            operations: [
              {
                kind: "patch",
                patch: [
                  "*** Begin Patch",
                  "*** Update File: shared.txt",
                  "@@",
                  "-<<<<<<< HEAD",
                  "-story",
                  "-=======",
                  "-target",
                  "->>>>>>> main",
                  "+story and target",
                  "*** End Patch",
                ].join("\n"),
              },
            ],
          },
        }),
        tools({
          name: "submit_merge_resolution",
          input: { resolved: true, reason: "Kept both lines." },
        }),
      );
      const result = await host.call("resolveMergeConflicts", {
        model,
        repositoryRoot: project,
        worktree: story,
        targetBranch: "main",
      });
      assert.deepEqual(result, { conflicts: [], resolved: true });
      assert.equal(
        readFileSync(join(story, "shared.txt"), "utf8"),
        "story and target\n",
      );
      assert.equal(git(story, "status", "--porcelain"), "M  shared.txt");
      const first = mock.requests[asked]!.body as {
        tools: Array<{ name: string }>;
      };
      assert.deepEqual(first.tools.map((tool) => tool.name).sort(), [
        "edit_code",
        "read_code",
        "run_task",
        "search_code",
        "submit_merge_resolution",
      ]);
      assert.match(
        mock.sent()[asked + 1]!,
        /Not accepted/,
        "the early result was refused",
      );
    });

    it("sends the conflicts of a worktree in the runtime VM to the VM's engine", async () => {
      const vm = join(directory, "vm");
      mkdirSync(vm);
      const { project, story } = conflictingProject(vm);
      assert.throws(() => git(story, "merge", "main"));
      // A host whose VM is down: the task goes there, never to this computer's engine.
      const vmHost = new EngineHost({
        binary,
        dataDir: join(directory, "vm-host-data"),
        clientVersion: "test",
        harnessCommand: [process.execPath, runner, "--serve"],
        env: { ...process.env, BLAME_ENGINE_LOG: "warn" },
        emit: () => undefined,
        vm: {
          prepare: async () => {
            throw new Error("The test VM is down.");
          },
          workspaceRoots: [vm],
        },
      });
      try {
        await vmHost.call("connect", { api: api.connection() });
        const asked = mock.requests.length;
        await assert.rejects(
          vmHost.call("resolveMergeConflicts", {
            model,
            repositoryRoot: project,
            worktree: story,
            inVm: true,
          }),
          /The test VM is down/,
        );
        assert.equal(mock.requests.length, asked, "no model was asked here");
      } finally {
        await vmHost.shutdown();
      }
    });
  },
);
