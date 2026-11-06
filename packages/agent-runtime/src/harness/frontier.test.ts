import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LightWorkspace } from "./light-workspace.js";
import { observeCheck } from "./check-observation.js";
import { lightEditCodeInputSchema } from "./light-contracts.js";
import { auditSdkUsage, disjointUsage } from "../usage-audit.js";

const patch = (path: string, before: string, after: string) =>
  `*** Begin Patch\n*** Update File: ${path}\n@@\n-${before}\n+${after}\n*** End Patch`;
const sources = [
  [
    "module.ts",
    "export class Cache {\n  first() {\n    return 1;\n  }\n  second() {\n    return 1;\n  }\n}\n",
    "Cache.second",
    "    return 1;",
    "    return 2;",
  ],
  [
    "module.py",
    "# été\r\ndef first():\r\n    return 1\r\ndef second():\r\n    return 1\r\n",
    "second",
    "    return 1",
    "    return 2",
  ],
  [
    "Module.java",
    "class Module {\n  int first() {\n    return 1;\n  }\n  int second() {\n    return 1;\n  }\n}\n",
    "Module.second",
    "    return 1;",
    "    return 2;",
  ],
  [
    "Module.cs",
    "class Module {\n  int First() {\n    return 1;\n  }\n  int Second() {\n    return 1;\n  }\n}\n",
    "Module.Second",
    "    return 1;",
    "    return 2;",
  ],
];
for (const [path, source, name, before, after] of sources) {
  test(`scoped patch preserves other occurrences and bytes: ${path}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "frontier-"));
    try {
      await writeFile(join(root, path!), source!);
      const workspace = new LightWorkspace(root, { sessionId: "test" });
      const read = await workspace.readCode({ target: `${path}#${name}` }, {});
      assert.equal(read.status, "ok", JSON.stringify(read));
      const alias = (read as { data: { alias: string } }).data.alias;
      const result = await workspace.editCode({
        operations: [
          {
            kind: "patch",
            target: alias,
            patch: patch(path!, before!, after!),
          },
        ],
      });
      assert.equal(result.status, "ok", JSON.stringify(result));
      const index = source!.lastIndexOf(before!);
      assert.equal(
        await readFile(join(root, path!), "utf8"),
        source!.slice(0, index) + after + source!.slice(index + before!.length),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("scoped patch rejects a mismatched header and stale body, but relocates unchanged source", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontier-"));
  try {
    const path = "module.ts";
    const source = "export function value() {\n  return 1;\n}\n";
    await writeFile(join(root, path), source);
    const workspace = new LightWorkspace(root, { sessionId: "test" });
    const read = await workspace.readCode({ target: `${path}#value` }, {});
    const alias = (read as { data: { alias: string } }).data.alias;
    const input = {
      operations: [
        {
          kind: "patch" as const,
          target: alias,
          patch: patch(path, "  return 1;", "  return 2;"),
        },
      ],
    };
    assert.equal(
      (
        await workspace.editCode({
          operations: [
            {
              ...input.operations[0]!,
              patch: patch("other.ts", "  return 1;", "  return 2;"),
            },
          ],
        })
      ).status,
      "blocked",
    );
    await writeFile(join(root, path), source.replace("return 1", "return 3"));
    const conflict = await workspace.editCode(input);
    assert.equal(conflict.status, "blocked");
    assert.match(JSON.stringify(conflict), /return 3/u);
    await writeFile(join(root, path), `// déplacé\n${source}`);
    assert.equal((await workspace.editCode(input)).status, "ok");
    assert.equal(
      await readFile(join(root, path), "utf8"),
      `// déplacé\n${source.replace("return 1", "return 2")}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zero-output tests and interrupted green output never establish passing tests", () => {
  const empty = observeCheck(
    "dotnet test --no-restore",
    { all: "", failed: false, exitCode: 0 },
    ".",
    false,
  );
  assert.equal(empty.execution, "not_observed");
  assert.equal(empty.outcome, "unknown");
  const all =
    "# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
  assert.equal(
    observeCheck("node --test", { all, failed: false, exitCode: 0 }, ".", false)
      .outcome,
    "passed",
  );
  assert.equal(
    observeCheck(
      "node --test",
      { all, failed: true, interruption: "cancelled" },
      ".",
      false,
    ).outcome,
    "unknown",
  );
  assert.equal(
    observeCheck(
      "node --test",
      {
        all: all.replace("pass 2", "pass 0").replace("skipped 0", "skipped 2"),
        failed: false,
        exitCode: 0,
      },
      ".",
      false,
    ).outcome,
    "unknown",
  );
});

test("patch target remains optional", () => {
  assert.equal(
    lightEditCodeInputSchema.safeParse({
      operations: [{ kind: "patch", patch: patch("a.ts", "1", "2") }],
    }).success,
    true,
  );
});

test("usage audit keeps missing attempts unknown and never counts cache or reasoning twice", () => {
  const missing = auditSdkUsage({});
  assert.equal(missing.completeness, "unavailable");
  assert.equal(missing.cost, null);
  const usage = auditSdkUsage({
    usage: {
      inputTokens: 100,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
      outputTokens: 50,
      reasoningTokens: 40,
      cost: 0.1,
    },
  });
  assert.deepEqual(
    disjointUsage(usage, {
      inputIncludesCacheRead: true,
      inputIncludesCacheWrite: true,
    }),
    { ordinary: 50, cacheRead: 30, cacheWrite: 20, output: 50 },
  );
  assert.equal(
    disjointUsage(missing, {
      inputIncludesCacheRead: true,
      inputIncludesCacheWrite: true,
    }),
    null,
  );
});

test("experimental search groups repeated hits and publishes an immediately editable body", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontier-"));
  try {
    await writeFile(
      join(root, "cache.ts"),
      "export function calculate() {\n  const needle = 1;\n  return needle;\n}\n",
    );
    const workspace = new LightWorkspace(root, {
      sessionId: "search",
      experimentalSearchExpansion: true,
    });
    const found = await workspace.searchCode({
      query: "needle",
      scope: ["cache.ts"],
    });
    assert.equal(found.status, "ok");
    const data = (
      found as {
        data: {
          expanded: boolean;
          results: Array<{ alias: string; content: string }>;
        };
      }
    ).data;
    assert.equal(data.expanded, true, JSON.stringify(found));
    assert.equal(data.results.length, 1);
    assert.match(data.results[0]!.content, /return needle/u);
    const edited = await workspace.editCode({
      operations: [
        {
          kind: "patch",
          target: data.results[0]!.alias,
          patch: patch(
            "cache.ts",
            "  const needle = 1;",
            "  const needle = 2;",
          ),
        },
      ],
    });
    assert.equal(edited.status, "ok", JSON.stringify(edited));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an outline cannot authorize replacement of an unobserved body", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontier-"));
  try {
    const body = Array.from({ length: 30 }, (_, index) => `  const step${index} = compute(${index});`).join("\n");
    const source = `export function value() {\n${body}\n  return 1;\n}\n\nexport function other() {\n${body}\n  return 2;\n}\n`;
    await writeFile(join(root, "a.ts"), source);
    const workspace = new LightWorkspace(root, { sessionId: "outline" });
    const outline = await workspace.readCode(
      { target: "a.ts", view: "outline" },
      {},
    );
    const content = (outline as { data: { content: string } }).data.content;
    const alias = /⋯ L2–\d+ · [\d.k]+ · (s\d+)/u.exec(content)![1]!;
    const result = await workspace.editCode({
      operations: [
        {
          kind: "symbol",
          target: alias,
          action: "replace",
          content: "export function value() { return 2; }",
        },
      ],
    });
    assert.equal(result.status, "blocked");
    assert.equal(await readFile(join(root, "a.ts"), "utf8"), source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a local patch cannot add a sibling through the declaration boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontier-"));
  try {
    const source = "export function value() {\n  return 1;\n}\n";
    await writeFile(join(root, "a.ts"), source);
    const workspace = new LightWorkspace(root, { sessionId: "boundary" });
    const read = await workspace.readCode({ target: "a.ts#value" }, {});
    const alias = (read as { data: { alias: string } }).data.alias;
    const result = await workspace.editCode({
      operations: [
        {
          kind: "patch",
          target: alias,
          patch: patch("a.ts", "}", "}\n+export function sibling() {}"),
        },
      ],
    });
    assert.equal(result.status, "blocked");
    assert.equal(await readFile(join(root, "a.ts"), "utf8"), source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded invocation reports reject entities, partial counts and setup errors", async () => {
  const { parseTestReport, parseTestReports } = await import("./test-report.js");
  const xml =
    '<testsuite tests="2" failures="1" errors="0"><testcase name="one"/><testcase name="two" file="test.ts" line="4"><failure message="assertion">expected public getter</failure></testcase></testsuite>';
  const report = parseTestReport(xml);
  assert.deepEqual(report?.counts, {
    executed: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
  });
  assert.equal(report?.failures[0]?.message, "expected public getter");
  assert.equal(
    parseTestReport(xml.replace('tests="2"', 'tests="3"')),
    undefined,
  );
  assert.equal(
    parseTestReport(
      '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>' + xml,
    ),
    undefined,
  );
  assert.equal(
    parseTestReport('<testsuite tests="1"><testcase></testsuite>'),
    undefined,
  );
  assert.equal(
    parseTestReport("<a>".repeat(65) + "</a>".repeat(65)),
    undefined,
  );
  const zero = '<testsuite tests="0" errors="1" failures="0"/>';
  assert.equal(
    observeCheck(
      "pytest",
      { all: zero, exitCode: 0, failed: false },
      ".",
      false,
    ).outcome,
    "failed",
  );
  const trx =
    '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results><UnitTestResult outcome="Passed"/></Results><ResultSummary outcome="Completed"><Counters total="1" executed="1" passed="1" failed="0"/></ResultSummary></TestRun>';
  assert.deepEqual(parseTestReport(trx)?.counts, {
    executed: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
  });
  assert.deepEqual(parseTestReports([xml, trx])?.counts, {
    executed: 3,
    passed: 2,
    failed: 1,
    skipped: 0,
  });
});

test("mixed line endings outside a scoped replacement stay byte exact", async () => {
  const { planScopedLightPatch } = await import("./light-patch.js");
  const source =
    "function value() {\r\n  const text = 'été';\n  return 1;\r\n}";
  const replacements = planScopedLightPatch(
    source,
    patch("a.ts", "  return 1;", "  return 2;"),
    "a.ts",
  );
  let bytes = Buffer.from(source);
  for (const replacement of [...replacements].reverse())
    bytes = Buffer.concat([
      bytes.subarray(0, replacement.start),
      Buffer.from(replacement.replacement),
      bytes.subarray(replacement.end),
    ]);
  assert.equal(bytes.toString(), source.replace("return 1", "return 2"));
});

test("receipt persistence failure reports committed code without suggesting replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontier-"));
  try {
    const { LightEditService } = await import("./light-edit.js");
    const { LightAliasRegistry } = await import("./light-aliases.js");
    const { WorkspaceFiles } = await import("./workspace-files.js");
    const { SessionJournal } = await import("./session-journal.js");
    await writeFile(join(root, "a.txt"), "before\n");
    const journal = new SessionJournal(root, "receipt-failure");
    journal.recordChange = async () => {
      throw new Error("disk full");
    };
    const edit = new LightEditService(new LightAliasRegistry(), {
      files: new WorkspaceFiles(root),
      journal,
    });
    const result = await edit.edit({
      operations: [{ kind: "patch", patch: patch("a.txt", "before", "after") }],
    });
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.applied, true);
    assert.equal(result.recovery, "recovery_required");
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "after\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback preserves a concurrent user edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontier-"));
  try {
    const { LightCommitService } = await import("./light-commit.js");
    const { WorkspaceFiles } = await import("./workspace-files.js");
    await writeFile(join(root, "a.txt"), "user content");
    const service = new LightCommitService(new WorkspaceFiles(root));
    await assert.rejects(
      service.restoreFiles(
        [
          {
            path: "a.txt",
            before: Buffer.from("before"),
            after: Buffer.from("after"),
          },
        ],
        true,
      ),
      /concurrent change/u,
    );
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "user content");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real failed Node test supplies an exact source excerpt", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontier-"));
  try {
    await writeFile(
      join(root, "sample.test.cjs"),
      "const test = require('node:test');\nconst assert = require('node:assert/strict');\ntest('public getter', () => { assert.equal(1, 2); });\n",
    );
    const workspace = new LightWorkspace(root, { sessionId: "diagnostic" });
    const result = await workspace.runTask(
      {
        kind: "command",
        command: "node --test --test-reporter=tap sample.test.cjs",
      },
      {},
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    const data = (
      result as {
        data: {
          check: { execution: string; outcome: string };
          diagnostics: unknown[];
        };
      }
    ).data;
    assert.equal(data.check.execution, "observed", JSON.stringify(result));
    assert.equal(data.check.outcome, "failed");
    assert.ok(data.diagnostics.length > 0, JSON.stringify(result));
    assert.match(JSON.stringify(data.diagnostics), /assert.equal\(1, 2\)/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an old green report cannot validate a silent test command", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontier-"));
  try {
    const old = '<testsuite tests="1"><testcase name="old"/></testsuite>';
    await writeFile(join(root, "test-results.xml"), old);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: 'node -e ""' } }),
    );
    const workspace = new LightWorkspace(root, { sessionId: "stale-report" });
    const result = await workspace.runTask(
      { kind: "project", task: "test" },
      {},
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    const check = (
      result as { data: { check: { execution: string; outcome: string } } }
    ).data.check;
    assert.equal(check.execution, "not_observed");
    assert.equal(check.outcome, "unknown");
    assert.equal(await readFile(join(root, "test-results.xml"), "utf8"), old);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a managed pytest task attributes a unique JUnit report", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontier-"));
  try {
    const executable = join(root, "python3");
    await writeFile(
      executable,
      "#!/bin/sh\ncase \"$*\" in *--version*) echo 'pytest 8.3.1'; exit 0;; esac\nfor arg in \"$@\"; do case \"$arg\" in --junitxml=*) path=${arg#--junitxml=}; printf '%s' '<testsuite tests=\"1\" failures=\"0\" errors=\"0\"><testcase name=\"ok\"/></testsuite>' > \"$path\";; esac; done\n",
    );
    await import("node:fs/promises").then(({ chmod }) => chmod(executable, 0o755));
    const { managedTestReport } = await import("./managed-test-report.js");
    const invocation = { executable, args: ["-m", "pytest"], cwd: "." };
    const managed = await managedTestReport(
      {
        task_id: "python3:test",
        kind: "test",
        command: "python3 -m pytest",
        cwd: ".",
        invocation,
        dependencyPolicy: "optional",
        requiresNetwork: false,
        supportsFileSelection: false,
      },
      invocation,
      root,
      1,
    );
    assert.ok(managed);
    const { executeWorkspaceCommand } = await import("./workspace-command-process.js");
    const execution = await executeWorkspaceCommand(
      managed.invocation.executable,
      managed.invocation.args,
      { cwd: root },
    );
    const check = observeCheck(
      managed.command,
      execution,
      ".",
      false,
      await managed.read(),
    );
    assert.equal(check.evidenceOrigin, "report");
    assert.equal(check.outcome, "passed");
    assert.match(managed.command, /--junitxml=/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed VSTest and Surefire tasks read only their invocation reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontier-"));
  try {
    const { chmod } = await import("node:fs/promises");
    const { managedTestReport } = await import("./managed-test-report.js");
    const { executeWorkspaceCommand } = await import("./workspace-command-process.js");
    const cases = [
      {
        executable: "dotnet",
        args: ["test", "App.csproj"],
        label: "App.csproj:test",
        script:
          "#!/bin/sh\n[ \"$1\" = '--version' ] && { echo '8.0.100'; exit 0; }\nprev=''; for arg in \"$@\"; do [ \"$prev\" = '--results-directory' ] && dir=\"$arg\"; prev=\"$arg\"; done\nprintf '%s' '<TestRun xmlns=\"http://microsoft.com/schemas/VisualStudio/TeamTest/2010\"><Results><UnitTestResult outcome=\"Passed\"/></Results><ResultSummary outcome=\"Completed\"><Counters total=\"1\" executed=\"1\" passed=\"1\" failed=\"0\"/></ResultSummary></TestRun>' > \"$dir/results.trx\"\n",
      },
      {
        executable: "mvn",
        args: ["-f", "pom.xml", "test"],
        label: "maven:test",
        script:
          "#!/bin/sh\n[ \"$1\" = '--version' ] && { echo 'Apache Maven 3.9.9'; exit 0; }\nfor arg in \"$@\"; do case \"$arg\" in -Dsurefire.reportsDirectory=*) dir=${arg#*=};; esac; done\nprintf '%s' '<testsuite tests=\"1\" failures=\"0\" errors=\"0\"><testcase name=\"ok\"/></testsuite>' > \"$dir/TEST-one.xml\"\n",
      },
    ];
    for (const [index, item] of cases.entries()) {
      const executable = join(root, item.executable);
      await writeFile(executable, item.script);
      await chmod(executable, 0o755);
      const invocation = { executable, args: item.args, cwd: "." };
      const managed = await managedTestReport(
        {
          task_id: item.label,
          kind: "test",
          command: [item.executable, ...item.args].join(" "),
          cwd: ".",
          invocation,
          dependencyPolicy: "optional",
          requiresNetwork: false,
          supportsFileSelection: false,
        },
        invocation,
        root,
        index + 1,
      );
      assert.ok(managed);
      const execution = await executeWorkspaceCommand(
        managed.invocation.executable,
        managed.invocation.args,
        { cwd: root },
      );
      const check = observeCheck(
        managed.command,
        execution,
        ".",
        false,
        await managed.read(),
      );
      assert.equal(check.evidenceOrigin, "report", item.executable);
      assert.equal(check.outcome, "passed", item.executable);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("joining CRLF lines does not leave a stray carriage return", async () => {
  const { planScopedLightPatch } = await import("./light-patch.js");
  const source =
    "function f() {\r\n  const value =\r\n    1;\r\n  return value;\r\n}";
  const replacements = planScopedLightPatch(
    source,
    "*** Begin Patch\n*** Update File: a.ts\n@@\n-  const value =\n-    1;\n+  const value = 1;\n*** End Patch",
    "a.ts",
  );
  let bytes = Buffer.from(source);
  for (const replacement of [...replacements].reverse())
    bytes = Buffer.concat([
      bytes.subarray(0, replacement.start),
      Buffer.from(replacement.replacement),
      bytes.subarray(replacement.end),
    ]);
  assert.equal(bytes.toString(), source.replace("=\r\n    1", "= 1"));
});
