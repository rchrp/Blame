import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lightRunTaskInputSchema } from "./test-client/contracts.js";
import { LightWorkspace } from "./test-client/light-workspace.js";
import { LightFinishService } from "./test-client/light-finish-service.js";
import {
  readTaskCatalog,
  taskInvocation,
  type TaskCatalogItem,
} from "./test-client/units.js";
import { SessionJournal } from "./session-journal.js";

const filtered = [
  "--test-name-pattern=selected",
  "--test-reporter=tap",
  "selected suite.test.cjs",
];

test("project test argv preserves native order and package-manager forwarding", () => {
  for (const manager of ["npm", "pnpm", "yarn", "bun"] as const) {
    const task = {
      task_id: "test",
      kind: "test",
      script: "test",
      cwd: ".",
      package_manager: manager,
    } as TaskCatalogItem;
    assert.deepEqual(taskInvocation(task).args, ["run", "test"]);
    assert.deepEqual(taskInvocation(task, filtered).args, [
      "run",
      "test",
      ...(manager === "npm" ? ["--"] : []),
      ...filtered,
    ]);
  }
  for (const [executable, args] of [
    ["mvn", ["-f", "pom.xml", "test"]],
    ["dotnet", ["test", "App.csproj"]],
  ] as const) {
    const task = {
      kind: "test",
      invocation: { executable, args: [...args], cwd: "." },
    } as TaskCatalogItem;
    assert.deepEqual(taskInvocation(task, ["filter with spaces"]).args, [
      ...args,
      "filter with spaces",
    ]);
    assert.deepEqual(task.invocation?.args, args);
  }
});

test("schema bounds literal argv and leaves old project inputs valid", () => {
  const input = { kind: "project", task: "test" };
  assert.ok(lightRunTaskInputSchema.safeParse(input).success);
  assert.ok(
    lightRunTaskInputSchema.safeParse({ ...input, args: filtered }).success,
  );
  for (const args of [[""], ["a\0b"], ["x".repeat(2049)], Array(33).fill("x")])
    assert.equal(
      lightRunTaskInputSchema.safeParse({ ...input, args }).success,
      false,
    );
});

test("selected real Node tests pass without promoting partial selection to verified", async () => {
  await fixture(
    {
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "value.cjs": "exports.value = 1;\n",
      "selected suite.test.cjs": `const {test}=require('node:test'); const assert=require('node:assert/strict');
const {value}=require('./value.cjs');
test('selected',()=>assert.equal(value,2));
test('unrelated baseline failure',()=>assert.fail('outside requested scope'));\n`,
    },
    async (root) => {
      const workspace = new LightWorkspace(root, {
        sessionId: "selected-tests",
      });
      const edit = await workspace.editCode({
        operations: [
          {
            kind: "patch",
            path: "value.cjs",
            patch:
              "*** Begin Patch\n*** Update File: value.cjs\n@@\n-exports.value = 1;\n+exports.value = 2;\n*** End Patch",
          },
        ],
      });
      assert.equal(edit.status, "ok", JSON.stringify(edit));
      const result = await workspace.runTask(
        { kind: "project", task: "test", args: filtered },
        {},
      );
      assert.equal(result.status, "ok", JSON.stringify(result));
      const data = (
        result as {
          data: {
            check: {
              counts: { executed: number };
              outcome: string;
              selection: string;
            };
            command: string;
            validation: { status: string };
          };
        }
      ).data;
      assert.equal(data.check.outcome, "passed");
      assert.equal(data.check.counts.executed, 1);
      assert.equal(data.check.selection, "unknown");
      assert.equal(data.validation.status, "unknown");
      assert.match(data.command, /--test-name-pattern=selected/u);
      const journal = new SessionJournal(root, "selected-tests");
      await journal.hydrate();
      assert.match(
        journal.currentValidations()[0]!.command!,
        /selected suite/u,
      );
      let verified: boolean | undefined;
      const finish = new LightFinishService({
        workspaceRoot: root,
        conversationId: "selected-tests",
        onComplete: (notification) => {
          verified = notification.verified;
        },
      });
      await finish.finish(
        "Selected test passed; unrelated test not run.",
        {} as never,
      );
      assert.equal(verified, false);
      const all = await workspace.runTask(
        { kind: "project", task: "test" },
        {},
      );
      assert.match(JSON.stringify(all), /"outcome":"failed"/u);
      const selectedAgain = await workspace.runTask(
        { kind: "project", task: "test", args: filtered },
        {},
      );
      assert.match(JSON.stringify(selectedAgain), /"outcome":"passed"/u);
      const current = await new SessionJournal(
        root,
        "selected-tests",
      ).completionSnapshot();
      assert.equal(current.validations.length, 2);
      assert.ok(
        current.validations.some(
          (validation) => validation.status === "failed" && !validation.args,
        ),
      );
      assert.ok(
        current.validations.some((validation) => validation.args?.length),
      );
      await assert.rejects(
        finish.finish("done", {} as never),
        /still failing/u,
      );
    },
  );
});

test("package scripts receive literal arguments and non-test checks reject filters", async () => {
  await fixture(
    {
      "package.json": JSON.stringify({
        scripts: { test: "node argv.cjs", build: "node argv.cjs" },
      }),
      "argv.cjs":
        "require('node:fs').writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));\n",
    },
    async (root) => {
      const workspace = new LightWorkspace(root, { sessionId: "literal-argv" });
      const args = [
        "a b",
        "$(touch marker)",
        "a'b",
        '"quoted"',
        "; touch marker",
      ];
      assert.equal(
        (await workspace.runTask({ kind: "project", task: "test", args }, {}))
          .status,
        "ok",
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(root, "argv.json"), "utf8")),
        args,
      );
      await assert.rejects(access(join(root, "marker")));
      const rejected = await workspace.runTask(
        { kind: "project", task: "build", args: ["--help"] },
        {},
      );
      assert.equal(rejected.status, "blocked");
      assert.match(JSON.stringify(rejected), /only for project test tasks/u);
      const task = (await readTaskCatalog(root)).find(
        (item) => item.task_id === "build",
      )!;
      assert.throws(
        () => taskInvocation(task, ["--help"]),
        /only for project test tasks/u,
      );
    },
  );
});

async function fixture(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "blame-project-argv-"));
  try {
    for (const [path, content] of Object.entries(files))
      await writeFile(join(root, path), content);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
