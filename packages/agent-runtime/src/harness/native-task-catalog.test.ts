import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LightFinishService } from "./test-client/light-finish-service.js";
import { LightWorkspace } from "./test-client/light-workspace.js";
import { readTaskCatalog, taskInvocation } from "./test-client/units.js";
import { validationScopePaths } from "./test-client/units.js";
import { WorkspaceFiles } from "./workspace-files.js";

const execute = promisify(execFile);
const pytestAvailable = await execute("python3", [
  "-m",
  "pytest",
  "--version",
]).then(
  () => true,
  () => false,
);

test("native validation detects declared runners without inventing Python tests", async () => {
  await fixture(
    {
      "Cargo.toml": "[package]\nname='example'\n",
      "service/go.mod": "module example\n",
      "api/pyproject.toml": "[project]\nname='example'\n",
      "backend/App.csproj": "<Project />\n",
      "java/pom.xml": "<project />\n",
      "worker/pytest.ini": "[pytest]\n",
    },
    async (root) => {
      const tasks = await readTaskCatalog(root);
      assert.equal(tasks.length, 5);
      assert.deepEqual(
        tasks.map((task) => taskInvocation(task).executable).sort(),
        ["cargo", "dotnet", "go", "mvn", "python3"],
      );
      assert.ok(tasks.every((task) => task.kind === "test"));
      assert.ok(tasks.every((task) => task.cwd !== "api"));
    },
  );
});

test("native package boundaries prevent a Node build validating unrelated source", () => {
  const files = [
    "package.json",
    "api/pyproject.toml",
    "backend/App.csproj",
    "java/pom.xml",
    "native/Cargo.toml",
    "service/go.mod",
  ];
  const paths = [
    "app.ts",
    "api/app.py",
    "backend/App.cs",
    "java/src/App.java",
    "native/src/lib.rs",
    "service/main.go",
  ];
  assert.deepEqual(validationScopePaths(paths, files, "."), ["app.ts"]);
  assert.deepEqual(validationScopePaths(paths, files, "api"), ["api/app.py"]);
  assert.deepEqual(validationScopePaths(paths, files, "backend"), [
    "backend/App.cs",
  ]);
  assert.deepEqual(validationScopePaths(paths, files, "java"), [
    "java/src/App.java",
  ]);
  assert.deepEqual(validationScopePaths(paths, files, "native"), [
    "native/src/lib.rs",
  ]);
});

test("native caches and dependency directories do not invalidate source snapshots", async () => {
  await fixture(
    {
      "service/go.mod": "module example\n",
      "worker/.venv/pyproject.toml": "[tool.pytest.ini_options]\n",
      "worker/__pycache__/app.pyc": "compiled",
      "native/target/debug/output": "binary",
    },
    async (root) => {
      const files = new WorkspaceFiles(root);
      const snapshot = await files.snapshot();
      assert.deepEqual(snapshot.files, ["service/go.mod"]);
      assert.equal((await readTaskCatalog(root, snapshot.files)).length, 1);
    },
  );
});

test(
  "a native pytest failure blocks completion until fresh tests pass",
  { skip: !pytestAvailable },
  async () => {
    await fixture(
      {
        "pytest.ini": "[pytest]\n",
        "value.py": "value = 0\n",
        "test_value.py":
          "from value import value\ndef test_value():\n    assert value == 20\n",
      },
      async (root) => {
        const workspace = new LightWorkspace(root, {
          sessionId: "native-tests",
        });
        await replaceValue(workspace, 0, 1);
        const failed = await workspace.runTask(
          { kind: "project", task: "python3:test" },
          {},
        );
        assert.equal(failed.status, "blocked", JSON.stringify(failed));
        const finish = new LightFinishService({
          workspaceRoot: root,
          conversationId: "native-tests",
        });
        await assert.rejects(
          finish.finish("done", {} as never),
          /still failing/u,
        );
        await replaceValue(workspace, 1, 20);
        const passed = await workspace.runTask(
          { kind: "command", command: "python3 -m pytest" },
          {},
        );
        assert.equal(passed.status, "ok", JSON.stringify(passed));
        assert.match(JSON.stringify(passed), /"taskKind":"test"/u);
        assert.match(JSON.stringify(passed), /"status":"passed"/u);
        assert.equal(await finish.finish("done", {} as never), "done");
      },
    );
  },
);

async function replaceValue(
  workspace: LightWorkspace,
  before: number,
  after: number,
) {
  const patch = `*** Begin Patch\n*** Update File: value.py\n@@\n-value = ${before}\n+value = ${after}\n*** End Patch`;
  const result = await workspace.editCode({
    operations: [{ kind: "patch", path: "value.py", patch }],
  });
  assert.equal(result.status, "ok", JSON.stringify(result));
}

async function fixture(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "blame-native-tests-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
