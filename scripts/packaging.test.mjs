import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageValues, parseSha256Sums, releaseFiles, render, renderPackages } from "./packaging.mjs";

const sums = new Map(Object.values(releaseFiles).map((file, index) => [file, String(index).repeat(64)]));

test("SHA256SUMS lines are read in text and binary mode", () => {
  const parsed = parseSha256Sums(`${"A".repeat(64)}  blame-win-x64.exe\n${"b".repeat(64)} *blame-mac-x64.dmg\n`);
  assert.equal(parsed.get("blame-win-x64.exe"), "a".repeat(64));
  assert.equal(parsed.get("blame-mac-x64.dmg"), "b".repeat(64));
  assert.throws(() => parseSha256Sums("not a checksum\n"), /Unreadable/);
});

test("only stable versions with every installer checksum are packaged", () => {
  assert.throws(() => packageValues("1.2.0-beta.1", sums), /not a stable version/);
  assert.throws(() => packageValues("v1.2.0", sums), /not a stable version/);
  const partial = new Map(sums);
  partial.delete("blame-linux-amd64.deb");
  assert.throws(() => packageValues("1.2.0", partial), /blame-linux-amd64\.deb/);
});

test("an unknown placeholder fails instead of shipping a template", () => {
  assert.throws(() => render("{{NOPE}}", { VERSION: "1.0.0" }), /No value for \{\{NOPE\}\}/);
});

test("every template renders with the release version and checksums", async () => {
  const output = await mkdtemp(join(tmpdir(), "blame-packaging-"));
  try {
    const files = await renderPackages("1.2.3", sums, output);
    assert.equal(files.length, 5);
    for (const file of files) assert.doesNotMatch(await readFile(file, "utf8"), /\{\{/);
    const cask = await readFile(join(output, "homebrew/Casks/blame.rb"), "utf8");
    assert.match(cask, /version "1\.2\.3"/);
    assert.match(cask, new RegExp(`arm: +"${sums.get("blame-mac-arm64.dmg")}"`));
    const pkgbuild = await readFile(join(output, "aur/PKGBUILD"), "utf8");
    assert.match(pkgbuild, /^pkgver=1\.2\.3$/m);
    assert.match(pkgbuild, new RegExp(`sha256sums=\\('${sums.get("blame-linux-amd64.deb")}'\\)`));
    const installer = await readFile(join(output, "winget/Blame.Blame.installer.yaml"), "utf8");
    assert.match(installer, /download\/v1\.2\.3\/blame-win-x64\.exe/);
    assert.equal(installer.match(new RegExp(sums.get("blame-win-x64.exe"), "g")).length, 2);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
