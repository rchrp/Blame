import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { blockedCommandReason } from "./test-client/units.js";
import type { LightCompletionNotification } from "./test-client/light-finish-service.js";
import { LightFinishService } from "./test-client/light-finish-service.js";
import type { LightToolResult } from "./light-contracts.js";
import { lightSemanticHarnessTools } from "./test-client/light-tools.js";
import { LightWorkspace } from "./test-client/light-workspace.js";
import { SessionJournal } from "./session-journal.js";
import { WorkspaceFiles } from "./workspace-files.js";

/** A run_task input, as the model sends it. */
type LightRunTaskInput = Record<string, unknown>;

test("a changed symbol requires a fresh observation before replacement", async () => {
  await fixture(
    { "a.ts": "export function value() { return 1; }\n" },
    async (root, workspace) => {
      const read = await workspace.readCode({ target: "a.ts#value" }, {});
      assert.equal(read.status, "ok");
      const alias = String((read as { data: { alias: string } }).data.alias);
      await writeFile(
        join(root, "a.ts"),
        "export function value() { return 99; }\n",
      );
      const input = {
        operations: [
          {
            kind: "symbol" as const,
            target: alias,
            action: "replace_body" as const,
            content: "{ return 2; }",
          },
        ],
      };
      assert.equal((await workspace.editCode(input)).status, "blocked");
      assert.match(await readFile(join(root, "a.ts"), "utf8"), /return 99/u);
      await workspace.readCode({ target: alias }, {});
      assert.equal((await workspace.editCode(input)).status, "ok");
      assert.match(await readFile(join(root, "a.ts"), "utf8"), /return 2/u);
    },
  );
});

test("a symbol alias rebases when only a neighbouring declaration changes", async () => {
  const source =
    "export function value() { return 1; }\nexport const sibling = 0;\n";
  await fixture({ "a.ts": source }, async (root, workspace) => {
    const read = await workspace.readCode({ target: "a.ts#value" }, {});
    const alias = String((read as { data: { alias: string } }).data.alias);
    await writeFile(
      join(root, "a.ts"),
      source.replace("sibling = 0", "sibling = 99"),
    );
    const result = await workspace.editCode({
      operations: [
        {
          kind: "symbol",
          target: alias,
          action: "replace_body",
          content: "{ return 2; }",
        },
      ],
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.match(await readFile(join(root, "a.ts"), "utf8"), /sibling = 99/u);
  });
});

test("an aborted public edit cannot write source", async () => {
  await fixture({ "a.ts": "export const value = 1;\n" }, async (root) => {
    const tool = lightSemanticHarnessTools(root, {
      taskContract: { session_id: "abort" },
    }).find(({ name }) => name === "edit_code")!;
    const controller = new AbortController();
    const pending = tool.execute(
      {
        operations: [
          {
            kind: "symbol",
            target: "a.ts#value",
            action: "replace",
            content: "export const value = 2;",
          },
        ],
      },
      { signal: controller.signal } as never,
    );
    controller.abort();
    const result = await pending;
    assert.equal((result as { status: string }).status, "blocked");
    assert.equal(
      await readFile(join(root, "a.ts"), "utf8"),
      "export const value = 1;\n",
    );
  });
});

// "cancellation during commit preparation leaves the batch unchanged"
// aborted from inside a patched `WorkspaceFiles.resolveForWriteVerified` of
// the TypeScript commit service; the harness has no such seam.

test("a check cannot prove source changed during execution", async () => {
  await fixture(
    {
      "a.ts": "export const value = 1;\n",
      "package.json": manifest({ build: "node check.cjs" }),
      "check.cjs":
        "const fs = require('fs'); fs.writeFileSync('.blame/observed', 'yes'); setTimeout(() => process.exit(0), 500);",
    },
    async (root, workspace) => {
      await editValue(workspace, 1, 2);
      const pending = workspace.runTask({ kind: "project", task: "build" }, {});
      await waitFor(join(root, ".blame/observed"));
      await writeFile(join(root, "a.ts"), "export const value = 3;\n");
      const result = await pending;
      assert.equal(result.status, "ok");
      assert.equal(
        (result as { data: { validation: { status: string } } }).data.validation
          .status,
        "stale",
      );
      assert.equal(
        (await new SessionJournal(root, "invariants").completionSnapshot())
          .validations.length,
        0,
      );
    },
  );
});

test("the same command executes independently in different directories", async () => {
  await fixture({ "a/file": "", "b/flag": "" }, async (_root, workspace) => {
    const command = "test -f flag";
    assert.equal(
      (await workspace.runTask({ kind: "command", command, cwd: "a" }, {}))
        .status,
      "blocked",
    );
    assert.equal(
      (await workspace.runTask({ kind: "command", command, cwd: "b" }, {}))
        .status,
      "ok",
    );
  });
});

test("a passing build cannot hide a failing test and a real retry can recover", async () => {
  await fixture(
    {
      "a.ts": "export const value = 1;\n",
      "package.json": manifest({
        build: "node --version",
        test: "node check.cjs",
      }),
      "check.cjs":
        "process.exit(require('fs').existsSync('.blame/repaired') ? 0 : 1);",
    },
    async (root, workspace) => {
      await editValue(workspace, 1, 2);
      await workspace.runTask({ kind: "command", command: "npm test" }, {});
      await workspace.runTask({ kind: "project", task: "build" }, {});
      const notifications: LightCompletionNotification[] = [];
      const finish = finisher(root, notifications);
      await assert.rejects(
        finish.finish("Completed", {} as never),
        /still failing/u,
      );
      assert.equal(notifications.length, 0);
      await writeFile(join(root, ".blame/repaired"), "yes");
      assert.equal(
        (await workspace.runTask({ kind: "project", task: "test" }, {})).status,
        "ok",
      );
      await finish.finish("Completed", {} as never);
      assert.equal(notifications[0]?.verified, true);
    },
  );
});

test("round trips have no delivered source effect and explanation tasks can finish", async () => {
  await fixture(
    { "a.ts": "export const value = 1;\n" },
    async (root, workspace) => {
      await editValue(workspace, 1, 2);
      await editValue(workspace, 2, 1);
      assert.deepEqual(
        (await new SessionJournal(root, "invariants").completionSnapshot())
          .changedPaths,
        [],
      );
      const notifications: LightCompletionNotification[] = [];
      await finisher(root, notifications).finish(
        "Explained the existing behavior",
        {} as never,
      );
      assert.equal(notifications[0]?.completion.verification, "not_applicable");
      const strict = new LightFinishService({
        workspaceRoot: root,
        conversationId: "invariants",
        taskContract: { effect_requirement: "source_change" },
      });
      await assert.rejects(
        strict.finish("No change", {} as never),
        /source change/u,
      );
    },
  );
});

test("a package check cannot verify changes in another unchecked package", async () => {
  await fixture(
    {
      "package.json": manifest({ build: "node --version" }),
      "a.ts": "export const value = 1;\n",
      "nested/package.json": manifest({ test: "node --version" }),
      "nested/b.ts": "export const value = 1;\n",
    },
    async (root, workspace) => {
      await editValue(workspace, 1, 2);
      await editValue(workspace, 1, 2, "nested/b.ts");
      const result = await workspace.runTask(
        { kind: "project", task: "build" },
        {},
      );
      assert.deepEqual(
        (result as { data: { validation: { paths: string[] } } }).data
          .validation.paths,
        ["a.ts"],
      );
      const notifications: LightCompletionNotification[] = [];
      const finish = finisher(root, notifications);
      await finish.finish("Both updated", {} as never);
      assert.equal(notifications[0]?.verified, false);
      await workspace.runTask({ kind: "project", task: "test" }, {});
      await finish.finish("Both checked", {} as never);
      assert.equal(notifications[1]?.verified, false);
      const journal = await new SessionJournal(root, "invariants").completionSnapshot();
      assert.equal(
        journal.validations.filter(({ terminal }) => terminal === "passed")
          .length,
        1,
      );
    },
  );
});

test("shell syntax distinguishes inspection from adjacent output redirection", () => {
  assert.equal(blockedCommandReason('node -e "console.log(8 > 3)"'), undefined);
  assert.equal(blockedCommandReason("git -C . status"), undefined);
  assert.equal(
    blockedCommandReason("cat node_modules/example/package.json"),
    undefined,
  );
  assert.equal(blockedCommandReason("printf audit>marker.txt"), undefined);
  assert.match(
    blockedCommandReason("git -C . add source.ts") ?? "",
    /Git mutations/u,
  );
});

test("editing another value does not erase the need to rerun a failing test", async () => {
  await fixture(
    {
      "a.ts": "export const value = 1;\n",
      "package.json": manifest({
        build: "node --version",
        test: 'node -e "process.exit(1)"',
      }),
    },
    async (root, workspace) => {
      await editValue(workspace, 1, 2);
      await workspace.runTask({ kind: "project", task: "test" }, {});
      await editValue(workspace, 2, 3);
      const notifications: LightCompletionNotification[] = [];
      await assert.rejects(
        finisher(root, notifications).finish("Complete", {} as never),
        /validation|test|Command exited/iu,
      );
      assert.equal(notifications.length, 0);
    },
  );
});

function manifest(scripts: Record<string, string>) {
  return JSON.stringify({ scripts });
}

function finisher(root: string, notifications: LightCompletionNotification[]) {
  return new LightFinishService({
    workspaceRoot: root,
    conversationId: "invariants",
    onComplete: (value) => {
      notifications.push(value);
    },
  });
}

function editValue(
  workspace: LightWorkspace,
  before: number,
  after: number,
  path = "a.ts",
) {
  return workspace.editCode({
    operations: [
      {
        kind: "patch",
        path,
        patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n-export const value = ${before};\n+export const value = ${after};\n*** End Patch`,
      },
    ],
  });
}

async function fixture(
  files: Record<string, string>,
  run: (root: string, workspace: LightWorkspace) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "blame-invariants-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await run(root, new LightWorkspace(root, { sessionId: "invariants" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("snapshot cancellation interrupts a large file without returning an incomplete revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-hash-cancel-"));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const file = await open(join(root, "artifact.bin"), "w");
    try { await file.truncate(512 * 1024 * 1024); } finally { await file.close(); }
    timer = setTimeout(() => controller.abort(), 30);
    await assert.rejects(new WorkspaceFiles(root).snapshot(controller.signal), { name: "AbortError" });
  } finally {
    clearTimeout(timer);
    await rm(root, { force: true, recursive: true });
  }
});

test("finish reuses a requested test without imposing another build", async () => {
  await fixture({
    "a.ts": "export const value = 1;\n",
    "package.json": manifest({ build: 'node -e "process.exit(7)"', test: "node --version" }),
  }, async (root, workspace) => {
    await editValue(workspace, 1, 2);
    assert.equal((await workspace.runTask({ kind: "project", task: "test" }, {})).status, "ok");
    const notifications: LightCompletionNotification[] = [];
    assert.equal(await finisher(root, notifications).finish("Complete", {} as never), "Complete");
    assert.equal(notifications[0]?.verified, false);
  });
});

for (const inspection of [undefined, "node --version"]) {
  test(`finish reports unverified work without inventing a check after ${inspection ?? "no command"}`, async () => {
    await fixture({
      "a.ts": "export const value = 1;\n",
      "package.json": manifest({ build: 'node -e "process.exit(7)"' }),
    }, async (root, workspace) => {
      await editValue(workspace, 1, 2);
      if (inspection) await workspace.runTask({ kind: "command", command: inspection }, {});
      const notifications: LightCompletionNotification[] = [];
      await finisher(root, notifications).finish("Complete", {} as never);
      assert.equal(notifications[0]?.verified, false);
      assert.equal(notifications[0]?.completion.verification, "unverified");
      assert.deepEqual(notifications[0]?.completion.satisfied_obligations, []);
    });
  });
}

test("finish refreshes the requested stale test without selecting a new build", async () => {
  await fixture({
    "a.ts": "export const value = 1;\n",
    "package.json": manifest({ build: 'node -e "process.exit(7)"', test: "node --version" }),
  }, async (root, workspace) => {
    await editValue(workspace, 1, 2);
    await workspace.runTask({ kind: "project", task: "test" }, {});
    await editValue(workspace, 2, 3);
    const activities: string[] = [];
    const notifications: LightCompletionNotification[] = [];
    const finish = new LightFinishService({
      workspaceRoot: root, conversationId: "invariants",
      onComplete: (value) => { notifications.push(value); },
      onValidationActivity: ({ input, phase }) => {
        if (phase === "started" && input.kind === "project") activities.push(input.task);
      },
    });
    await finish.finish("Complete", {} as never);
    assert.deepEqual(activities, ["test"]);
    assert.equal(notifications[0]?.verified, false);
  });
});

for (const route of ["command", "project"] as const) {
  for (const outcome of ["pass", "fail", "stale"] as const) {
    test(`actual types compiler ${outcome} controls completion via ${route}`, async () => {
      await typesFixture("tsc --noEmit", async (root, workspace) => {
        await editTypedValue(root, workspace, outcome === "fail" ? '"broken"' : "2");
        const result = await settledTask(workspace, route === "project"
          ? { kind: "project", task: "types" }
          : { kind: "command", command: "npm run types" });
        const journal = new SessionJournal(root, "invariants");
        const before = await journal.completionSnapshot();
        const notifications: LightCompletionNotification[] = [];
        if (outcome === "fail") {
          assert.ok(result.status === "blocked", JSON.stringify(result));
          assert.match(result.message, /TS2322/u);
          assert.equal(result.category, "code");
          await assert.rejects(finisher(root, notifications).finish("Complete", {} as never),
            /Current validation is still failing/u);
        } else {
          assert.equal(result.status, "ok", JSON.stringify(result));
          if (outcome === "stale") {
            await editTypedValue(root, workspace, '"broken"');
            await assert.rejects(finisher(root, notifications).finish("Complete", {} as never),
              /TS2322|Current validation is still failing/u);
            const after = await journal.completionSnapshot();
            assert.notEqual(after.sourceRevisionId, before.sourceRevisionId);
            assert.ok(after.validations.some(check => check.taskKind === "typecheck" &&
              check.terminal === "failed" && check.sourceRevisionId === after.sourceRevisionId));
          } else {
            await finisher(root, notifications).finish("Complete", {} as never);
            // A successful compiler invocation does not prove file coverage.
            assert.equal(notifications[0]?.verified, false);
            assert.equal(notifications[0]?.completion.verification, "unverified");
            assert.ok(before.validations.every(check => check.scope === "invocation_only"));
            assert.ok(before.validations.some(check => check.taskKind === "typecheck" &&
              check.status === "passed" && check.sourceRevisionId === before.sourceRevisionId));
          }
        }
        if (outcome !== "pass") assert.deepEqual(notifications, []);
      });
    });
  }
}

for (const command of ['node -e "process.exit(0)"', 'tsc --noEmit && node -e "process.exit(0)"']) {
  test(`types alias does not admit compiler evidence for ${command}`, async () => {
    await typesFixture(command, async (root, workspace) => {
      await editTypedValue(root, workspace, "2");
      const result = await settledTask(workspace, { kind: "command", command: "npm run types" });
      assert.equal(result.status, "ok", JSON.stringify(result));
      const notifications: LightCompletionNotification[] = [];
      await finisher(root, notifications).finish("Complete", {} as never);
      assert.equal(notifications[0]?.verified, false);
      assert.equal(notifications[0]?.completion.verification, "unverified");
      assert.deepEqual(notifications[0]?.completion.satisfied_obligations, []);
    });
  });
}

async function typesFixture(
  command: string,
  run: (root: string, workspace: LightWorkspace) => Promise<void>,
) {
  const installed = join(import.meta.dirname, "../../node_modules");
  const compiler = JSON.parse(await readFile(join(installed, "typescript/package.json"), "utf8")).version;
  const manifest = JSON.stringify({ scripts: { types: command }, packageManager: "npm",
    devDependencies: { typescript: compiler } });
  await fixture({
    "a.ts": "export const value: number = 1;\n",
    "package.json": manifest,
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true,
      types: [], target: "ES2022", skipLibCheck: true }, include: ["a.ts"] }),
  }, async (root, workspace) => {
    await symlink(installed, join(root, "node_modules"));
    await run(root, workspace);
    assert.equal(await readFile(join(root, "package.json"), "utf8"), manifest);
    const snapshot = await new SessionJournal(root, "invariants").completionSnapshot();
    assert.deepEqual(snapshot.changedPaths, ["a.ts"]);
  });
}

async function editTypedValue(root: string, workspace: LightWorkspace, value: string) {
  await workspace.readCode({ target: "a.ts", view: "raw" }, {});
  const before = (await readFile(join(root, "a.ts"), "utf8")).trimEnd();
  const result = await workspace.editCode({ operations: [{ kind: "patch", path: "a.ts",
    patch: `*** Begin Patch\n*** Update File: a.ts\n@@\n-${before}\n+export const value: number = ${value};\n*** End Patch` }] });
  assert.equal(result.status, "ok", JSON.stringify(result));
}

async function settledTask(workspace: LightWorkspace, input: LightRunTaskInput) {
  let result: LightToolResult<unknown> = await workspace.runTask(input, {});
  const deadline = Date.now() + 30_000;
  while (result.status === "ok") {
    const data = result.data as { process?: string; run?: string; cursor?: string };
    if (data.process !== "running") break;
    assert.ok(Date.now() < deadline, "Compiler process did not settle");
    await delay(25);
    result = await workspace.runTask({ kind: "inspect", run: data.run!, cursor: data.cursor }, {});
  }
  return result;
}
