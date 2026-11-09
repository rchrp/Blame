import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const available = process.platform !== "win32" &&
  spawnSync("tar", ["--version"], { stdio: "ignore" }).status === 0;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function provisioningFunctions(platform, binary) {
  const source = await readFile(resolve(`packages/desktop/resources/runtime/${platform}/scripts/provision-blame-runtime.sh`), "utf8");
  const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  const version = source.match(/^gh_version="([^"]+)"$/m)?.[1];
  assert.ok(version, "The provisioner pins a gh version");
  return {
    version,
    functions: [
      between("download_verified() {", "docker_archive_architecture() {"),
      between("ensure_gh() (", "# Logs and the build cache stay bounded"),
    ].join("\n").replaceAll("/usr/local/bin/gh", binary),
  };
}

// A release archive laid out like GitHub's, with a gh that prints a version.
async function releaseArchive(root, version, printed) {
  const tree = join(root, "release");
  const name = `gh_${version}_linux_amd64`;
  await mkdir(join(tree, name, "bin"), { recursive: true });
  await writeFile(join(tree, name, "bin/gh"), `#!/bin/sh\nprintf '%s\\n' 'gh version ${printed} (2026-10-26)'\n`);
  await chmod(join(tree, name, "bin/gh"), 0o755);
  const archive = join(root, "gh.tar.gz");
  const result = spawnSync("tar", ["-czf", archive, "-C", tree, name], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return { archive, checksum: createHash("sha256").update(await readFile(archive)).digest("hex") };
}

async function fixture(platform, action) {
  const root = await mkdtemp(join(tmpdir(), "blame-gh-install-"));
  const binary = join(root, "bin/gh");
  const downloads = join(root, "downloads");
  try {
    await mkdir(join(root, "bin"));
    const { version, functions } = await provisioningFunctions(platform, binary);
    const run = (archive, checksum) => spawnSync("sh", ["-c", `set -eu
gh_version=${quote(version)}
${functions}
runtime_architecture() { printf amd64; }
gh_archive_sha256() { printf '%s' ${quote(checksum)}; }
curl() {
  printf '%s\\n' "$2" >>${quote(downloads)}
  cp ${quote(archive)} "$4"
}
command -v sha256sum >/dev/null 2>&1 || sha256sum() { shasum -a 256 "$@"; }
ensure_gh
`], { encoding: "utf8", timeout: 15_000 });
    await action({ root, binary, downloads, version, run });
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const platform of ["macos", "windows"]) {
  test(`${platform} installs the pinned gh release once`, { skip: !available }, () => fixture(platform, async ({ root, binary, downloads, version, run }) => {
    const { archive, checksum } = await releaseArchive(root, version, version);
    const first = run(archive, checksum);
    assert.equal(first.status, 0, first.stderr);
    assert.match(spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout, new RegExp(`^gh version ${version.replaceAll(".", "\\.")} `));
    assert.deepEqual((await readFile(downloads, "utf8")).trim().split("\n"), [
      `https://github.com/cli/cli/releases/download/v${version}/gh_${version}_linux_amd64.tar.gz`,
    ]);
    assert.equal(run(archive, checksum).status, 0);
    assert.equal((await readFile(downloads, "utf8")).trim().split("\n").length, 1, "A current gh must not be downloaded again");
  }));

  test(`${platform} rejects a gh archive with another checksum`, { skip: !available }, () => fixture(platform, async ({ root, binary, version, run }) => {
    const { archive } = await releaseArchive(root, version, version);
    const result = run(archive, "0".repeat(64));
    assert.notEqual(result.status, 0, "An unverified archive was accepted");
    await assert.rejects(access(binary), "gh must not be installed from an unverified archive");
  }));

  test(`${platform} fails when the installed gh is not the pinned version`, { skip: !available }, () => fixture(platform, async ({ root, version, run }) => {
    const { archive, checksum } = await releaseArchive(root, version, "0.0.1");
    assert.notEqual(run(archive, checksum).status, 0);
  }));
}

const repositoryFile = (path) => readFile(resolve(path), "utf8");
const allMatches = (source, pattern) => [...source.matchAll(pattern)].map((match) => match.slice(1));

// github-cli.ts is the reference: every other file writes the same release by hand.
async function pinnedGithubCli() {
  const source = await repositoryFile("packages/agent-runtime/src/harness/github-cli.ts");
  const version = source.match(/^export const githubCliVersion = "([^"]+)";$/m)?.[1];
  const checksum = (architecture) => source.match(new RegExp(`"linux_${architecture}\\.tar\\.gz": "([0-9a-f]{64})"`))?.[1];
  const pinned = { version, amd64: checksum("amd64"), arm64: checksum("arm64") };
  assert.ok(pinned.version && pinned.amd64 && pinned.arm64, "github-cli.ts pins gh and its Linux checksums");
  return pinned;
}

for (const platform of ["macos", "windows"]) {
  test(`${platform} provisioner pins the gh release of github-cli.ts`, async () => {
    const pinned = await pinnedGithubCli();
    const source = await repositoryFile(`packages/desktop/resources/runtime/${platform}/scripts/provision-blame-runtime.sh`);
    assert.deepEqual(allMatches(source, /^gh_version="([^"]+)"$/gm), [[pinned.version]]);
    const checksums = source.match(/^gh_archive_sha256\(\) \{\n([\s\S]*?)\n\}$/m)?.[1];
    assert.ok(checksums, "The provisioner pins the gh archive checksums");
    assert.deepEqual(allMatches(checksums, /^\s*([^\s:]+):(\S+)\) printf '%s' "([0-9a-f]+)" ;;$/gm), [
      [pinned.version, "amd64", pinned.amd64],
      [pinned.version, "arm64", pinned.arm64],
    ]);
  });
}

for (const path of [
  "packages/desktop/resources/runtime/macos/scripts/blame-lima-runtime.sh",
  "packages/desktop/resources/runtime/windows/scripts/blame-wsl2-runtime.ps1",
]) {
  test(`${path} checks the gh release of github-cli.ts`, async () => {
    const { version } = await pinnedGithubCli();
    const checked = allMatches(await repositoryFile(path), /\^gh version (\S+) /g).map(([found]) => found);
    assert.ok(checked.length > 0, "The runtime health check verifies the gh version");
    assert.deepEqual(checked, checked.map(() => version));
  });
}

test("sandbox-runner image installs the gh release of github-cli.ts", async () => {
  const pinned = await pinnedGithubCli();
  const source = await repositoryFile("packages/sandbox-runner/Dockerfile");
  assert.deepEqual(allMatches(source, /^ARG GH_VERSION=(\S+)$/gm), [[pinned.version]]);
  assert.deepEqual(allMatches(source, /^ARG GH_SHA256=(\S+)$/gm), [[pinned.amd64]]);
  assert.match(source, /gh_\$\{GH_VERSION\}_linux_amd64\.tar\.gz/, "The image installs the amd64 archive GH_SHA256 verifies");
});
