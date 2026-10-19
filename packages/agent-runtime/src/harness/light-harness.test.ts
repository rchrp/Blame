import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  capabilityParseAvailability,
  lightCapabilityDescription,
} from "./light-capabilities.js";
import { LightCommitService } from "./light-commit.js";
import { lightEditCodeInputSchema, lightRunTaskInputSchema } from "./light-contracts.js";
import type { LightToolResult } from "./light-contracts.js";
import { alignDependencyPackages } from "./light-dependencies.js";
import { executeLightWorkspaceRequest } from "./light-executor.js";
import { lightSemanticHarnessTools } from "./light-tools.js";
import { LightWorkspace } from "./light-workspace.js";
import { createFinishTaskTool } from "./finish-task.js";
import { createInitialTaskBriefing } from "./initial-task-briefing.js";
import { SessionJournal } from "./session-journal.js";
import { WorkspaceFiles } from "./workspace-files.js";

test("runtime capabilities include loaded C, C++, HTML, and application adapters", () => {
  const description = lightCapabilityDescription();
  for (const extension of [
    ".c",
    ".cpp",
    ".cs",
    ".go",
    ".html",
    ".java",
    ".py",
    ".rs",
    ".tsx",
  ])
    assert.match(description, new RegExp(`\\${extension}`));
});

test("an unloaded parser reports unavailable and never passed", () => {
  assert.equal(capabilityParseAvailability({ loaded: false }), "unavailable");
  assert.equal(capabilityParseAvailability(), "unsupported");
});

const symbolLanguageCases = [
  [
    "sample.ts",
    "export function sample() { return 1 }\n",
    "sample",
    "{ return 2 }",
  ],
  [
    "sample.mts",
    "export function sample() { return 1 }\n",
    "sample",
    "{ return 2 }",
  ],
  [
    "sample.cts",
    "export function sample() { return 1 }\n",
    "sample",
    "{ return 2 }",
  ],
  [
    "sample.tsx",
    "export function Sample() { return <div /> }\n",
    "Sample",
    "{ return <span /> }",
  ],
  [
    "sample.js",
    "export function sample() { return 1 }\n",
    "sample",
    "{ return 2 }",
  ],
  [
    "sample.mjs",
    "export function sample() { return 1 }\n",
    "sample",
    "{ return 2 }",
  ],
  ["sample.cjs", "function sample() { return 1 }\n", "sample", "{ return 2 }"],
  [
    "sample.jsx",
    "export function Sample() { return <div /> }\n",
    "Sample",
    "{ return <span /> }",
  ],
  ["sample.py", "def sample():\n    return 1\n", "sample", "return 2"],
  ["sample.rs", "fn sample() -> i32 { 1 }\n", "sample", "{ 2 }"],
  [
    "sample.go",
    "package sample\nfunc Sample() int { return 1 }\n",
    "Sample",
    "{ return 2 }",
  ],
  [
    "Sample.java",
    "class Sample { int value() { return 1; } }\n",
    "value",
    "{ return 2; }",
  ],
  [
    "Sample.cs",
    "class Sample { int Value() { return 1; } }\n",
    "Value",
    "{ return 2; }",
  ],
  ["sample.c", "int sample(void) { return 1; }\n", "sample", "{ return 2; }", "unsupported"],
  [
    "sample.h",
    "static int sample(void) { return 1; }\n",
    "sample",
    "{ return 2; }",
    "unsupported",
  ],
  ["sample.cpp", "int sample() { return 1; }\n", "sample", "{ return 2; }", "unsupported"],
  ["sample.cc", "int sample() { return 1; }\n", "sample", "{ return 2; }", "unsupported"],
  ["sample.cxx", "int sample() { return 1; }\n", "sample", "{ return 2; }", "unsupported"],
  [
    "sample.hpp",
    "inline int sample() { return 1; }\n",
    "sample",
    "{ return 2; }",
    "unsupported",
  ],
] as const;

for (const [path, source, query, replacement, validation = "passed"] of symbolLanguageCases)
  test(`symbol read and body edit execute for ${path}`, async () => {
    await withWorkspace({ [path]: source }, async (root) => {
      const workspace = lightWorkspace(root, `language-${path}`);
      const alias = await symbolAlias(workspace, query);
      const symbol = data(
        await workspace.readCode(
          { target: alias, view: "symbol" },
          { agentId: "lead" },
        ),
      );
      assert.match(String(symbol.signature), new RegExp(query, "u"));
      assert.ok(String(symbol.body));
      const result = await workspace.editCode({
        operations: [
          {
            action: "replace_body",
            content: replacement,
            kind: "symbol",
            target: alias,
          },
        ],
      });
      assert.equal(result.status, "ok");
      assert.equal(record(data(result).parse).status, validation);
      assert.match(
        await readFile(join(root, path), "utf8"),
        replacement.includes("span") ? /span/u : /2/u,
      );
    });
  });

test("whole symbol replacement includes exported declaration wrappers", async () => {
  const cases = [
    {
      path: "component.tsx",
      replacement: "export function Home() { return <main>Home</main> }",
      source: "export const Home = () => <main>Old</main>\n",
      symbol: "Home",
    },
    {
      path: "projects.ts",
      replacement: "export async function listProjects() { return [] }",
      source: "export async function listProjects() { return ['old'] }\n",
      symbol: "listProjects",
    },
  ];
  for (const item of cases)
    await withWorkspace({ [item.path]: item.source }, async (root) => {
      const workspace = lightWorkspace(root, `export-${item.symbol}`);
      const alias = await symbolAlias(workspace, item.symbol);
      const result = await workspace.editCode({
        operations: [
          {
            action: "replace",
            content: item.replacement,
            kind: "symbol",
            target: alias,
          },
        ],
      });
      assert.equal(result.status, "ok");
      assert.equal(record(data(result).parse).status, "passed");
      assert.equal(
        await readFile(join(root, item.path), "utf8"),
        `${item.replacement}\n`,
      );
    });
});

test("TypeScript validation rejects syntax missed by either parser", async () => {
  const cases = [
    [
      "export const value = 1",
      "export const export function value() { return 1 }",
    ],
    [
      "export async function value() { return 1 }",
      "export export async function value() { return 1 }",
    ],
  ] as const;
  for (const [source, invalid] of cases)
    await withWorkspace({ "invalid.ts": `${source}\n` }, async (root) => {
      const workspace = lightWorkspace(root, `strict-parse-${source.length}`);
      const result = await workspace.editCode({
        operations: [
          {
            kind: "patch",
            path: "invalid.ts",
            patch: applyPatch("invalid.ts", [`-${source}`, `+${invalid}`]),
          },
        ],
      });
      assert.equal(result.status, "blocked");
      if (result.status === "blocked")
        assert.match(result.message, /Final parse failed/u);
      assert.equal(
        await readFile(join(root, "invalid.ts"), "utf8"),
        `${source}\n`,
      );
    });
});

test("TSX body replacement preserves UTF-8 boundaries", async () => {
  const source =
    "export default function Home() { return <main>Raphaël 😀</main> }\n";
  await withWorkspace({ "page.tsx": source }, async (root) => {
    const workspace = lightWorkspace(root, "tsx-utf8-offsets");
    const alias = await symbolAlias(workspace, "Home");
    const result = await workspace.editCode({
      operations: [
        {
          action: "replace_body",
          content: "{ return <main>Élodie 😀</main> }",
          kind: "symbol",
          target: alias,
        },
      ],
    });
    assert.equal(result.status, "ok");
    assert.equal(
      await readFile(join(root, "page.tsx"), "utf8"),
      "export default function Home() { return <main>Élodie 😀</main> }\n",
    );
  });
});

test("delimited symbol bodies accept statement-only replacements", async () => {
  const source = "export function label() { return 'old' }\n";
  await withWorkspace({ "label.ts": source }, async (root) => {
    const workspace = lightWorkspace(root, "normalized-symbol-body");
    const alias = await symbolAlias(workspace, "label");
    const result = await workspace.editCode({
      operations: [
        {
          action: "replace_body",
          content: "  const value = 'new';\n  return value;",
          kind: "symbol",
          target: alias,
        },
      ],
    });
    assert.equal(result.status, "ok");
    assert.equal(
      await readFile(join(root, "label.ts"), "utf8"),
      "export function label() {\n  const value = 'new';\n  return value;\n}\n",
    );
  });
});

test("tool surface contains only the four workspace tools", async () => {
  await withWorkspace(
    { "src/app.ts": "export const value = 1\n" },
    async (root) => {
      const tools = lightSemanticHarnessTools(root, {
        taskContract: contract("surface"),
      });
      const names = tools.map(({ name }) => name);
      assert.deepEqual(names, [
        "search_code",
        "read_code",
        "edit_code",
        "run_task",
      ]);
      const edit = tools.find(({ name }) => name === "edit_code");
      assert.match(JSON.stringify(edit?.inputSchema), /"maxLength":2097152/u);
      for (const tool of tools)
        assert.doesNotMatch(tool.description, /Symbol read\/edit:/u);
    },
  );
});

test("auto search combines lexical matches and supports multi-term glob scopes", async () => {
  await withWorkspace(
    {
      "package.json": JSON.stringify(
        { name: "root-package", scripts: { build: "tsc" } },
        null,
        2,
      ),
      "packages/web/package.json": JSON.stringify(
        { name: "web-package", scripts: { test: "node --test" } },
        null,
        2,
      ),
      "src/scripts.ts": "export function scripts() { return 'code' }\n",
    },
    async (root) => {
      const workspace = lightWorkspace(root, "search-routing");
      const global = data(await workspace.searchCode({ query: "scripts" }));
      assert.ok(
        array(global.results).some(
          (value) => record(value).path === "package.json",
        ),
      );
      assert.ok(
        array(global.results).some(
          (value) => record(value).qualifiedName === "scripts",
        ),
      );
      const scoped = data(
        await workspace.searchCode({
          query: "scripts",
          scope: ["**/package.json"],
        }),
      );
      assert.equal(scoped.mode, "auto");
      assert.deepEqual(
        new Set(array(scoped.results).map((value) => record(value).path)),
        new Set(["package.json", "packages/web/package.json"]),
      );
      const terms = data(
        await workspace.searchCode({
          query: "scripts package",
          scope: "**/package.json",
        }),
      );
      assert.ok(array(terms.results).length > 0);
      assert.ok(
        array(terms.results).every((value) =>
          String(record(value).path).endsWith("package.json"),
        ),
      );
      const path = data(
        await workspace.searchCode({
          query: "package.json",
          scope: "*",
          mode: "text",
        }),
      );
      const pathResult = record(array(path.results)[0]);
      assert.equal(pathResult.path, "package.json");
      assert.equal(
        data(
          await workspace.readCode(
            { target: String(pathResult.alias) },
            { agentId: "lead" },
          ),
        ).path,
        "package.json",
      );
      const braces = data(
        await workspace.searchCode({
          query: "scripts",
          scope: "**/*.{ts,tsx}",
        }),
      );
      assert.ok(
        array(braces.results).some(
          (value) => record(value).path === "src/scripts.ts",
        ),
      );
      const excluded = await workspace.searchCode({
        query: "scripts",
        scope: "node_modules/**/*",
      });
      assert.equal(excluded.status, "blocked");
      if (excluded.status === "blocked")
        assert.equal(excluded.category, "input");
    },
  );
});

test("raw rereads return source and keep edit aliases stable across unrelated reads", async () => {
  await withWorkspace(
    { "a.ts": "export const a = 1\n", "b.ts": "export const b = 2\n" },
    async (root) => {
      const workspace = lightWorkspace(root, "coverage");
      const context = { agentId: "lead" };
      const first = data(await workspace.readCode({ target: "a.ts" }, context));
      assert.equal(first.view, "raw");
      const firstTarget = record(array(first.editTargets)[0]);
      assert.equal(firstTarget.qualifiedName, "a");
      await workspace.readCode({ target: "b.ts" }, context);
      const repeated = data(
        await workspace.readCode({ target: "a.ts" }, context),
      );
      assert.equal(repeated.content, first.content);
      assert.equal(
        record(array(repeated.editTargets)[0]).alias,
        firstTarget.alias,
      );
      assert.ok(JSON.stringify(repeated).length < 400);
      await workspace.edits.edit(
        {
          operations: [
            {
              kind: "patch",
              path: "a.ts",
              patch: applyPatch("a.ts", [
                "-export const a = 1",
                "+export const a = 3",
              ]),
            },
          ],
        },
        { sessionId: "coverage", toolCallId: "edit-a" },
      );
      assert.equal(
        data(await workspace.readCode({ target: "b.ts" }, context)).content,
        "export const b = 2\n",
      );
      assert.match(
        String(
          data(await workspace.readCode({ target: "a.ts" }, context)).content,
        ),
        /a = 3/u,
      );
    },
  );
});

test("a raw read stays contiguous after a symbol read partially covers the file", async () => {
  const source = `type ProjectCardProps = {
  title: string;
};

const artist = "Raphaël 🚀";

export function ProjectCard({ title }: ProjectCardProps) {
  return <h2>{title}</h2>;
}
`;
  await withWorkspace({ "ProjectCard.tsx": source }, async (root) => {
    const workspace = lightWorkspace(root, "partial-raw-coverage");
    const context = { agentId: "lead" };
    await workspace.readCode(
      { target: "ProjectCard.tsx#ProjectCardProps", view: "symbol" },
      context,
    );
    const raw = data(
      await workspace.readCode(
        { target: "ProjectCard.tsx", view: "raw" },
        context,
      ),
    );
    assert.equal(raw.content, source);
    assert.equal(
      data(
        await workspace.readCode(
          { target: "ProjectCard.tsx", view: "raw" },
          context,
        ),
      ).content,
      source,
    );
  });
});

test("a lexical alias promotes to its enclosing editable symbol", async () => {
  await withWorkspace(
    { "target.ts": "export function target() { return 1 }\n" },
    async (root) => {
      const workspace = lightWorkspace(root, "lexical-symbol");
      const search = data(
        await workspace.searchCode({ query: "return 1", mode: "text" }),
      );
      const alias = String(record(array(search.results)[0]).alias);
      const result = data(
        await workspace.readCode(
          { target: alias, view: "symbol" },
          { agentId: "lead" },
        ),
      );
      assert.equal(result.view, "symbol");
      assert.equal(result.qualifiedName, "target");
      assert.ok(result.editTarget);
    },
  );
});

test("CSS outlines stay compact and expose an append target", async () => {
  const rules = Array.from(
    { length: 60 },
    (_, index) =>
      `.rule-${index} { background: linear-gradient(135deg, #111111, #222222); border: 1px solid #333333; color: #f5f5f5; padding: 1rem 2rem; }`,
  ).join("\n");
  const source = `:root { --accent: red; }\n${rules}\n`;
  await withWorkspace({ "styles.css": source }, async (root) => {
    const workspace = lightWorkspace(root, "compact-css-outline");
    const result = data(
      await workspace.readCode(
        { target: "styles.css", view: "outline" },
        { agentId: "lead" },
      ),
    );
    assert.equal(array(result.items).length, 32);
    assert.equal(result.truncated, true);
    assert.ok(JSON.stringify(result).length < source.length);
    assert.ok(
      array(result.items).every(
        (item) => record(item).kind !== "css_custom_property",
      ),
    );
    assert.equal(
      record(array(result.editTargets).at(-1)).qualifiedName,
      ".rule-59",
    );
  });
});

test("path-qualified symbol aliases resolve when the path matches", async () => {
  const source = ".hero { color: red; }\n";
  await withWorkspace({ "styles.css": source }, async (root) => {
    const workspace = lightWorkspace(root, "qualified-symbol-alias");
    const outline = data(
      await workspace.readCode(
        { target: "styles.css", view: "outline" },
        { agentId: "lead" },
      ),
    );
    const alias = String(record(array(outline.items)[0]).alias);
    const result = await workspace.editCode({
      operations: [
        {
          action: "insert_after",
          content: "\n.projects { color: blue; }",
          kind: "symbol",
          target: `styles.css#${alias}`,
        },
      ],
    });
    assert.equal(result.status, "ok");
    assert.equal(
      await readFile(join(root, "styles.css"), "utf8"),
      `${source}.projects { color: blue; }\n`,
    );
  });
});

test("rereads and receipts survive isolated Light bridge executions", async () => {
  await withWorkspace(
    { "value.ts": "export const value = 1\n" },
    async (root) => {
      const request = {
        input: { target: "value.ts" },
        taskContract: { session_id: "remote-coverage" },
        tool: "read_code" as const,
        toolContext: { agentId: "lead" },
        workspaceRoot: root,
      };
      assert.equal(
        data(await executeLightWorkspaceRequest(request)).view,
        "raw",
      );
      assert.equal(
        data(await executeLightWorkspaceRequest(request)).content,
        "export const value = 1\n",
      );
    },
  );
});

test("an unavailable package manager is reported without mutating manifests", async () => {
  const manifest = `${JSON.stringify({
    name: "unavailable-manager",
    packageManager: "pnpm@999.0.0",
  })}\n`;
  await withWorkspace({ "package.json": manifest }, async (root) => {
    const briefing = await createInitialTaskBriefing({ workspaceRoot: root });
    assert.match(
      briefing ?? "",
      /Package manager: pnpm; executable unavailable/u,
    );
    const workspace = lightWorkspace(root, "dependency-failure");
    const result = await workspace.tasks.run({
      action: "add",
      kind: "dependency",
      packages: ["example-package"],
    });
    assert.equal(result.status, "blocked");
    if (result.status === "blocked")
      assert.equal(result.category, "environment");
    assert.equal(await readFile(join(root, "package.json"), "utf8"), manifest);
  });
});

test("the briefing exposes package topology, key files, and stack versions", async () => {
  await withWorkspace(
    {
      "package.json": JSON.stringify({
        name: "workspace",
        scripts: { build: "tsc", test: "node --test" },
        dependencies: { "@prisma/client": "7.9.1" },
      }),
      "packages/api/package.json": JSON.stringify({
        name: "api",
        scripts: { dev: "node src/server.js" },
      }),
      "packages/api/src/server.ts": `export const server = true\nexport const padding = "${"x".repeat(8_100)}"\n`,
      "prisma/schema.prisma": "model User {\n  id Int @id\n}\n",
      ".env.example": "DATABASE_URL=postgresql://localhost/example\n",
      "tsconfig.json": "{}\n",
    },
    async (root) => {
      const briefing = await createInitialTaskBriefing({
        workspaceRoot: root,
        taskContract: {
          ...contract("briefing-map"),
          objective: "Update the API server",
        },
      });
      assert.match(briefing ?? "", /Project map: .*packages \(/u);
      assert.match(briefing ?? "", /prisma\/schema\.prisma/u);
      assert.match(briefing ?? "", /@prisma\/client@7\.9\.1/u);
      assert.match(
        briefing ?? "",
        /Runtime variables: DATABASE_URL referenced/u,
      );
      assert.match(briefing ?? "", /must not be replaced/u);
      assert.match(briefing ?? "", /scripts build,test/u);
      assert.match(briefing ?? "", /pass listed IDs directly to run_task/u);
      assert.match(briefing ?? "", /packages\/api\/src\/server\.ts#server/u);
      assert.doesNotMatch(briefing ?? "", /scripts dev/u);
      assert.doesNotMatch(briefing ?? "", /Preview services/u);
      assert.doesNotMatch(briefing ?? "", /node_modules/u);
      assert.ok((briefing?.length ?? Infinity) < 6_000);
    },
  );
});

test("the briefing uses one auto-routed target per small candidate", async () => {
  await withWorkspace(
    {
      "src/invoice.ts":
        "export function calculateDiscount(value: number) { return value }\n",
      "test/invoice.test.ts": "const invoice = 1\n",
    },
    async (root) => {
      const briefing = await createInitialTaskBriefing({
        workspaceRoot: root,
        taskContract: {
          ...contract("briefing-small-target"),
          objective: "Update calculateDiscount and its invoice test",
        },
      });
      assert.match(
        briefing ?? "",
        /Likely targets: test\/invoice\.test\.ts, src\/invoice\.ts\./u,
      );
      assert.doesNotMatch(briefing ?? "", /#calculateDiscount|#invoice/u);
    },
  );
});

test("Prisma family additions align with the installed client version", () => {
  const packages = alignDependencyPackages(
    ["@prisma/adapter-pg", "@prisma/client@7.10.0", "zod"],
    { dependencies: { "@prisma/client": "^7.9.1" } },
  );
  assert.deepEqual(packages, [
    "@prisma/adapter-pg@7.9.1",
    "@prisma/client@7.10.0",
    "zod",
  ]);
});

test("run_task preserves pipeline failures and complete diagnostics", async () => {
  await withWorkspace({ "package.json": "{}\n" }, async (root) => {
    const workspace = lightWorkspace(root, "pipeline-diagnostic");
    const result = await workspace.tasks.run({
      kind: "command",
      command:
        "node -e \"console.error('diagnostic start'); console.error('fatal detail'); process.exit(7)\" 2>&1 | cat",
    });
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") return;
    assert.equal(result.category, "command");
    assert.match(result.message, /code 7/u);
    assert.match(result.message, /diagnostic start/u);
    assert.match(result.message, /fatal detail/u);
  });
});

test("run_task executes an unambiguous command without a kind", async () => {
  await withWorkspace({ "src/value.txt": "value\n" }, async (root) => {
    const tool = lightSemanticHarnessTools(root).find(({ name }) => name === "run_task")!;
    const result = await tool.execute(
      { command: "node -p 'process.cwd()'", cwd: "src" },
      { sessionId: "implicit-command", toolCallId: "cwd" } as never,
    ) as LightToolResult<unknown>;
    // The OS reports the physical working directory (/private/var on macOS).
    assert.equal(data(result).output, join(await realpath(root), "src"));
  });
});

test("run_task normalizes an implicit command before remote dispatch", async () => {
  const calls: unknown[] = [];
  const tool = lightSemanticHarnessTools("/workspace", {
    executor: async (request) => {
      calls.push(request.input);
      return { status: "ok", data: {} };
    },
  }).find(({ name }) => name === "run_task")!;
  const result = await tool.execute(
    { command: "printf ready", cwd: "src" },
    { sessionId: "implicit-command", toolCallId: "remote" } as never,
  ) as LightToolResult<unknown>;
  assert.equal(result.status, "ok");
  assert.deepEqual(calls, [{ kind: "command", command: "printf ready", cwd: "src" }]);
});

test("run_task never guesses conflicting or incomplete operation inputs", () => {
  for (const input of [
    { command: "printf ready", task: "test" },
    { command: "printf ready", action: "add", packages: ["zod"] },
    { kind: "dependency", command: "printf ready" },
    { kind: "unknown", command: "printf ready" },
    { kind: null, command: "printf ready" },
    { task: "test" },
    { kind: "command", commentary: "printf ready" },
    { command: "" },
    {},
  ]) assert.equal(lightRunTaskInputSchema.safeParse(input).success, false);
});

test("run_task keeps command policy for an implicit operation", async () => {
  await withWorkspace({}, async (root) => {
    const tool = lightSemanticHarnessTools(root).find(({ name }) => name === "run_task")!;
    const result = await tool.execute(
      { command: "sudo --version" },
      { sessionId: "implicit-command", toolCallId: "policy" } as never,
    ) as LightToolResult<unknown>;
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") assert.match(result.message, /sudo|privilege/iu);
  });
});

test("run_task accepts an absolute cwd inside the workspace", async () => {
  await withWorkspace({ "package.json": "{}\n" }, async (root) => {
    const workspace = lightWorkspace(root, "absolute-command-cwd");
    const command = `node -e "if(process.cwd()!==process.argv[1])process.exit(1)" ${JSON.stringify(await realpath(root))}`;
    const result = await workspace.tasks.run({
      kind: "command",
      command,
      cwd: root,
    });
    assert.equal(result.status, "ok");
    const escaped = await workspace.tasks.run({
      kind: "command",
      command: 'node -e "process.stdout.write(process.cwd())"',
      cwd: tmpdir(),
    });
    assert.equal(escaped.status, "blocked");
  });
});

test("project tasks do not inherit the harness environment", async () => {
  const previousNodeEnvironment = process.env.NODE_ENV;
  const previousToken = process.env.BLAME_API_TOKEN;
  process.env.NODE_ENV = "development";
  process.env.BLAME_API_TOKEN = "private-test-token";
  try {
    await withWorkspace(
      {
        "package.json": JSON.stringify({
          scripts: {
            build:
              'node -e "if(process.env.NODE_ENV||process.env.BLAME_API_TOKEN)process.exit(1)"',
          },
        }),
      },
      async (root) => {
        const workspace = lightWorkspace(root, "isolated-task-environment");
        assert.equal(
          (await workspace.tasks.run({ kind: "project", task: "build" }))
            .status,
          "ok",
        );
      },
    );
  } finally {
    restoreEnvironment("NODE_ENV", previousNodeEnvironment);
    restoreEnvironment("BLAME_API_TOKEN", previousToken);
  }
});

test("run_task classifies a missing declared dependency as environment", async () => {
  const manifest = JSON.stringify({
    dependencies: { "@prisma/client": "7.9.1" },
  });
  await withWorkspace({ "package.json": manifest }, async (root) => {
    const workspace = lightWorkspace(root, "dependency-diagnostic");
    const result = await workspace.tasks.run({
      kind: "command",
      command:
        'node -e "console.error(\\"Cannot find module \'@prisma/client\'\\"); process.exit(1)"',
    });
    assert.equal(result.status, "blocked");
    if (result.status === "blocked")
      assert.equal(result.category, "environment");
  });
});

test("run_task recognizes installed dependency paths as environment", async () => {
  const manifest = JSON.stringify({ devDependencies: { prisma: "7.9.1" } });
  await withWorkspace({ "package.json": manifest }, async (root) => {
    const workspace = lightWorkspace(root, "dependency-path-diagnostic");
    const result = await workspace.tasks.run({
      kind: "command",
      command:
        "node -e \"const path = process.cwd() + '/' + ['node', 'modules'].join('_') + '/prisma/build/index.js'; console.error(\\\"Cannot find module '\\\" + path + \\\"'\\\"); process.exit(1)\"",
    });
    assert.equal(result.status, "blocked");
    if (result.status === "blocked")
      assert.equal(result.category, "environment");
  });
});

test("run_task treats missing Prisma variables as environment", async () => {
  await withWorkspace({ "package.json": "{}\n" }, async (root) => {
    const workspace = lightWorkspace(root, "prisma-environment-diagnostic");
    const result = await workspace.tasks.run({
      kind: "command",
      command:
        "node -e \"console.error('PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL.'); process.exit(1)\"",
    });
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") return;
    assert.equal(result.category, "environment");
    assert.match(result.recovery ?? "", /do not add credentials/u);
    assert.match(result.recovery ?? "", /localhost URLs/u);
  });
});

test("run_task classifies infrastructure and storage failures as environment", async () => {
  await withWorkspace({ "package.json": "{}\n" }, async (root) => {
    const workspace = lightWorkspace(root, "environment-diagnostics");
    for (const diagnostic of [
      "P1001: Can't reach database server",
      "ENOSPC: no space left on device",
      "Managed preview unavailable",
    ]) {
      const result = await workspace.tasks.run({
        kind: "command",
        command: `node -e "console.error(process.argv[1]); process.exit(1)" ${JSON.stringify(diagnostic)}`,
      });
      assert.equal(result.status, "blocked");
      if (result.status !== "blocked") continue;
      assert.equal(result.category, "environment");
      assert.match(result.recovery ?? "", /reported environment problem/u);
      assert.doesNotMatch(result.recovery ?? "", /finish_task|Do not retry unchanged/u);
    }
  });
});

test("run_task denies destructive commands and unmanaged infrastructure", async () => {
  await withWorkspace({ "value.txt": "safe\n" }, async (root) => {
    const workspace = lightWorkspace(root, "command-policy");
    for (const command of [
      "rm value.txt",
      "pnpm install",
      "git add value.txt",
      "git -C . add value.txt",
      "docker run postgres:17",
      "pnpm exec prettier src --write",
    ]) {
      const result = await workspace.tasks.run({ kind: "command", command });
      assert.equal(result.status, "blocked");
      if (result.status === "blocked") assert.equal(result.category, "input");
    }
    assert.equal(await readFile(join(root, "value.txt"), "utf8"), "safe\n");
  });
});

test("run_task executes finite formatter project scripts", async () => {
  const scripts = {
    format: "prettier --write .",
    "lint:fix": "eslint . --fix",
    "prisma:format": "prisma format",
  };
  await withWorkspace(
    {
      "package.json": JSON.stringify({
        scripts: Object.fromEntries(
          Object.keys(scripts).map((name) => [name, "node --version"]),
        ),
      }),
    },
    async (root) => {
      const workspace = lightWorkspace(root, "project-command-policy");
      for (const task of Object.keys(scripts)) {
        const result = await workspace.tasks.run({ kind: "project", task });
        assert.equal(result.status, "ok", JSON.stringify(result));
      }
    },
  );
});

test("run_task applies explicit Prettier files as one journaled edit", async () => {
  await withFormatterWorkspace(
    {
      "first.ts": "export const first={value:1}\n",
      "second.ts": "export const second={value:2}\n",
    },
    async (root) => {
      const sessionId = "deterministic-formatter";
      const workspace = lightWorkspace(root, sessionId);
      const result = await workspace.tasks.run({
        kind: "command",
        command: "pnpm exec prettier --write first.ts second.ts",
      });
      assert.equal(result.status, "ok");
      assert.equal(record(data(result)).mutation, "deterministic_format");
      assert.equal(
        await readFile(join(root, "first.ts"), "utf8"),
        "export const first = { value: 1 };\n",
      );
      assert.equal(
        await readFile(join(root, "second.ts"), "utf8"),
        "export const second = { value: 2 };\n",
      );
      const completion = await new SessionJournal(
        root,
        sessionId,
      ).completionSnapshot();
      assert.deepEqual(completion.changedPaths.sort(), [
        "first.ts",
        "second.ts",
      ]);
      assert.equal(completion.validations.at(-1)?.taskKind, "lint");
      assert.equal(
        completion.validations.at(-1)?.sourceRevisionId,
        completion.sourceRevisionId,
      );
    },
  );
});

for (const prefix of ["npx --no-install prettier", "npm exec --no -- prettier"]) {
  test(prefix + " formats atomically and rolls back failed batches", async () => {
    const note = "# Note\n\nSource text\n";
    await withFormatterWorkspace(
      { "first.ts": "export const first={value:1}\n", "NOTE.md": note,
        "invalid.ts": "export const INVALID = ;\n" },
      async (root) => {
        const manifest = await readFile(join(root, "package.json"));
        const workspace = lightWorkspace(root, "npm-formatter");
        const result = await workspace.tasks.run({
          kind: "command", command: prefix + " --write first.ts NOTE.md",
        });
        assert.equal(result.status, "ok", JSON.stringify(result));
        assert.equal(data(result).mutation, "deterministic_format");
        assert.equal(await readFile(join(root, "first.ts"), "utf8"),
          "export const first = { value: 1 };\n");
        assert.equal(await readFile(join(root, "NOTE.md"), "utf8"), note);
        assert.deepEqual(await readFile(join(root, "package.json")), manifest);
        const journal = new SessionJournal(root, "npm-formatter");
        const before = await journal.completionSnapshot();
        assert.equal(record(before.validations.at(-1)).evidenceOrigin, "formatter_output");
        assert.equal(before.validations.at(-1)?.sourceRevisionId, before.sourceRevisionId);
        const failed = await workspace.tasks.run({
          kind: "command", command: prefix + " --write first.ts invalid.ts",
        });
        assert.equal(failed.status, "blocked");
        const after = await journal.completionSnapshot();
        assert.equal(after.sourceRevisionId, before.sourceRevisionId);
        assert.deepEqual(after.validations, before.validations);
        assert.equal(await readFile(join(root, "invalid.ts"), "utf8"), "export const INVALID = ;\n");
        assert.equal(await readFile(join(root, "first.ts"), "utf8"),
          "export const first = { value: 1 };\n");
        const combined = await workspace.tasks.run({
          kind: "command", command: prefix + " --write first.ts && echo changed",
        });
        assert.equal(combined.status, "blocked");
        assert.equal((await journal.completionSnapshot()).sourceRevisionId, before.sourceRevisionId);
      },
    );
  });
}

test("run_task never writes package-manager progress into formatted Markdown", async () => {
  const original = "# Note\n\nProgress: source text\n";
  await withFormatterWorkspace({ "NOTE.md": original }, async (root) => {
    const workspace = lightWorkspace(root, "formatter-source-channel");
    const result = await workspace.tasks.run({
      kind: "command",
      command: "pnpm exec prettier --write NOTE.md",
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(await readFile(join(root, "NOTE.md"), "utf8"), original);
    assert.equal(record(data(result)).changed, false);
    assert.equal(record(data(result)).guidance, undefined);
    const completion = await new SessionJournal(
      root,
      "formatter-source-channel",
    ).completionSnapshot();
    assert.deepEqual(completion.changedPaths, []);
  });
});

test("formatter evidence is derived and retains distinct unchanged scopes", async () => {
  const sources = {
    "first.ts": "export const first = { value: 1 };\n",
    "second.ts": "export const second = { value: 2 };\n",
  };
  await withFormatterWorkspace(sources, async (root) => {
    const workspace = lightWorkspace(root, "formatter-origin");
    for (const [path, original] of Object.entries(sources)) {
      const result = await workspace.tasks.run({
        kind: "command", command: "pnpm exec prettier --write " + path,
      });
      assert.equal(result.status, "ok");
      assert.equal(data(result).changed, false);
      assert.equal(await readFile(join(root, path), "utf8"), original);
    }
    const completion = await new SessionJournal(root, "formatter-origin").completionSnapshot();
    assert.equal(completion.validations.length, 2);
    assert.deepEqual(completion.validations.flatMap(check => check.paths).sort(), Object.keys(sources).sort());
    assert.deepEqual(completion.changedPaths, []);
    for (const check of completion.validations) {
      assert.equal(record(check).evidenceOrigin, "formatter_output");
      assert.equal(check.command, undefined);
      assert.equal(check.check, undefined);
      assert.equal(check.status, "passed");
      assert.equal(check.sourceRevisionId, completion.sourceRevisionId);
    }
  });
});

for (const variant of ["markdown", "typescript"]) {
  test("formatter evidence excludes post-commit external " + variant + " source", async () => {
    const path = variant === "markdown" ? "NOTE.md" : "value.ts";
    const before = variant === "markdown"
      ? "# Note\n\nA paragraph"
      : "export const value={value:1}\n";
    const external = variant === "markdown"
      ? "# Changed externally\n\nA paragraph    \n"
      : "export const value = ;\n";
    await withFormatterWorkspace({ [path]: before }, async (root) => {
      const workspace = lightWorkspace(root, "formatter-freshness");
      const replaceFiles = workspace.edits.replaceFiles.bind(workspace.edits);
      let committedRevision: unknown;
      workspace.edits.replaceFiles = async (...args) => {
        const result = await replaceFiles(...args);
        assert.equal(result.status, "ok");
        assert.equal(data(result).changed, true, "The fixture must format a real source change.");
        committedRevision = record(data(result)).sourceRevisionId;
        await writeFile(join(root, path), external);
        return result;
      };
      const result = await workspace.tasks.run({
        kind: "command",
        command: "pnpm exec prettier --write " + path,
      });
      assert.equal(result.status, "ok");
      assert.equal(await readFile(join(root, path), "utf8"), external);
      const snapshot = await new SessionJournal(root, "formatter-freshness").completionSnapshot();
      assert.notEqual(snapshot.sourceRevisionId, committedRevision);
      assert.equal(snapshot.validations.some(check => check.status === "passed"), false);
      assert.equal(record(record(data(result)).validation).status, "stale");
      assert.equal("receipt" in result, true);
    });
  });
}

test("run_task leaves every file unchanged when Prettier fails", async () => {
  const original = "export const first={value:1}\n";
  const invalid = "export const INVALID = ;\n";
  await withFormatterWorkspace(
    { "first.ts": original, "invalid.ts": invalid },
    async (root) => {
      const workspace = lightWorkspace(root, "formatter-rollback");
      const result = await workspace.tasks.run({
        kind: "command",
        command: "pnpm exec prettier first.ts invalid.ts --write",
      });
      assert.equal(result.status, "blocked");
      if (result.status === "blocked") assert.equal(result.category, "code");
      assert.equal(await readFile(join(root, "first.ts"), "utf8"), original);
      assert.equal(await readFile(join(root, "invalid.ts"), "utf8"), invalid);
      assert.deepEqual(
        (await new SessionJournal(root, "formatter-rollback").completionSnapshot())
          .changedPaths,
        [],
      );
    },
  );
});

for (const output of ["", " \n\t"]) {
  test("silent formatter failure reports its exit code " + JSON.stringify(output), async () => {
    const original = "export const value=1\n";
    const executable = [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(" + JSON.stringify(output) + ");",
      "  process.stderr.write(" + JSON.stringify(output) + ");",
      "  process.exit(7);",
      "});",
    ].join("\n");
    await withWorkspace({
      "package.json": JSON.stringify({ devDependencies: { prettier: "3.0.0" } }),
      "node_modules/.bin/prettier": executable,
      "value.ts": original,
    }, async (root) => {
      await chmod(join(root, "node_modules/.bin/prettier"), 0o755);
      const workspace = lightWorkspace(root, "silent-formatter");
      const journal = new SessionJournal(root, "silent-formatter");
      const before = await journal.completionSnapshot();
      const previousPath = process.env.PATH;
      process.env.PATH = join(root, "node_modules/.bin") + delimiter + previousPath;
      let result;
      try {
        result = await workspace.tasks.run({
          kind: "command",
          command: "prettier --write value.ts",
        });
      } finally {
        restoreEnvironment("PATH", previousPath);
      }
      assert.equal(result.status, "blocked");
      if (result.status !== "blocked") return;
      assert.equal(result.category, "code");
      assert.equal(result.message, "Formatter exited with code 7.");
      assert.equal(await readFile(join(root, "value.ts"), "utf8"), original);
      const after = await journal.completionSnapshot();
      assert.equal(after.sourceRevisionId, before.sourceRevisionId);
      assert.deepEqual(after.changedPaths, []);
      assert.deepEqual(after.validations, before.validations);
    });
  });
}

test("run_task explains how to separate a combined Prettier mutation", async () => {
  await withWorkspace({ "value.ts": "const value=1\n" }, async (root) => {
    const workspace = lightWorkspace(root, "formatter-recovery");
    const result = await workspace.tasks.run({
      kind: "command",
      command: "pnpm exec prettier --write value.ts && pnpm exec prisma format",
    });
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") return;
    assert.equal(result.category, "input");
    assert.match(result.message, /Submit .*prettier --write.* alone/u);
    assert.equal(
      await readFile(join(root, "value.ts"), "utf8"),
      "const value=1\n",
    );
  });
});

test("code navigation refuses runtime-managed dependency internals", async () => {
  await withWorkspace(
    {
      "node_modules/example/index.js": "export const internal = true\n",
      "package.json": "{}\n",
    },
    async (root) => {
      const workspace = lightWorkspace(root, "dependency-navigation");
      const result = await workspace.readCode(
        { target: "node_modules/example/index.js" },
        { agentId: "lead" },
      );
      assert.equal(result.status, "blocked");
      if (result.status === "blocked") assert.equal(result.category, "input");
    },
  );
});

test("edit payloads accept full components up to a mechanical limit", () => {
  const accepted = lightEditCodeInputSchema.safeParse({
    operations: [
      {
        kind: "patch",
        path: "large.css",
        patch: "x".repeat(10_001),
      },
    ],
  });
  assert.equal(accepted.success, true);
  const rejected = lightEditCodeInputSchema.safeParse({
    operations: [
      {
        kind: "patch",
        path: "large.css",
        patch: "x".repeat(2_097_153),
      },
    ],
  });
  assert.equal(rejected.success, false);
});

test("run_task executes explicit inspections and rejects service scripts", async () => {
  await withWorkspace(
    {
      "package.json": JSON.stringify({
        scripts: {
          dev: "next dev",
          preview: "vite preview",
          test: 'node -e "process.exit(0)"',
        },
      }),
    },
    async (root) => {
      const workspace = lightWorkspace(root, "task-reuse");
      const first = data(
        await workspace.tasks.run({ kind: "command", command: "pwd" }),
      );
      const second = data(
        await workspace.tasks.run({ kind: "command", command: "pwd" }),
      );
      assert.equal(first.cached, undefined);
      assert.equal(second.cached, undefined);
      assert.equal(first.validation, undefined);
      assert.equal(second.validation, undefined);
      const firstValidation = data(
        await workspace.tasks.run({ kind: "project", task: "test" }),
      );
      const validation = data(
        await workspace.tasks.run({ kind: "project", task: "test" }),
      );
      assert.equal(validation.cached, undefined);
      assert.equal(record(firstValidation.validation).status, "unknown");
      assert.equal(record(validation.validation).status, "unknown");
      assert.equal(
        record(firstValidation.validation).sourceRevisionId,
        record(validation.validation).sourceRevisionId,
      );
      const service = await workspace.tasks.run({
        kind: "project",
        task: "dev",
      });
      assert.equal(service.status, "blocked");
      if (service.status !== "blocked") return;
      assert.equal(service.category, "environment");
      assert.match(service.recovery ?? "", /Do not start a replacement/u);
      const preview = await workspace.tasks.run({
        kind: "project",
        task: "preview",
      });
      assert.equal(preview.status, "blocked");
    },
  );
});

test("run_task prefers an exact build script over prebuild", async () => {
  await withWorkspace(
    {
      "apps/web/package.json": JSON.stringify({
        scripts: {
          build: 'node -e "process.exit(0)"',
          prebuild: 'node -e "process.exit(0)"',
        },
      }),
    },
    async (root) => {
      const workspace = lightWorkspace(root, "exact-build-task");
      const result = await workspace.tasks.run({
        kind: "project",
        packagePath: "apps/web",
        task: "build",
      });
      assert.equal(result.status, "ok");
    },
  );
});

test("project selectors accept the root manifest without selecting a child", async () => {
  await withWorkspace({
    "package.json": JSON.stringify({ scripts: { build: 'node -e "process.stdout.write(process.cwd())"' } }),
    "apps/web/package.json": JSON.stringify({ name: "web", scripts: { build: 'node -e "process.exit(9)"' } }),
  }, async (root) => {
    const workspace = lightWorkspace(root, "root-manifest-selector");
    for (const packagePath of [".", "./", "package.json", "./package.json"]) {
      const result = await workspace.tasks.run({ kind: "project", task: "build", packagePath });
      assert.equal(result.status, "ok", packagePath);
      assert.equal(data(result).exitCode, 0);
      assert.ok(String(data(result).output).includes(root));
      assert.equal(record(data(result).validation).taskId, "build");
    }
    for (const packagePath of ["apps/web", "apps/web/package.json"]) {
      const result = await workspace.tasks.run({ kind: "project", task: "build", packagePath });
      assert.equal(result.status, "blocked");
      if (result.status === "blocked") assert.match(result.message, /code 9/u);
    }
    for (const packagePath of ["foo-package.json", "../package.json"])
      assert.equal((await workspace.tasks.run({ kind: "project", task: "build", packagePath })).status, "blocked");
    const { validations } = await new SessionJournal(root, "root-manifest-selector").completionSnapshot();
    assert.ok(validations.some(value => value.taskId === "web:build" && value.status === "failed"));
  });
});

test("run_task prefers an exact task id over nested scripts with the same name", async () => {
  await withWorkspace(
    {
      "package.json": JSON.stringify({
        scripts: { build: 'node -e "process.exit(0)"' },
      }),
      "apps/web/package.json": JSON.stringify({
        name: "web",
        scripts: { build: 'node -e "process.exit(1)"' },
      }),
    },
    async (root) => {
      const workspace = lightWorkspace(root, "exact-root-build-task");
      const result = await workspace.tasks.run({
        kind: "project",
        task: "build",
      });
      assert.equal(result.status, "ok");
    },
  );
});

test("run_task executes explicit inspections across isolated Light bridges", async () => {
  await withWorkspace({ "package.json": "{}\n" }, async (root) => {
    const request = {
      input: { kind: "command" as const, command: "pwd" },
      taskContract: contract("remote-task-reuse"),
      tool: "run_task" as const,
      workspaceRoot: root,
    };
    const first = data(await executeLightWorkspaceRequest(request));
    const second = data(await executeLightWorkspaceRequest(request));
    assert.equal(first.cached, undefined);
    assert.equal(second.cached, undefined);
  });
});

test("run_task executes an explicitly repeated failed command", async () => {
  await withWorkspace({ "package.json": "{}\n" }, async (root) => {
    const workspace = lightWorkspace(root, "failed-task-reuse");
    const command = "node -e \"console.error('failure'); process.exit(3)\"";
    const first = await workspace.tasks.run({ kind: "command", command });
    const second = await workspace.tasks.run({ kind: "command", command });
    assert.equal(first.status, "blocked");
    assert.equal(second.status, "blocked");
    if (second.status !== "blocked") return;
    assert.match(second.message, /Command exited with code 3/u);
  });
});

test("run_task permits environment validation after external recovery", async () => {
  const manifest = JSON.stringify({
    scripts: {
      test: "node -e \"console.error('P1001: cannot connect'); process.exit(1)\"",
    },
  });
  await withWorkspace({ "package.json": manifest }, async (root) => {
    const workspace = lightWorkspace(root, "environment-task-retry");
    await workspace.tasks.run({ kind: "project", task: "test" });
    const retried = await workspace.tasks.run({
      kind: "project",
      task: "test",
    });
    assert.equal(retried.status, "ok");
    assert.equal(record(data(retried).check).outcome, "failed");
    assert.match(String(data(retried).output), /P1001/u);
  });
});

test("run_task bounds successful command output", async () => {
  await withWorkspace({ "package.json": "{}\n" }, async (root) => {
    const workspace = lightWorkspace(root, "bounded-success");
    const result = data(
      await workspace.tasks.run({
        kind: "command",
        command: `node -e "console.log('x'.repeat(10000))"`,
      }),
    );
    assert.ok(String(result.output).length <= 4_000);
    assert.match(String(result.output), /diagnostic truncated/u);
  });
});

test("large application files route through outline and symbol reads", async () => {
  const filler = Array.from(
    { length: 1_500 },
    (_, index) => `export const value${index} = ${index}`,
  ).join("\n");
  const source = `export function target() { return 1 }\n${filler}\n`;
  await withWorkspace({ "large.ts": source }, async (root) => {
    const workspace = lightWorkspace(root, "large");
    const outline = data(
      await workspace.readCode({ target: "large.ts" }, { agentId: "lead" }),
    );
    assert.equal(outline.view, "outline");
    const item = record(
      array(outline.items).find(
        (value) => record(value).qualified_name === "target",
      ),
    );
    const symbol = data(
      await workspace.readCode(
        { target: String(item.alias), view: "symbol" },
        { agentId: "lead" },
      ),
    );
    assert.equal(symbol.qualifiedName, "target");
    assert.match(String(symbol.body), /return 1/u);
  });
});

test("medium supported files route through an outline", async () => {
  const source = Array.from(
    { length: 400 },
    (_, index) => `export const mediumValue${index} = ${index}`,
  ).join("\n");
  await withWorkspace({ "medium.ts": `${source}\n` }, async (root) => {
    const workspace = lightWorkspace(root, "medium-outline");
    const result = data(
      await workspace.readCode({ target: "medium.ts" }, { agentId: "lead" }),
    );
    assert.equal(result.view, "outline");
  });
});

test("raw formats fall back in the same read call", async () => {
  await withWorkspace(
    {
      "schema.prisma": "model User {\n  id Int @id\n}\n",
      "settings.json": '{"value":true}\n',
      "settings.rare": "value=true\n",
    },
    async (root) => {
      const workspace = lightWorkspace(root, "raw");
      for (const path of ["schema.prisma", "settings.json", "settings.rare"]) {
        const result = data(
          await workspace.readCode(
            { target: path, view: "symbol" },
            { agentId: "lead" },
          ),
        );
        assert.equal(result.view, "raw");
        assert.equal(result.fallbackReason, "symbol_target_missing");
      }
    },
  );
});

test("directory reads return one bounded level instead of a tool error", async () => {
  await withWorkspace(
    {
      "apps/web/src/app/page.tsx": "export default function Page() {}\n",
      "apps/web/src/components/card.tsx": "export function Card() {}\n",
      "apps/web/src/index.ts": "export const value = 1\n",
    },
    async (root) => {
      const workspace = lightWorkspace(root, "directory-read");
      const result = data(
        await workspace.readCode(
          { target: "apps/web/src", view: "outline" },
          { agentId: "lead" },
        ),
      );
      assert.equal(result.view, "directory");
      assert.deepEqual(result.entries, [
        { kind: "directory", target: "apps/web/src/app" },
        { kind: "directory", target: "apps/web/src/components" },
        { kind: "file", target: "apps/web/src/index.ts" },
      ]);
      const repeated = data(
        await workspace.readCode(
          { target: "apps/web/src", view: "outline" },
          { agentId: "lead" },
        ),
      );
      assert.equal(repeated.status, "already_in_context");
    },
  );
});

test("CSS supports structural outline and rule body editing", async () => {
  await withWorkspace(
    { "styles.css": ".card { color: red; }\n" },
    async (root) => {
      const workspace = lightWorkspace(root, "css-structure");
      const outline = data(
        await workspace.readCode(
          { target: "styles.css", view: "outline" },
          { agentId: "lead" },
        ),
      );
      const rule = record(array(outline.items)[0]);
      await workspace.readCode({ target: String(rule.alias) }, {});
      const result = await workspace.editCode({
        operations: [
          {
            action: "replace_body",
            content: "color: blue;",
            kind: "symbol",
            target: String(rule.alias),
          },
        ],
      });
      assert.equal(result.status, "ok");
      assert.equal(
        await readFile(join(root, "styles.css"), "utf8"),
        ".card { color: blue; }\n",
      );
    },
  );
});

test("nested CSS outline targets identify their containing target", async () => {
  const source = [
    "@media (max-width: 600px) {",
    "  .projects { color: blue; }",
    "  .card { display: none; }",
    "}",
    "",
  ].join("\n");
  await withWorkspace({ "nested.css": source }, async (root) => {
    const workspace = lightWorkspace(root, "nested-css-targets");
    const outline = data(
      await workspace.readCode(
        { target: "nested.css", view: "outline" },
        { agentId: "lead" },
      ),
    );
    const items = array(outline.items).map(record);
    const media = items.find((item) => item.kind === "css_media");
    const project = items.find(
      (item) => item.qualified_name === "@media(max-width: 600px)::.projects",
    );
    assert.equal(project?.containedBy, media?.alias);
  });
});

test("outline ranges exclude symbols outside the requested lines", async () => {
  const source = Array.from(
    { length: 700 },
    (_, index) => `.rule-${index + 1} { color: red; }`,
  ).join("\n");
  await withWorkspace({ "large.css": `${source}\n` }, async (root) => {
    const workspace = lightWorkspace(root, "ranged-outline");
    const result = data(
      await workspace.readCode(
        {
          range: { endLine: 650, startLine: 330 },
          target: "large.css",
          view: "outline",
        },
        { agentId: "lead" },
      ),
    );
    const items = array(result.items).map(record);
    assert.equal(items.length, 32);
    assert.ok(
      items.every((item) => {
        const [start, end] = array(item.line_range).map(Number);
        return start >= 330 && end <= 650;
      }),
    );
    assert.ok(
      array(result.editTargets).every((target) => {
        const match = String(record(target).qualifiedName).match(/(\d+)/u);
        const line = Number(match?.[1]);
        return line >= 330 && line <= 650;
      }),
    );
  });
});

test("one batch combines an import patch and a symbol body replacement", async () => {
  const source =
    "import { value } from './value.js'\n\nexport function greet() {\n  return value\n}\n";
  await withWorkspace({ "src/app.ts": source }, async (root) => {
    const workspace = lightWorkspace(root, "hybrid");
    const alias = await symbolAlias(workspace, "greet");
    const result = await workspace.edits.edit(
      {
        operations: [
          {
            kind: "patch",
            path: "src/app.ts",
            patch: applyPatch("src/app.ts", [
              "-import { value } from './value.js'",
              "+import { value as helper } from './value.js'",
            ]),
          },
          {
            kind: "symbol",
            target: alias,
            action: "replace_body",
            content: "{\n  return helper()\n}",
          },
        ],
      },
      { sessionId: "hybrid", toolCallId: "edit-hybrid" },
    );
    assert.equal(result.status, "ok");
    assert.equal(record(data(result).parse).status, "passed");
    assert.equal(
      await readFile(join(root, "src/app.ts"), "utf8"),
      "import { value as helper } from './value.js'\n\nexport function greet() {\n  return helper()\n}\n",
    );
  });
});

test("one batch combines an import patch and a whole exported replacement", async () => {
  const source =
    'import Image from "next/image";\n\nexport default function Home() {\n  return <main />;\n}\n';
  await withWorkspace({ "src/app.tsx": source }, async (root) => {
    const workspace = lightWorkspace(root, "hybrid-whole-symbol");
    await workspace.readCode({ target: "src/app.tsx#Home" }, {});
    const result = await workspace.editCode({
      operations: [
        {
          kind: "symbol",
          target: "src/app.tsx#Home",
          action: "replace",
          content:
            "export default function Home() {\n  return <main><section /></main>;\n}",
        },
        {
          kind: "patch",
          path: "src/app.tsx",
          patch: applyPatch("src/app.tsx", [
            ' import Image from "next/image";',
            '+import { Section } from "./section";',
          ]),
        },
      ],
    });
    assert.equal(result.status, "ok");
    assert.equal(
      await readFile(join(root, "src/app.tsx"), "utf8"),
      'import Image from "next/image";\nimport { Section } from "./section";\n\nexport default function Home() {\n  return <main><section /></main>;\n}\n',
    );
  });
});

test("one batch inserts before and replaces the adjacent symbol", async () => {
  const source = [
    "export type Invoice = { id: string };",
    "",
    "export type InvoiceSummary = { total: number };",
    "",
  ].join("\n");
  await withWorkspace({ "src/invoice.ts": source }, async (root) => {
    const workspace = lightWorkspace(root, "hybrid-adjacent");
    await workspace.readCode({ target: "src/invoice.ts#InvoiceSummary" }, {});
    const result = await workspace.editCode({
      operations: [
        {
          kind: "symbol",
          target: "src/invoice.ts#InvoiceSummary",
          action: "replace",
          content:
            "export type InvoiceSummary = { discountTier: DiscountTier; total: number };",
        },
        {
          kind: "patch",
          path: "src/invoice.ts",
          patch: applyPatch("src/invoice.ts", [
            " export type Invoice = { id: string };",
            '+export type DiscountTier = "none" | "standard" | "premium";',
          ]),
        },
      ],
    });
    assert.equal(result.status, "ok");
    assert.equal(
      await readFile(join(root, "src/invoice.ts"), "utf8"),
      [
        "export type Invoice = { id: string };",
        'export type DiscountTier = "none" | "standard" | "premium";',
        "",
        "export type InvoiceSummary = { discountTier: DiscountTier; total: number };",
        "",
      ].join("\n"),
    );
  });
});

test("line-based patch planning preserves UTF-8 character boundaries", async () => {
  const source = 'export const label = "😀";\n';
  await withWorkspace({ "src/label.ts": source }, async (root) => {
    const workspace = lightWorkspace(root, "patch-utf8");
    const result = await workspace.editCode({
      operations: [
        {
          kind: "patch",
          path: "src/label.ts",
          patch: applyPatch("src/label.ts", [
            '-export const label = "😀";',
            '+export const label = "😃";',
          ]),
        },
      ],
    });
    assert.equal(result.status, "ok");
    assert.equal(
      await readFile(join(root, "src/label.ts"), "utf8"),
      'export const label = "😃";\n',
    );
  });
});

test("HTML supports outline and structural body replacement", async () => {
  await withWorkspace(
    { "index.html": '<main id="app"><p>Hello</p></main>\n' },
    async (root) => {
      const workspace = lightWorkspace(root, "html");
      const outline = data(
        await workspace.readCode(
          { target: "index.html", view: "outline" },
          { agentId: "lead" },
        ),
      );
      assert.equal(outline.view, "outline");
      const main = record(
        array(outline.items).find(
          (value) => record(value).qualified_name === "main#app",
        ),
      );
      await workspace.readCode({ target: String(main.alias) }, {});
      const result = await workspace.edits.edit(
        {
          operations: [
            {
              kind: "symbol",
              target: String(main.alias),
              action: "replace_body",
              content: "<p>World</p>",
            },
          ],
        },
        { sessionId: "html", toolCallId: "edit-html" },
      );
      assert.equal(result.status, "ok");
      assert.equal(
        await readFile(join(root, "index.html"), "utf8"),
        '<main id="app"><p>World</p></main>\n',
      );
    },
  );
});

for (const extension of ["vue", "svelte"])
  test(`${extension} supports structural outline and element editing`, async () => {
    const path = `Component.${extension}`;
    const source = '<main id="app"><p>Hello</p></main>\n';
    await withWorkspace({ [path]: source }, async (root) => {
      const workspace = lightWorkspace(root, `structure-${extension}`);
      const outline = data(
        await workspace.readCode(
          { target: path, view: "outline" },
          { agentId: "lead" },
        ),
      );
      const main = record(
        array(outline.items).find(
          (value) => record(value).qualified_name === "main#app",
        ),
      );
      await workspace.readCode({ target: String(main.alias) }, {});
      const result = await workspace.editCode({
        operations: [
          {
            action: "replace_body",
            content: "<p>World</p>",
            kind: "symbol",
            target: String(main.alias),
          },
        ],
      });
      assert.equal(result.status, "ok");
      assert.match(await readFile(join(root, path), "utf8"), /World/u);
    });
  });

test("symbol insertion and Prisma patching share one atomic batch", async () => {
  await withWorkspace(
    {
      "service.ts": "export function first() { return 1 }\n",
      "schema.prisma": "model User {\n  id Int @id\n}\n",
    },
    async (root) => {
      const workspace = lightWorkspace(root, "mixed-insert");
      const alias = await symbolAlias(workspace, "first");
      const result = await workspace.editCode({
        operations: [
          {
            action: "insert_after",
            content: "\nexport function second() { return 2 }",
            kind: "symbol",
            target: alias,
          },
          {
            kind: "patch",
            path: "schema.prisma",
            patch: applyPatch("schema.prisma", [
              " model User {",
              "   id Int @id",
              "+  name String",
              " }",
            ]),
          },
        ],
      });
      assert.equal(result.status, "ok");
      assert.equal(record(data(result).parse).status, "unsupported");
      assert.match(await readFile(join(root, "service.ts"), "utf8"), /second/u);
      assert.match(
        await readFile(join(root, "schema.prisma"), "utf8"),
        /name String/u,
      );
    },
  );
});

test("symbol replace, insert before, insert after, and delete share one snapshot", async () => {
  const source = [
    "export function first() { return 1 }",
    "export function middle() { return 2 }",
    "export function last() { return 3 }",
    "",
  ].join("\n");
  await withWorkspace({ "actions.ts": source }, async (root) => {
    const workspace = lightWorkspace(root, "symbol-actions");
    const first = await symbolAlias(workspace, "first");
    const middle = await symbolAlias(workspace, "middle");
    const last = await symbolAlias(workspace, "last");
    const result = await workspace.editCode({
      operations: [
        {
          action: "insert_before",
          content: "export const before = 0\n",
          kind: "symbol",
          target: first,
        },
        {
          action: "replace",
          content: "export function middle() { return 20 }",
          kind: "symbol",
          target: middle,
        },
        {
          action: "insert_after",
          content: "\nexport const after = 4",
          kind: "symbol",
          target: last,
        },
        { action: "delete", kind: "symbol", target: last },
      ],
    });
    assert.equal(result.status, "ok");
    const content = await readFile(join(root, "actions.ts"), "utf8");
    assert.match(content, /before = 0/u);
    assert.match(content, /return 20/u);
    assert.match(content, /after = 4/u);
    assert.doesNotMatch(content, /return 3/u);
  });
});

test("preexisting parse errors may not increase", async () => {
  const source = "export function broken( {\nexport const value = 1\n";
  await withWorkspace({ "broken.ts": source }, async (root) => {
    const workspace = lightWorkspace(root, "degraded-parse");
    const result = await workspace.editCode({
      operations: [
        {
          kind: "patch",
          path: "broken.ts",
          patch: applyPatch("broken.ts", [
            "-export const value = 1",
            "+export const value = 2",
          ]),
        },
      ],
    });
    assert.equal(result.status, "ok");
    assert.equal(
      record(data(result).parse).status,
      "degraded_preexisting_errors",
    );
  });
});

test("ambiguous patch context is refused without fuzzy recovery", async () => {
  const source = "same\nsame\n";
  await withWorkspace({ "duplicate.txt": source }, async (root) => {
    const workspace = lightWorkspace(root, "ambiguous-patch");
    const result = await workspace.editCode({
      operations: [
        {
          kind: "patch",
          path: "duplicate.txt",
          patch: applyPatch("duplicate.txt", ["-same", "+changed"]),
        },
      ],
    });
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") {
      assert.match(result.recovery ?? "", /Do not resend the same patch/u);
      assert.match(result.message, /duplicate\.txt at lines 1, 2/u);
    }
    assert.equal(await readFile(join(root, "duplicate.txt"), "utf8"), source);
  });
});

test("mismatched patches return bounded current context", async () => {
  const source = [
    "export type Project = { title: string };",
    "",
    "export function project(title: string): Project {",
    "  return { title };",
    "}",
    "",
  ].join("\n");
  await withWorkspace({ "project.ts": source }, async (root) => {
    const workspace = lightWorkspace(root, "mismatched-context");
    const result = await workspace.editCode({
      operations: [
        {
          kind: "patch",
          path: "project.ts",
          patch: applyPatch("project.ts", [
            "-  return { title: title.trim() };",
            "+  const normalizedTitle = title.trim();",
            "+  return { title: normalizedTitle };",
          ]),
        },
      ],
    });
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") {
      assert.match(result.message, /Closest current lines 2-6/u);
      assert.match(result.message, /return \{ title \};/u);
    }
    assert.equal(await readFile(join(root, "project.ts"), "utf8"), source);
  });
});

test("scoped patch refusals retain recovery without widening the target", async () => {
  for (const ambiguous of [false, true]) {
    const body = ambiguous
      ? "{\n  void 1;\n  void 1;\n  return 1;\n}"
      : "{ return 1; }";
    const source = `export function amount() ${body}\nexport function neighbor() { return 9; }\n`;
    await withWorkspace({ "functions.ts": source }, async (root) => {
      const workspace = lightWorkspace(root, "scoped-recovery");
      const alias = await symbolAlias(workspace, "amount");
      const journal = new SessionJournal(root, "scoped-recovery");
      const before = await journal.completionSnapshot();
      const result = await workspace.editCode({ operations: [{
        kind: "patch",
        target: alias,
        patch: applyPatch("functions.ts", ambiguous
          ? ["-  void 1;", "+  void 2;"]
          : ["-export function amount() { return 1; }", "+export function amount() { return 2; }"]),
      }] });
      assert.equal(result.status, "blocked");
      if (result.status === "blocked")
        assert.match(result.recovery ?? "", ambiguous
          ? /Do not resend the same patch/u : /current text/u);
      assert.equal(await readFile(join(root, "functions.ts"), "utf8"), source);
      const after = await journal.completionSnapshot();
      assert.equal(after.sourceRevisionId, before.sourceRevisionId);
      assert.deepEqual(after.changedPaths, []);
      assert.deepEqual(after.validations, []);
      const outside = await workspace.editCode({ operations: [{
        kind: "patch",
        target: alias,
        patch: applyPatch("functions.ts", [
          "-function neighbor() { return 9; }", "+function neighbor() { return 99; }",
        ]),
      }] });
      assert.equal(outside.status, "blocked");
      assert.equal(await readFile(join(root, "functions.ts"), "utf8"), source);
      const repaired = await workspace.editCode({ operations: [{
        kind: "symbol", target: alias, action: "replace_body", content: "{ return 2; }",
      }] });
      assert.equal(repaired.status, "ok");
      assert.equal(data(repaired).changed, true);
      assert.equal(await readFile(join(root, "functions.ts"), "utf8"),
        "export function amount() { return 2; }\nexport function neighbor() { return 9; }\n");
    });
  }
});

test("aliases survive workspace reload and ambiguous relocation never writes", async () => {
  const source = "export function target() { return 1 }\n";
  await withWorkspace({ "target.ts": source }, async (root) => {
    const first = lightWorkspace(root, "persisted-alias");
    const alias = await symbolAlias(first, "target");
    const second = lightWorkspace(root, "persisted-alias");
    await second.readCode({ target: "@changes" }, { agentId: "lead" });
    await writeFile(join(root, "target.ts"), `${source}${source}`);
    const result = await second.editCode({
      operations: [
        {
          action: "replace_body",
          content: "{ return 2 }",
          kind: "symbol",
          target: alias,
        },
      ],
    });
    assert.equal(result.status, "blocked");
    assert.equal(
      await readFile(join(root, "target.ts"), "utf8"),
      `${source}${source}`,
    );
  });
});

test("source remains available on repeated reads before and after Cline compaction", async () => {
  await withWorkspace(
    { "value.ts": "export const value = 1\n" },
    async (root) => {
      const workspace = lightWorkspace(root, "compaction-coverage");
      const initial = { agentId: "lead" };
      await workspace.readCode({ target: "value.ts" }, initial);
      assert.equal(
        data(await workspace.readCode({ target: "value.ts" }, initial)).content,
        "export const value = 1\n",
      );
      const compacted = {
        agentId: "lead",
        snapshot: {
          messages: [
            { id: "summary-1", metadata: { kind: "compaction_summary" } },
          ],
        },
      } as never;
      assert.match(
        String(
          data(await workspace.readCode({ target: "value.ts" }, compacted))
            .content,
        ),
        /value = 1/u,
      );
      assert.equal(
        data(await workspace.readCode({ target: "value.ts" }, compacted))
          .content,
        "export const value = 1\n",
      );
    },
  );
});

test("finish_task reads the session journal and emits only a natural summary", async () => {
  await withWorkspace(
    { "value.ts": "export const value = 1\n" },
    async (root) => {
      const sessionId = "light-finish";
      const taskContract = contract(sessionId);
      const workspace = lightWorkspace(root, sessionId);
      await workspace.editCode({
        operations: [
          {
            kind: "patch",
            path: "value.ts",
            patch: applyPatch("value.ts", [
              "-export const value = 1",
              "+export const value = 2",
            ]),
          },
        ],
      });
      let notified = false;
      const tool = createFinishTaskTool({
        conversationId: sessionId,
        onComplete: () => {
          notified = true;
        },
        taskContract,
        workspaceRoot: root,
      });
      const result = await tool.execute(
        { summary: "Updated the value." },
        {
          agentId: "lead",
          iteration: 1,
          runId: "run",
          sessionId,
          toolCallId: "finish",
        },
      );
      assert.equal(result, "Updated the value.");
      assert.equal(notified, true);
      const journal = new SessionJournal(root, sessionId);
      await journal.hydrate();
      assert.equal(journal.currentChanges().length, 1);
    },
  );
});

test("finish_task reruns the selected build after the final edit", async () => {
  await withWorkspace(
    {
      "package.json": JSON.stringify({
        scripts: { build: "node --version", lint: "node --version" },
      }),
      "value.ts": "export const value = 1\n",
    },
    async (root) => {
      const sessionId = "fresh-final-build";
      const workspace = lightWorkspace(root, sessionId);
      await workspace.editCode({
        operations: [
          {
            kind: "patch",
            path: "value.ts",
            patch: applyPatch("value.ts", [
              "-export const value = 1",
              "+export const value = 2",
            ]),
          },
        ],
      });
      assert.equal(
        (await workspace.tasks.run({ kind: "project", task: "build" })).status,
        "ok",
      );
      await workspace.editCode({
        operations: [
          {
            kind: "patch",
            path: "value.ts",
            patch: applyPatch("value.ts", [
              "-export const value = 2",
              "+export const value = 3",
            ]),
          },
        ],
      });
      await workspace.tasks.run({ kind: "project", task: "lint" });
      const activities: string[] = [];
      let verified = false;
      let memoryFiles: Array<{ hash: string; path: string }> | undefined;
      const tool = createFinishTaskTool({
        conversationId: sessionId,
        onComplete: (notification) => {
          verified = notification.verified;
          memoryFiles = notification.memory?.files;
        },
        onValidationActivity: ({ input, phase }) => {
          if (input.kind === "project")
            activities.push(`${phase}:${input.task}`);
        },
        taskContract: contract(sessionId),
        workspaceRoot: root,
      });
      await tool.execute({ summary: "Updated the final value." }, {
        sessionId,
        toolCallId: "fresh-finish",
      } as never);
      assert.deepEqual(activities, ["started:build", "finished:build"]);
      const snapshot = await new SessionJournal(
        root,
        sessionId,
      ).completionSnapshot();
      assert.equal(verified, true, JSON.stringify(snapshot));
      assert.deepEqual(
        memoryFiles?.map(({ path }) => path),
        ["value.ts"],
      );
    },
  );
});

test("finish_task reuses a current unavailable build result", async () => {
  await withWorkspace(
    {
      "package.json": JSON.stringify({
        scripts: {
          build:
            "node -e \"console.error('Missing environment variable: DATABASE_URL');process.exit(1)\"",
        },
      }),
      "value.ts": "export const value = 1\n",
    },
    async (root) => {
      const sessionId = "unavailable-final-build";
      const workspace = lightWorkspace(root, sessionId);
      await workspace.editCode({
        operations: [
          {
            kind: "patch",
            path: "value.ts",
            patch: applyPatch("value.ts", [
              "-export const value = 1",
              "+export const value = 2",
            ]),
          },
        ],
      });
      const validation = await workspace.tasks.run({
        kind: "project",
        task: "build",
      });
      assert.equal(validation.status, "blocked");
      if (validation.status === "blocked")
        assert.equal(validation.category, "environment");
      let validationActivities = 0;
      let memoryCreated = false;
      const tool = createFinishTaskTool({
        conversationId: sessionId,
        onComplete: (notification) => {
          memoryCreated = Boolean(notification.memory);
        },
        onValidationActivity: () => {
          validationActivities += 1;
        },
        taskContract: contract(sessionId),
        workspaceRoot: root,
      });
      await tool.execute({ summary: "Updated with validation unavailable." }, {
        sessionId,
        toolCallId: "unavailable-finish",
      } as never);
      assert.equal(validationActivities, 0);
      assert.equal(memoryCreated, false);
    },
  );
});

test("remote finish_task forwards automatic validation activities", async () => {
  await withWorkspace(
    {
      "package.json": JSON.stringify({ scripts: { test: "node --version" } }),
      "value.ts": "export const value = 1\n",
    },
    async (root) => {
      const sessionId = "remote-finish";
      const taskContract = contract(sessionId);
      const workspace = lightWorkspace(root, sessionId);
      await workspace.tasks.run({ kind: "project", task: "test" });
      await workspace.editCode({
        operations: [
          {
            kind: "patch",
            path: "value.ts",
            patch: applyPatch("value.ts", [
              "-export const value = 1",
              "+export const value = 2",
            ]),
          },
        ],
      });
      const phases: string[] = [];
      const tool = createFinishTaskTool({
        conversationId: sessionId,
        executor: executeLightWorkspaceRequest,
        onValidationActivity: ({ phase }) => {
          phases.push(phase);
        },
        taskContract,
        workspaceRoot: root,
      });
      await tool.execute({ summary: "Updated remotely." }, {
        sessionId,
        toolCallId: "remote-finish",
      } as never);
      assert.deepEqual(phases, ["started", "finished"]);
    },
  );
});

test("content changes invalidate journal validations", async () => {
  await withWorkspace(
    { "value.ts": "export const value = 1\n" },
    async (root) => {
      const journal = new SessionJournal(root, "validation-freshness");
      const sourceRevisionId = (await new WorkspaceFiles(root).snapshot())
        .revision.source_revision_id;
      await journal.recordChange({
        parse: "passed",
        paths: ["value.ts"],
        receipt: "e1",
        sourceRevisionId,
        symbols: [],
      });
      await journal.recordValidation({
        command: "test",
        paths: ["value.ts"],
        sourceRevisionId,
        status: "passed",
      });
      assert.equal((await journal.completionSnapshot()).validations.length, 1);
      await writeFile(join(root, "value.ts"), "export const value = 2\n");
      assert.equal((await journal.completionSnapshot()).validations.length, 0);
    },
  );
});

test("one native Cline patch edits multiple files atomically", async () => {
  await withWorkspace(
    {
      "a.ts": "export const a = 1\n",
      "b.ts": "export const b = 2\n",
    },
    async (root) => {
      const workspace = lightWorkspace(root, "multi-file-patch");
      const result = await workspace.editCode({
        operations: [
          {
            kind: "patch",
            patch: multiFilePatch([
              [
                "*** Update File: a.ts",
                "@@",
                "-export const a = 1",
                "+export const a = 3",
              ],
              [
                "*** Update File: b.ts",
                "@@",
                "-export const b = 2",
                "+export const b = 4",
              ],
            ]),
          },
        ],
      });
      assert.equal(result.status, "ok");
      const changes = array(data(result).changes).map(record);
      assert.deepEqual(
        changes.map(({ symbols }) => symbols),
        [["a"], ["b"]],
      );
      assert.equal(
        await readFile(join(root, "a.ts"), "utf8"),
        "export const a = 3\n",
      );
      assert.equal(
        await readFile(join(root, "b.ts"), "utf8"),
        "export const b = 4\n",
      );
    },
  );
});

test("a path-addressed update patch may omit its redundant file header", async () => {
  await withWorkspace({ "a.ts": "export const a = 1\n" }, async (root) => {
    const workspace = lightWorkspace(root, "implicit-update-header");
    const result = await workspace.editCode({
      operations: [
        {
          kind: "patch",
          path: "a.ts",
          patch: [
            "*** Begin Patch",
            "@@",
            "-export const a = 1",
            "+export const a = 2",
            "*** End Patch",
          ].join("\n"),
        },
      ],
    });
    assert.equal(result.status, "ok");
    assert.equal(
      await readFile(join(root, "a.ts"), "utf8"),
      "export const a = 2\n",
    );
  });
});

test("a leading implicit update composes with explicit file operations", async () => {
  await withWorkspace({ "a.ts": "export const a = 1\n" }, async (root) => {
    const workspace = lightWorkspace(root, "implicit-update-multi-file");
    const result = await workspace.editCode({
      operations: [
        {
          kind: "patch",
          path: "a.ts",
          patch: [
            "*** Begin Patch",
            "@@",
            "-export const a = 1",
            "+export const a = 2",
            "*** Add File: b.ts",
            "+export const b = 3",
            "*** End Patch",
          ].join("\n"),
        },
      ],
    });
    assert.equal(result.status, "ok");
    assert.equal(
      await readFile(join(root, "a.ts"), "utf8"),
      "export const a = 2\n",
    );
    assert.equal(
      await readFile(join(root, "b.ts"), "utf8"),
      "export const b = 3",
    );
  });
});

test("an explicit file patch may omit only its opening envelope", async () => {
  await withWorkspace({}, async (root) => {
    const workspace = lightWorkspace(root, "implicit-opening-envelope");
    const result = await workspace.editCode({
      operations: [
        {
          kind: "patch",
          path: "a.ts",
          patch: [
            "*** Add File: a.ts",
            "+export const a = 1",
            "*** End Patch",
          ].join("\n"),
        },
      ],
    });
    assert.equal(result.status, "ok");
    assert.equal(
      await readFile(join(root, "a.ts"), "utf8"),
      "export const a = 1",
    );
  });
});

test("a path-addressed added file may omit its redundant file header", async () => {
  await withWorkspace({}, async (root) => {
    const workspace = lightWorkspace(root, "implicit-add-header");
    const result = await workspace.editCode({
      operations: [
        {
          kind: "patch",
          path: "a.ts",
          patch: [
            "*** Begin Patch",
            "+export const a = 1",
            "*** End Patch",
          ].join("\n"),
        },
      ],
    });
    assert.equal(result.status, "ok");
    assert.equal(
      await readFile(join(root, "a.ts"), "utf8"),
      "export const a = 1",
    );
  });
});

test("raw patch content creates a missing path without an envelope", async () => {
  await withWorkspace({}, async (root) => {
    const workspace = lightWorkspace(root, "raw-new-file");
    const result = await workspace.editCode({
      operations: [
        {
          kind: "patch",
          path: "migration.sql",
          patch: "CREATE TYPE status AS ENUM ('DRAFT');\n",
        },
      ],
    });
    assert.equal(result.status, "ok");
    assert.equal(
      await readFile(join(root, "migration.sql"), "utf8"),
      "CREATE TYPE status AS ENUM ('DRAFT');\n",
    );
  });
});

test("raw patch content never replaces an existing path", async () => {
  await withWorkspace({ "existing.txt": "old\n" }, async (root) => {
    const workspace = lightWorkspace(root, "raw-existing-file");
    const result = await workspace.editCode({
      operations: [
        { kind: "patch", path: "existing.txt", patch: "replacement\n" },
      ],
    });
    assert.equal(result.status, "blocked");
    assert.equal(await readFile(join(root, "existing.txt"), "utf8"), "old\n");
  });
});

test("a pure addition update to a missing target becomes a file addition", async () => {
  await withWorkspace({}, async (root) => {
    const workspace = lightWorkspace(root, "missing-update-addition");
    const result = await workspace.editCode({
      operations: [
        {
          kind: "patch",
          path: "a.ts",
          patch: [
            "*** Begin Patch",
            "*** Update File: a.ts",
            "@@",
            "+export const a = 1",
            "*** End Patch",
          ].join("\n"),
        },
      ],
    });
    assert.equal(result.status, "ok");
    assert.equal(
      await readFile(join(root, "a.ts"), "utf8"),
      "export const a = 1",
    );
  });
});

test("overlaps and final parse failures leave every file unchanged", async () => {
  const initial = {
    "a.ts": "export function a() { return 1 }\n",
    "b.ts": "export function b() { return 2 }\n",
  };
  await withWorkspace(initial, async (root) => {
    const workspace = lightWorkspace(root, "atomic");
    const alias = await symbolAlias(workspace, "a");
    const overlap = await workspace.edits.edit(
      {
        operations: [
          {
            kind: "symbol",
            target: alias,
            action: "replace",
            content: "export function a() { return 3 }",
          },
          { kind: "symbol", target: alias, action: "delete" },
        ],
      },
      { sessionId: "atomic", toolCallId: "overlap" },
    );
    assert.equal(overlap.status, "blocked");
    if (overlap.status === "blocked") {
      assert.match(overlap.message, /replace s\d+ conflicts with delete s\d+/u);
      assert.match(overlap.message, /split the edits and re-read/u);
    }
    const invalid = await workspace.edits.edit(
      {
        operations: [
          {
            kind: "patch",
            patch: multiFilePatch([
              [
                "*** Update File: a.ts",
                "@@",
                "-export function a() { return 1 }",
                "+export function a() { return 4 }",
              ],
              [
                "*** Update File: b.ts",
                "@@",
                "-export function b() { return 2 }",
                "+export function b(",
              ],
            ]),
          },
        ],
      },
      { sessionId: "atomic", toolCallId: "invalid" },
    );
    assert.equal(invalid.status, "blocked");
    assert.equal(await readFile(join(root, "a.ts"), "utf8"), initial["a.ts"]);
    assert.equal(await readFile(join(root, "b.ts"), "utf8"), initial["b.ts"]);
  });
});

test("a failure on the last file rolls back the complete batch", async () => {
  const initial = { "a.txt": "a\n", "b.txt": "b\n" };
  await withWorkspace(initial, async (root) => {
    const files = new FailingWriteWorkspaceFiles(root);
    const snapshot = await files.snapshot();
    const commit = new LightCommitService(files);
    await assert.rejects(
      commit.commit(
        [
          mutation("a.txt", "a\n", "changed-a\n"),
          mutation("b.txt", "b\n", "changed-b\n"),
        ],
        snapshot.revision.source_revision_id,
      ),
      /simulated final write failure/u,
    );
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), initial["a.txt"]);
    assert.equal(await readFile(join(root, "b.txt"), "utf8"), initial["b.txt"]);
  });
});

test("patch operations create and delete files atomically", async () => {
  await withWorkspace({ "old.txt": "old\n" }, async (root) => {
    const workspace = lightWorkspace(root, "files");
    const result = await workspace.edits.edit(
      {
        operations: [
          {
            kind: "patch",
            patch: multiFilePatch([
              ["*** Add File: new.txt", "+new"],
              ["*** Delete File: old.txt"],
            ]),
          },
        ],
      },
      { sessionId: "files", toolCallId: "move" },
    );
    assert.equal(result.status, "ok");
    assert.equal(await readFile(join(root, "new.txt"), "utf8"), "new");
    await assert.rejects(readFile(join(root, "old.txt"), "utf8"));
  });
});

test("stale aliases relocate once only when identity remains unique", async () => {
  const source = "export function target() { return 1 }\n";
  await withWorkspace({ "target.ts": source }, async (root) => {
    const workspace = lightWorkspace(root, "rebase");
    const alias = await symbolAlias(workspace, "target");
    await writeFile(join(root, "target.ts"), `const prefix = 0\n${source}`);
    const result = await workspace.edits.edit(
      {
        operations: [
          {
            kind: "symbol",
            target: alias,
            action: "replace_body",
            content: "{ return 2 }",
          },
        ],
      },
      { sessionId: "rebase", toolCallId: "relocate" },
    );
    assert.equal(result.status, "ok");
    assert.match(await readFile(join(root, "target.ts"), "utf8"), /return 2/u);
  });
});

test("symbol aliases remain valid across successive indexed edits", async () => {
  const source = "export function target() { return 1 }\n";
  await withWorkspace({ "target.ts": source }, async (root) => {
    const workspace = lightWorkspace(root, "stable-symbol-alias");
    const alias = await symbolAlias(workspace, "target");
    for (const value of [2, 3]) {
      const result = await workspace.editCode({
        operations: [
          {
            action: "replace_body",
            content: `{ return ${value} }`,
            kind: "symbol",
            target: alias,
          },
        ],
      });
      assert.equal(result.status, "ok");
      assert.equal(data(result).diff, undefined);
      assert.match(String(data(result).sourceRevisionId), /^src_/u);
      assert.ok(
        array(data(result).aliases).some(
          (entry) => record(entry).alias === alias,
        ),
      );
    }
    assert.equal(
      await readFile(join(root, "target.ts"), "utf8"),
      "export function target() { return 3 }\n",
    );
  });
});

for (const [content, lines] of [["", 0], ["\n", 1], ["first\nsecond", 2], ["first\nsecond\n", 2]] as const) {
  test(`deleting ${JSON.stringify(content)} reports only existing lines`, async () => {
    await withWorkspace({ "notes.txt": content }, async (root) => {
      const workspace = lightWorkspace(root, "delete-line-count");
      const result = data(await workspace.editCode({ operations: [{
        kind: "patch", patch: "*** Begin Patch\n*** Delete File: notes.txt\n*** End Patch",
      }] }));
      const change = record(array(result.changes)[0]);
      assert.equal(change.additions, 0);
      assert.equal(change.deletions, lines);
    });
  });
}

test("creating a file does not report a deletion from an empty source", async () => {
  await withWorkspace({}, async (root) => {
    const workspace = lightWorkspace(root, "add-line-count");
    const result = data(await workspace.editCode({ operations: [{
      kind: "patch", patch: "*** Begin Patch\n*** Add File: notes.txt\n+first\n+second\n*** End Patch",
    }] }));
    const change = record(array(result.changes)[0]);
    assert.equal(change.additions, 2);
    assert.equal(change.deletions, 0);
  });
});

test("edit receipts omit echoed diffs and unrelated aliases", async () => {
  const source = [
    "export function target() { return 1 }",
    "export function unrelated() { return 9 }",
    "",
  ].join("\n");
  await withWorkspace({ "target.ts": source }, async (root) => {
    const workspace = lightWorkspace(root, "compact-edit-receipt");
    const target = await symbolAlias(workspace, "target");
    await symbolAlias(workspace, "unrelated");
    const result = await workspace.editCode({
      operations: [
        {
          action: "replace_body",
          content: "{ return 2 }",
          kind: "symbol",
          target,
        },
      ],
    });
    const receipt = data(result);
    assert.equal(receipt.diff, undefined);
    assert.deepEqual(
      array(receipt.aliases).map((entry) => record(entry).alias),
      [target],
    );
    assert.match(String(receipt.sourceRevisionId), /^src_/u);
  });
});

test("no-op edits preserve source and journal while allowing explicit body layout", async () => {
  const initial = 'export function response() {\n  return {\n      id: "p",\n    };\n}\n';
  await withWorkspace({ "response.ts": initial }, async (root) => {
    const workspace = lightWorkspace(root, "noop-guidance");
    await workspace.readCode({ target: "response.ts#response", view: "symbol" }, {});
    const journal = new SessionJournal(root, "noop-guidance");
    const before = await journal.completionSnapshot();
    const result = await workspace.editCode({ operations: [{
      kind: "symbol",
      target: "response.ts#response",
      action: "replace_body",
      content: 'return {\n    id: "p",\n  };',
    }] });
    assert.equal(result.status, "ok");
    assert.equal(record(data(result)).changed, false);
    assert.equal(await readFile(join(root, "response.ts"), "utf8"), initial);
    assert.equal("receipt" in result, false);
    const after = await journal.completionSnapshot();
    assert.equal(after.sourceRevisionId, before.sourceRevisionId);
    assert.deepEqual(after.changedPaths, []);
    assert.deepEqual(after.validations, []);
    assert.equal(record(data(result)).guidance, undefined);
    const changed = await workspace.editCode({ operations: [{
      kind: "symbol",
      target: "response.ts#response",
      action: "replace_body",
      content: '{\n  return {\n    id: "p",\n  };\n}',
    }] });
    assert.equal(changed.status, "ok");
    assert.equal(record(data(changed)).changed, true);
    assert.equal(record(data(changed)).guidance, undefined);
    assert.equal(await readFile(join(root, "response.ts"), "utf8"),
      'export function response() {\n  return {\n    id: "p",\n  };\n}\n');
  });
});

function lightWorkspace(root: string, sessionId: string) {
  const taskContract = contract(sessionId);
  return new LightWorkspace(root, {
    sessionId,
    taskContract,
  });
}

function contract(sessionId: string) {
  return {
    acceptance_criteria: ["apply requested change"],
    effect_requirement: "source_change" as const,
    objective: "apply requested change",
    session_id: sessionId,
  };
}

class FailingWriteWorkspaceFiles extends WorkspaceFiles {
  private resolutions = 0;

  override async resolveForWriteVerified(path: string) {
    this.resolutions += 1;
    if (this.resolutions === 4)
      throw new Error("simulated final write failure");
    return super.resolveForWriteVerified(path);
  }
}

function mutation(path: string, before: string, after: string) {
  return {
    after: Buffer.from(after),
    before: Buffer.from(before),
    mode: 0o644,
    path,
  };
}

async function symbolAlias(workspace: LightWorkspace, query: string) {
  const result = data(await workspace.searchCode({ query, mode: "symbol" }));
  const alias = String(record(array(result.results)[0]).alias);
  await workspace.readCode({ target: alias }, {});
  return alias;
}

function applyPatch(path: string, lines: string[]) {
  return [
    "*** Begin Patch",
    `*** Update File: ${path}`,
    "@@",
    ...lines,
    "*** End Patch",
  ].join("\n");
}

function multiFilePatch(operations: string[][]) {
  return ["*** Begin Patch", ...operations.flat(), "*** End Patch"].join("\n");
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withFormatterWorkspace(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
) {
  const formatter = [
    "#!/usr/bin/env node",
    'let source = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { source += chunk; });',
    'process.stdin.on("end", () => {',
    '  if (source.includes("INVALID")) process.exit(2);',
    '  const output = source.replace(/const (\\w+)=\\{value:(\\d+)\\}/gu, "const $1 = { value: $2 };");',
    '  const markdown = process.argv.at(-1)?.endsWith(".md");',
    '  process.stdout.write(markdown && !output.endsWith("\\n") ? output + "\\n" : output);',
    "});",
  ].join("\n");
  await withWorkspace(
    {
      "package.json": JSON.stringify({
        devDependencies: { prettier: "3.0.0" },
      }),
      "node_modules/.bin/prettier": formatter,
      ...files,
    },
    async (root) => {
      await chmod(join(root, "node_modules/.bin/prettier"), 0o755);
      await run(root);
    },
  );
}

async function withWorkspace(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "blame-light-test-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function data(result: LightToolResult<unknown>) {
  assert.equal(
    result.status,
    "ok",
    result.status === "ok" ? undefined : result.message,
  );
  return record(result.status === "ok" ? result.data : undefined);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown) {
  return Array.isArray(value) ? value : [];
}
