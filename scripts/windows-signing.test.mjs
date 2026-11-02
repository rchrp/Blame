import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { refreshUpdateInfo, windowsProductVersion } from "./windows-signing.mjs";

const YAML = createRequire(new URL("../packages/desktop/package.json", import.meta.url))("yaml");

test("the Windows product version drops the prerelease and adds a build number", () => {
  assert.equal(windowsProductVersion("1.2.3"), "1.2.3.0");
  assert.equal(windowsProductVersion("1.2.3-beta.4"), "1.2.3.0");
  assert.throws(() => windowsProductVersion("v1.2"), /Not a semver version/);
});

test("update-info describes the signed installer, not the unsigned one", async () => {
  const root = await mkdtemp(join(tmpdir(), "windows-signing-test-"));
  try {
    const dist = join(root, "dist");
    await mkdir(join(root, "signed"), { recursive: true });
    await mkdir(dist);
    await writeFile(join(dist, "blame-win-x64.exe"), "unsigned");
    await writeFile(join(dist, "blame-win-x64.exe.blockmap"), "stale");
    await writeFile(
      join(dist, "latest.yml"),
      [
        "version: 1.2.3",
        "files:",
        "  - url: blame-win-x64.exe",
        "    sha512: unsigned",
        "    size: 8",
        "path: blame-win-x64.exe",
        "sha512: unsigned",
        "releaseDate: '2026-11-02T00:00:00.000Z'",
        "",
      ].join("\n"),
    );
    const signed = Buffer.alloc(200_000, "signed");
    await writeFile(join(root, "signed/blame-win-x64.exe"), signed);

    await refreshUpdateInfo(join(root, "signed/blame-win-x64.exe"), dist);

    const sha512 = createHash("sha512").update(signed).digest("base64");
    const text = await readFile(join(dist, "latest.yml"), "utf8");
    const metadata = YAML.parse(text);
    assert.deepEqual(metadata.files, [{ url: "blame-win-x64.exe", sha512, size: signed.length }]);
    assert.equal(metadata.sha512, sha512);
    assert.match(text, /^releaseDate: '2026-11-02T00:00:00\.000Z'$/m);
    assert.deepEqual(await readFile(join(dist, "blame-win-x64.exe")), signed);
    assert.notEqual((await stat(join(dist, "blame-win-x64.exe.blockmap"))).size, 5);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("update-info refuses metadata that does not list the installer", async () => {
  const root = await mkdtemp(join(tmpdir(), "windows-signing-test-"));
  try {
    await writeFile(join(root, "latest.yml"), YAML.stringify({ files: [{ url: "other.exe" }] }));
    await writeFile(join(root, "blame-win-x64.exe"), "signed");
    await assert.rejects(
      refreshUpdateInfo(join(root, "blame-win-x64.exe"), join(root)),
      /does not list blame-win-x64\.exe once/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
