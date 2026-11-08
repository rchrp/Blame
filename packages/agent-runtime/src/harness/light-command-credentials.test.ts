import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cachedLightWorkspaceExecutor,
  type LightWorkspaceExecutionRequest,
} from "./light-executor.js";
import { lightSemanticHarnessTools } from "./light-tools.js";
import { withCommandCredentials } from "./workspace-command-environment.js";

const grantedToken = "gho_GrantedTokenValue0123456789abcdefABCD";
const inheritedGhToken = "ghp_InheritedHostToken0123456789abcdefAB";
const inheritedGithubToken = "ghp_InheritedGithubToken0123456789abcdef";

// The command reports what it received without printing a token: run_task
// output is redacted (`GH_TOKEN=...` included), and the command itself is
// journaled in the worktree.
const reportCommand = `node -e '${[
  "const e = process.env;",
  "const hash = (v) => require(\"node:crypto\").createHash(\"sha256\").update(v).digest(\"hex\");",
  `const gh = e.GH_TOKEN === undefined ? "absent" : hash(e.GH_TOKEN) === "${sha256(grantedToken)}" ? "granted" : "other";`,
  "const github = e.GITHUB_TOKEN === undefined ? \"absent\" : \"present\";",
  "process.stdout.write(`gh ${gh}, github ${github}`);",
].join(" ")}'`;

test("a managed request's commands get the granted token as GH_TOKEN and never an inherited one", async () => {
  await fixture(async (root, run) => {
    const result = await run({ githubToken: grantedToken });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.match(JSON.stringify(result), /gh granted, github absent/u);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(grantedToken, "u"));
    assert.deepEqual(await filesContaining(root, grantedToken), []);
  });
});

test("without a granted token, a managed request's commands get no GitHub token at all", async () => {
  await fixture(async (_root, run) => {
    const result = await run({});
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.match(JSON.stringify(result), /gh absent, github absent/u);
  });
});

test("commands outside the managed runtime keep their environment", () => {
  const environment = { GH_TOKEN: inheritedGhToken, PATH: "/bin" };
  assert.equal(withCommandCredentials(environment, undefined), environment);
  assert.deepEqual(withCommandCredentials({ ...environment, github_token: inheritedGithubToken }, {}), {
    PATH: "/bin",
  });
});

test("commands run in this process ask the session's credentials before each one", async () => {
  await fixture(async (root) => {
    let asked = 0;
    const tool = lightSemanticHarnessTools(root, {
      commandCredentials: async () => {
        asked += 1;
        return { githubToken: grantedToken };
      },
      taskContract: {
        session_id: "cloud-credentials",
        environment: { isolated: false, managedPreview: true },
      },
    }).find(({ name }) => name === "run_task")!;
    for (const toolCallId of ["first", "second"]) {
      const result = JSON.stringify(
        await tool.execute({ kind: "command", command: reportCommand }, {
          sessionId: "cloud-credentials",
          toolCallId,
        } as never),
      );
      assert.match(result, /gh granted, github absent/u);
      assert.doesNotMatch(result, new RegExp(grantedToken, "u"));
    }
    // Asked again for the second command: a renewed token reaches it.
    assert.equal(asked, 2);
    assert.deepEqual(await filesContaining(root, grantedToken), []);
  });
});

test("a failed credentials request runs the command without any GitHub token", async () => {
  await fixture(async (root) => {
    const tool = lightSemanticHarnessTools(root, {
      commandCredentials: async () => {
        throw new Error("desktop unavailable");
      },
      taskContract: { session_id: "cloud-no-credentials" },
    }).find(({ name }) => name === "run_task")!;
    const result = JSON.stringify(
      await tool.execute({ kind: "command", command: reportCommand }, {
        sessionId: "cloud-no-credentials",
        toolCallId: "failed",
      } as never),
    );
    assert.match(result, /gh absent, github absent/u);
  });
});

async function fixture(
  body: (
    root: string,
    run: (credentials: LightWorkspaceExecutionRequest["commandCredentials"]) => ReturnType<
      ReturnType<typeof cachedLightWorkspaceExecutor>
    >,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "blame-command-credentials-"));
  const previous = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  // The tokens a harness could inherit from the host.
  process.env.GH_TOKEN = inheritedGhToken;
  process.env.GITHUB_TOKEN = inheritedGithubToken;
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {} }));
    git(root, ["init", "-q"]);
    git(root, ["add", "."]);
    git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    const execute = cachedLightWorkspaceExecutor();
    await body(root, (commandCredentials) =>
      execute({
        commandCredentials,
        input: { kind: "command", command: reportCommand },
        taskContract: {
          session_id: "credentials",
          environment: { isolated: true, managedPreview: false },
        },
        tool: "run_task",
        workspaceRoot: root,
      }),
    );
  } finally {
    restore("GH_TOKEN", previous.GH_TOKEN);
    restore("GITHUB_TOKEN", previous.GITHUB_TOKEN);
    await rm(root, { force: true, recursive: true });
  }
}

async function filesContaining(root: string, value: string) {
  const found: string[] = [];
  for (const path of await readdir(root, { recursive: true })) {
    const absolute = join(root, path);
    if (!(await stat(absolute)).isFile()) continue;
    if ((await readFile(absolute)).includes(value)) found.push(path);
  }
  return found;
}

function restore(name: "GH_TOKEN" | "GITHUB_TOKEN", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function git(root: string, args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}
