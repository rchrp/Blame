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
