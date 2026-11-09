import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { githubCliArchive, githubCliVersion, installGithubCli, withGithubCli, type GithubCliArchive } from "./github-cli.js";
import { EnvironmentAdapter } from "./environment-adapter.js";
import { lightSemanticHarnessTools } from "./light-tools.js";
import type { WorkspaceFiles } from "./workspace-files.js";

const posixOnly = { skip: process.platform === "win32" ? "The fixture gh is a shell script" : false };
const appToken = "fixture-app-token";
const member = "gh_fixture/bin/gh";
// Reports what a command running `gh` reached, without printing the token.
const fixtureGh = `#!/bin/sh
token=absent
[ -n "$GH_TOKEN" ] && token=other
[ "$GH_TOKEN" = "${appToken}" ] && token=granted
printf 'blame gh %s, token %s, config %s\n' "$*" "$token" "$GH_CONFIG_DIR"
`;

test("a cloud command runs the gh Blame provides, with the App token and a config directory of its own", posixOnly, async () => {
  await fixture(async ({ root, archive, cacheRoot }) => {
    const personalConfigDirectory = join(homedir(), ".config", "gh");
    const home = await homeWhoseLoginProfilePutsHostGhFirst();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const tool = lightSemanticHarnessTools(root, {
        commandCredentials: () => withGithubCli({ githubToken: appToken }, { root: cacheRoot, archive }),
        taskContract: { session_id: "cloud-gh", environment: { isolated: false, managedPreview: true } },
      }).find(({ name }) => name === "run_task")!;
      const command = `gh pr list && node -e 'process.stdout.write("first " + process.env.PATH.split(require("node:path").delimiter)[0])'`;
      const result = JSON.stringify(
        await tool.execute({ kind: "command", command }, { sessionId: "cloud-gh", toolCallId: "gh" } as never),
      );
      assert.doesNotMatch(result, /host gh/u, result);
      assert.match(result, /blame gh pr list, token granted, config /u, result);
      assert.ok(result.includes(`first ${join(cacheRoot, archive.sha256, "bin")}`), result);
      const configDirectory = /config (\/[^\s"\\]+)/u.exec(result)?.[1];
      assert.ok(configDirectory?.startsWith(join(tmpdir(), "blame-gh-config-")), result);
      assert.notEqual(configDirectory, personalConfigDirectory);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { force: true, recursive: true });
    }
  });
});

test("the directory a shell command gets first is kept whatever characters its path holds", posixOnly, () => {
  const directory = "/tmp/it's a \"gh\" $HOME";
  const { executable, args } = new EnvironmentAdapter({} as WorkspaceFiles, "linux").command(
    `printf '%s' "$PATH"`,
    directory,
  );
  const path = execFileSync(executable, args, { encoding: "utf8" });
  assert.equal(path.split(":")[0], directory);
});

test("concurrent commands share one verified download of gh", posixOnly, async () => {
  await fixture(async ({ archive, cacheRoot, requests }) => {
    const [first, second] = await Promise.all([installGithubCli(cacheRoot, archive), installGithubCli(cacheRoot, archive)]);
    assert.equal(first, join(cacheRoot, archive.sha256, "bin"));
    assert.equal(second, first);
    assert.equal(requests(), 1);
    assert.equal(await readFile(join(first, "gh"), "utf8"), fixtureGh);
    assert.equal(await installGithubCli(cacheRoot, archive), first);
    assert.equal(requests(), 1);
  });
});

test("an archive that does not match its pinned checksum is never installed", posixOnly, async (t) => {
  await fixture(async ({ archive, cacheRoot }) => {
    const tampered = { ...archive, sha256: "0".repeat(64) };
    await assert.rejects(installGithubCli(cacheRoot, tampered), /checksum mismatch/u);
    await assert.rejects(access(join(cacheRoot, tampered.sha256)));

    const warn = t.mock.method(console, "warn", () => undefined);
    const credentials = await withGithubCli({ githubToken: appToken }, { root: cacheRoot, archive: tampered });
    // The command still gets its token and isolated config, and the failure is reported.
    assert.equal(credentials.githubToken, appToken);
    assert.equal(credentials.githubCli?.binDirectory, undefined);
    assert.ok(credentials.githubCli?.configDirectory);
    assert.match(String(warn.mock.calls[0]?.arguments[1]), /checksum mismatch/u);
  });
});

test("without a GitHub token, commands get no gh and nothing is downloaded", async () => {
  await fixture(async ({ archive, cacheRoot, requests }) => {
    assert.deepEqual(await withGithubCli({}, { root: cacheRoot, archive }), {});
    assert.equal(requests(), 0);
  });
});

test("each host gets the pinned gh release archive of its platform", () => {
  const release = `https://github.com/cli/cli/releases/download/v${githubCliVersion}`;
  assert.deepEqual(githubCliArchive("darwin", "arm64"), {
    url: `${release}/gh_${githubCliVersion}_macOS_arm64.zip`,
    sha256: "d700207eae9ae98fe2b89535c2c087c07823d4628c56364695a5a07ef311c062",
    member: `gh_${githubCliVersion}_macOS_arm64/bin/gh`,
  });
  assert.equal(githubCliArchive("linux", "x64")?.url, `${release}/gh_${githubCliVersion}_linux_amd64.tar.gz`);
  assert.equal(githubCliArchive("win32", "x64")?.member, "bin/gh.exe");
  assert.equal(githubCliArchive("linux", "ia32"), undefined);
  assert.equal(githubCliArchive("freebsd", "x64"), undefined);
});

async function fixture(
  body: (context: { root: string; cacheRoot: string; archive: GithubCliArchive; requests: () => number }) => Promise<void>,
) {
  const scratch = await mkdtemp(join(tmpdir(), "blame-github-cli-"));
  const root = join(scratch, "workspace");
  const cacheRoot = join(scratch, "cache");
  const content = await fixtureArchive(join(scratch, "release"));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end(content);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await mkdir(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {} }));
    git(root, ["init", "-q"]);
    git(root, ["add", "."]);
    git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    const { port } = server.address() as AddressInfo;
    await body({
      root,
      cacheRoot,
      archive: {
        url: `http://127.0.0.1:${port}/gh.tar.gz`,
        sha256: createHash("sha256").update(content).digest("hex"),
        member,
      },
      requests: () => requests,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(scratch, { force: true, recursive: true });
  }
}

async function fixtureArchive(directory: string) {
  const executable = join(directory, member);
  await mkdir(join(directory, "gh_fixture", "bin"), { recursive: true });
  await writeFile(executable, fixtureGh);
  await chmod(executable, 0o755);
  execFileSync("tar", ["-czf", join(directory, "gh.tar.gz"), "-C", directory, "gh_fixture"]);
  return readFile(join(directory, "gh.tar.gz"));
}

function git(root: string, args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

/**
 * Like macOS, where path_helper (/etc/profile) and `brew shellenv` put
 * /opt/homebrew/bin back before the directories a command inherited: the
 * login shell of a command then finds the host's gh first.
 */
async function homeWhoseLoginProfilePutsHostGhFirst() {
  const home = await mkdtemp(join(tmpdir(), "blame-gh-home-"));
  const hostBin = join(home, "host-bin");
  await mkdir(hostBin);
  await writeFile(join(hostBin, "gh"), "#!/bin/sh\necho 'host gh'\n");
  await chmod(join(hostBin, "gh"), 0o755);
  await writeFile(join(home, ".bash_profile"), `export PATH='${hostBin}':"$PATH"\n`);
  return home;
}
