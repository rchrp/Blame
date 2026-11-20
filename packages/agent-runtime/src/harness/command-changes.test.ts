import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { LightWorkspace } from "./test-client/light-workspace.js";
import { LightFinishService } from "./test-client/light-finish-service.js";
import { SessionJournal } from "./session-journal.js";

test("a short generator creates source without pretending to validate it", async () => {
  await fixture(async (root, workspace) => {
    const command = nodeCommand(
      "require('fs').writeFileSync('generated.js', 'module.exports = ' + JSON.stringify(Array.from({length:120}, (_, i) => i)) + ';\\n')",
    );
    const result = await workspace.runTask(
      { kind: "command", command },
      {} as never,
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.match(JSON.stringify(result), /"changed":true/u);
    assert.match(JSON.stringify(result), /"status":"stale"/u);
    const state = await journal(root);
    assert.deepEqual(state.changedPaths, ["generated.js"]);
    assert.equal(state.validations.length, 0);
    assert.match(await readFile(join(root, "generated.js"), "utf8"), /119/u);
  });
});

test("commands preserve the initial state when a tracked file is changed and reverted", async () => {
  await fixture(async (root, workspace) => {
    await workspace.runTask(
      { kind: "command", command: writeValue(2) },
      {} as never,
    );
    assert.deepEqual((await journal(root)).changedPaths, ["value.js"]);
    await workspace.runTask(
      { kind: "command", command: writeValue(1) },
      {} as never,
    );
    assert.deepEqual((await journal(root)).changedPaths, []);
  });
});

test("a pre-existing dirty change is not claimed by a command round trip", async () => {
  await fixture(async (root, workspace) => {
    await writeFile(join(root, "value.js"), "module.exports = 5;\n");
    await workspace.runTask(
      { kind: "command", command: writeValue(6) },
      {} as never,
    );
    await workspace.runTask(
      { kind: "command", command: writeValue(5) },
      {} as never,
    );
    assert.deepEqual((await journal(root)).changedPaths, []);
    assert.equal(
      await readFile(join(root, "value.js"), "utf8"),
      "module.exports = 5;\n",
    );
  });
});

test("source effects remain visible after a command fails", async () => {
  await fixture(async (root, workspace) => {
    const command = nodeCommand(
      "require('fs').writeFileSync('value.js', 'module.exports = 2;\\n'); process.exit(1)",
    );
    const result = await workspace.runTask(
      { kind: "command", command },
      {} as never,
    );
    assert.equal(result.status, "blocked");
    assert.deepEqual((await journal(root)).changedPaths, ["value.js"]);
    assert.equal((await journal(root)).validations.length, 0);
  });
});

test("a project formatter requires a requested check to verify the resulting source", async () => {
  await fixture(async (root, workspace) => {
    const manifest = {
      scripts: { build: "node --version", format: writeValue(2) },
    };
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));
    const result = await workspace.runTask(
      { kind: "project", task: "format" },
      {} as never,
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.deepEqual((await journal(root)).changedPaths, ["value.js"]);
    let verified = false;
    const finish = new LightFinishService({
      workspaceRoot: root,
      conversationId: "commands",
      onComplete: (value) => {
        verified = value.verified;
      },
    });
    await finish.finish("Formatted", {} as never);
    assert.equal(verified, false);
    await workspace.runTask({ kind: "project", task: "build" }, {} as never);
    await finish.finish("Checked", {} as never);
    assert.equal(verified, true);
    assert.equal((await journal(root)).validations.at(-1)?.taskId, "build");
  });
});

test("source effects remain visible when a running command is cancelled", async () => {
  await fixture(async (root, workspace) => {
    const controller = new AbortController();
    const command = nodeCommand(
      "const fs = require('fs'); fs.writeFileSync('value.js', 'module.exports = 2;\\n'); fs.writeFileSync('.blame/observed', 'yes'); setTimeout(() => {}, 2000)",
    );
    const pending = workspace.runTask({ kind: "command", command }, {
      signal: controller.signal,
    } as never);
    await waitFor(join(root, ".blame/observed"));
    controller.abort();
    assert.equal((await pending).status, "blocked");
    assert.deepEqual((await journal(root)).changedPaths, ["value.js"]);
  });
});

function writeValue(value: number) {
  return nodeCommand(
    `require('fs').writeFileSync('value.js', 'module.exports = ${value};\\n')`,
  );
}

test("committing pre-existing dirty content does not claim it", async () => {
  await fixture(async (root) => {
    await writeFile(join(root, "value.js"), "module.exports = 5;\n");
    await observeGit(root, commitCommand);
    assert.deepEqual((await journal(root)).changedPaths, []);
  });
});

test("a command write remains attributed after it is committed", async () => {
  await fixture(async (root) => {
    await observeGit(root, `printf 'module.exports = 2;\\n' > value.js && ${commitCommand}`);
    assert.deepEqual((await journal(root)).changedPaths, ["value.js"]);
  });
});

test("committed renames retain both the old and new paths", async () => {
  await fixture(async (root) => {
    await observeGit(root, `git mv value.js renamed.js && ${commitCommand}`);
    assert.deepEqual((await journal(root)).changedPaths.sort(), ["renamed.js", "value.js"]);
  });
});

test("staged renames retain both paths without changing HEAD", async () => {
  await fixture(async (root) => {
    await observeGit(root, "git mv value.js renamed.js");
    assert.deepEqual((await journal(root)).changedPaths.sort(), ["renamed.js", "value.js"]);
  });
});

test("switching away and back restores the original file attribution", async () => {
  await fixture(async (root) => {
    git(root, ["branch", "original"]);
    git(root, ["switch", "-qc", "alternate"]);
    await writeFile(join(root, "value.js"), "module.exports = 2;\n");
    commit(root);
    git(root, ["switch", "-q", "original"]);
    await writeFile(join(root, "personal.txt"), "user data\n");
    await observeGit(root, "git switch -q alternate");
    assert.deepEqual((await journal(root)).changedPaths, ["value.js"]);
    await observeGit(root, "git switch -q original");
    assert.deepEqual((await journal(root)).changedPaths, []);
    assert.equal(await readFile(join(root, "personal.txt"), "utf8"), "user data\n");
  });
});

test("the first commit records newly created files", async () => {
  await fixture(async (root) => {
    git(root, ["switch", "--orphan", "initial"]);
    await observeGit(root, `printf 'value = 1\\n' > created.py && ${commitCommand}`);
    assert.deepEqual((await journal(root)).changedPaths, ["created.py"]);
  });
});

test("a failure after commit keeps its original error and file effects", async () => {
  await fixture(async (root) => {
    const failed = await observeGit(root, `printf 'module.exports = 2;\\n' > value.js && ${commitCommand} && exit 3`);
    assert.match(JSON.stringify(failed), /exited with code 3/u);
    assert.deepEqual((await journal(root)).changedPaths, ["value.js"]);
  });
});

test("an authorized isolated Git commit returns success through run_task", async () => {
  await fixture(async (root) => {
    const workspace = new LightWorkspace(root, { sessionId: "commands", taskContract: {
      session_id: "commands",
      effect_requirement: "none", environment: { isolated: true, managedPreview: false },
    } });
    const result = await workspace.runTask({ kind: "command", command:
      "printf 'module.exports = 2;\\n' > value.js && git add value.js && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm requested",
    }, {} as never);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.deepEqual((await journal(root)).changedPaths, ["value.js"]);
  });
});

// The Git operations run as an isolated story's command, whose changes the
// harness attributes as it attributes any command's.
const commitCommand = "git add --all -- . ':(exclude).blame' && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm 'fixture change'";

async function observeGit(root: string, command: string) {
  const workspace = new LightWorkspace(root, { sessionId: "commands", taskContract: {
    session_id: "commands", effect_requirement: "none", environment: { isolated: true, managedPreview: false },
  } });
  return workspace.runTask({ kind: "command", command }, {});
}

function commit(root: string) {
  git(root, ["add", "--all", "--", ".", ":(exclude).blame"]);
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "-qm", "fixture change"]);
}

function nodeCommand(script: string) {
  return `node -e '${script.replaceAll("'", "'\\''")}'`;
}

function journal(root: string) {
  return new SessionJournal(root, "commands").completionSnapshot();
}

async function fixture(
  run: (root: string, workspace: LightWorkspace) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "blame-command-changes-"));
  try {
    await writeFile(join(root, "value.js"), "module.exports = 1;\n");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { build: "node --version" } }),
    );
    git(root, ["init", "-q"]);
    git(root, ["add", "."]);
    git(root, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    await mkdir(join(root, ".blame"));
    await run(root, new LightWorkspace(root, { sessionId: "commands" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function git(root: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: "ignore",
  });
}

async function waitFor(path: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return;
    await delay(10);
  }
  throw new Error("The command did not reach its source write.");
}
