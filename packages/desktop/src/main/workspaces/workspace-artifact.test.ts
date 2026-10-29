import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { extract } from "tar-stream";
import {
  buildWorkspaceArtifact,
  buildWorkspaceDeltaArtifact,
  buildWorkspaceIncrementalDeltaArtifact,
  prepareWorkspaceSource,
} from "./workspace-artifact.ts";
import { workspaceSourceMode } from "./baseline-transfer.ts";
import { snapshotWorkspace } from "./workspace-snapshot.ts";

const exec = promisify(execFile);

for (const configuration of ["committed", "untracked", "edited"] as const) {
  test(`cloud exclusions remove Git objects and source files with ${configuration} rules`, async () => {
    const root = await mkdtemp(join(tmpdir(), "blame-cloud-bundle-"));
    try {
      await exec("git", ["init", root]);
      await mkdir(join(root, "archives"));
      await writeFile(join(root, "index.js"), "console.log('app')\n");
      await writeFile(join(root, ".gitignore"), ".blameignore\n");
      await writeFile(
        join(root, "archives/results.zip"),
        "excluded-private-archive-data\n",
      );
      await writeFile(join(root, "archives/keep.json"), "{}\n");
      const rules = "/archives/**\n# Manual exception\n!/archives/keep.json\n";
      if (configuration !== "untracked") {
        await writeFile(
          join(root, ".blameignore"),
          configuration === "edited" ? "# Old configuration\n" : rules,
        );
        await exec("git", ["-C", root, "add", "--force", ".blameignore"]);
      }
      await exec("git", ["-C", root, "add", "."]);
      await exec("git", [
        "-C",
        root,
        "-c",
        "user.name=Blame Test",
        "-c",
        "user.email=test@blame.so",
        "commit",
        "-m",
        "base",
      ]);
      await writeFile(join(root, ".blameignore"), rules);
      const artifact = await buildWorkspaceArtifact(root);
      const entries = await archiveEntries(artifact.content);
      assert.equal(entries.has("workspace/archives/results.zip"), false);
      assert.equal(entries.has("workspace/archives/keep.json"), true);
      const transport = await mkdtemp(join(tmpdir(), "blame-cloud-clone-"));
      try {
        const bundle = join(transport, "repository.bundle");
        const clone = join(transport, "checkout");
        await writeFile(bundle, entries.get(".blame/repository.bundle")!);
        await exec("git", ["clone", "--quiet", bundle, clone]);
        await assert.rejects(readFile(join(clone, "archives/results.zip")), {
          code: "ENOENT",
        });
        assert.equal(
          await readFile(join(clone, ".blameignore"), "utf8"),
          rules,
        );
        assert.equal(
          (await snapshotWorkspace(clone)).hash,
          artifact.workspaceHash,
        );
        const { stdout: history } = await exec("git", [
          "-C",
          clone,
          "log",
          "--all",
          "-p",
        ]);
        assert.equal(history.includes("excluded-private-archive-data"), false);
      } finally {
        await rm(transport, { recursive: true, force: true });
      }
      assert.equal(
        await readFile(join(root, "archives/results.zip"), "utf8"),
        "excluded-private-archive-data\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("desktop snapshots apply cloud exclusions while preserving manual exceptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-desktop-cloud-ignore-"));
  try {
    await mkdir(join(root, "archives"));
    await writeFile(join(root, ".gitignore"), ".*\n");
    await writeFile(
      join(root, ".blameignore"),
      "/archives/**\n!/archives/keep.json\n",
    );
    await writeFile(join(root, "archives/keep.json"), "{}\n");
    await writeFile(join(root, "archives/results.zip"), "large archive\n");
    const before = await snapshotWorkspace(root, "blameignore-v1");
    assert.deepEqual(Object.keys(before.files).sort(), [
      ".blameignore",
      ".gitignore",
      "archives/keep.json",
    ]);
    await writeFile(join(root, "archives/results.zip"), "new archive\n");
    assert.equal(
      (await snapshotWorkspace(root, "blameignore-v1")).hash,
      before.hash,
    );
    assert.ok(
      (await snapshotWorkspace(root, "gitignore-v1")).files[
        "archives/results.zip"
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses deltas only for exact baselines", () => {
  assert.equal(workspaceSourceMode(undefined), "full");
  assert.equal(workspaceSourceMode({ match: "cache" }), "full");
  assert.equal(workspaceSourceMode({ match: "exact" }), "delta");
  assert.equal(workspaceSourceMode({}), "delta");
});

test("builds a reproducible source artifact without runtime secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-source-test-"));
  try {
    await exec("git", ["init", root]);
    await writeFile(join(root, "index.js"), "console.log('ok')\n");
    await exec("git", ["-C", root, "add", "index.js"]);
    await exec("git", [
      "-C",
      root,
      "-c",
      "user.name=Blame Test",
      "-c",
      "user.email=test@blame.so",
      "commit",
      "-m",
      "base",
    ]);
    await writeFile(
      join(root, ".env"),
      "HISTORICAL_SECRET=never-upload-history\n",
    );
    await exec("git", ["-C", root, "add", ".env"]);
    await exec("git", [
      "-C",
      root,
      "-c",
      "user.name=Blame Test",
      "-c",
      "user.email=test@blame.so",
      "commit",
      "-m",
      "add old environment",
    ]);
    await unlink(join(root, ".env"));
    await exec("git", ["-C", root, "add", ".env"]);
    await exec("git", [
      "-C",
      root,
      "-c",
      "user.name=Blame Test",
      "-c",
      "user.email=test@blame.so",
      "commit",
      "-m",
      "remove old environment",
    ]);
    await writeFile(join(root, ".env"), "SECRET=never-upload\n");
    const first = await buildWorkspaceArtifact(root);
    const second = await buildWorkspaceArtifact(root);
    assert.equal(first.workspaceHash, second.workspaceHash);
    assert.equal(first.sourceRevision, second.sourceRevision);
    assert.equal(first.sha256, second.sha256);
    assert.ok(first.size > 0);
    const entries = await archiveEntries(first.content);
    assert.equal(entries.has("workspace/.env"), false);
    const bundle = join(root, "repository.bundle");
    await writeFile(bundle, entries.get(".blame/repository.bundle")!);
    const clone = join(root, "transport-clone");
    await exec("git", ["clone", "--quiet", bundle, clone]);
    const { stdout: history } = await exec("git", [
      "-C",
      clone,
      "log",
      "--all",
      "-p",
    ]);
    assert.equal(
      history.includes("HISTORICAL_SECRET=never-upload-history"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("builds a delta against the committed tree and includes new files", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-source-delta-test-"));
  try {
    await exec("git", ["init", root]);
    await writeFile(join(root, "index.js"), "console.log('base')\n");
    await exec("git", ["-C", root, "add", "index.js"]);
    await exec("git", [
      "-C",
      root,
      "-c",
      "user.name=Blame Test",
      "-c",
      "user.email=test@blame.so",
      "commit",
      "-m",
      "base",
    ]);
    await writeFile(join(root, "index.js"), "console.log('changed')\n");
    await writeFile(join(root, "new.txt"), "new\n");
    await mkdir(join(root, ".blame/runtime-tools/lima"), { recursive: true });
    await mkdir(join(root, "packages/desktop/out/main"), { recursive: true });
    await writeFile(
      join(root, ".blame/runtime-tools/lima/limactl"),
      "generated\n",
    );
    await writeFile(
      join(root, "packages/desktop/out/main/index.js"),
      "generated\n",
    );
    const delta = await buildWorkspaceDeltaArtifact(root);
    assert.ok(delta.baseHash.match(/^[a-f0-9]{64}$/));
    const entries = await archiveEntries(delta.content);
    const manifest = JSON.parse(
      entries.get(".blame/delta-manifest.json")!.toString("utf8"),
    );
    assert.ok(manifest.finalHash.match(/^[a-f0-9]{64}$/));
    assert.deepEqual(manifest.changed.sort(), ["index.js", "new.txt"]);
    assert.deepEqual(manifest.deleted, []);
    assert.equal(entries.has("files/index.js"), true);
    assert.equal(entries.has("files/new.txt"), true);
    assert.equal(entries.has("files/.blame/runtime-tools/lima/limactl"), false);
    assert.equal(
      entries.has("files/packages/desktop/out/main/index.js"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves gitignored files out of deltas and declares the snapshot rule", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-source-policy-test-"));
  try {
    await exec("git", ["init", root]);
    await writeFile(
      join(root, ".gitignore"),
      "generated/\nnext-env.d.ts\nvendor/\n",
    );
    await writeFile(join(root, "index.js"), "console.log('base')\n");
    await mkdir(join(root, "vendor"));
    await writeFile(join(root, "vendor/lib.js"), "committed\n");
    await exec("git", ["-C", root, "add", ".gitignore", "index.js"]);
    await exec("git", ["-C", root, "add", "--force", "vendor/lib.js"]);
    await exec("git", [
      "-C",
      root,
      "-c",
      "user.name=Blame Test",
      "-c",
      "user.email=test@blame.so",
      "commit",
      "-m",
      "base",
    ]);
    await writeFile(join(root, "index.js"), "console.log('changed')\n");
    await mkdir(join(root, "generated"));
    await writeFile(join(root, "generated/client.ts"), "generated\n");
    await writeFile(join(root, "next-env.d.ts"), "generated\n");

    const delta = await buildWorkspaceDeltaArtifact(root);
    const entries = await archiveEntries(delta.content);
    const manifest = JSON.parse(
      entries.get(".blame/delta-manifest.json")!.toString("utf8"),
    );
    assert.equal(manifest.snapshotPolicy, "blameignore-v1");
    assert.deepEqual(manifest.changed, ["index.js"]);
    assert.deepEqual(manifest.deleted, []);

    const full = await buildWorkspaceArtifact(root);
    const source = JSON.parse(
      (await archiveEntries(full.content))
        .get(".blame/source-manifest.json")!
        .toString("utf8"),
    );
    assert.equal(source.snapshotPolicy, "blameignore-v1");
    assert.deepEqual(Object.keys(source.files).sort(), [
      ".gitignore",
      "index.js",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("builds an incremental delta against the last synchronized workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-source-live-delta-test-"));
  try {
    await exec("git", ["init", root]);
    await writeFile(join(root, "index.js"), "console.log('base')\n");
    await writeFile(join(root, "removed.txt"), "remove me\n");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", [
      "-C",
      root,
      "-c",
      "user.name=Blame Test",
      "-c",
      "user.email=test@blame.so",
      "commit",
      "-m",
      "base",
    ]);
    const base = await snapshotWorkspace(root);
    await writeFile(join(root, "index.js"), "console.log('live')\n");
    await writeFile(join(root, "new.txt"), "new\n");
    await unlink(join(root, "removed.txt"));

    const delta = await buildWorkspaceIncrementalDeltaArtifact(root, base);
    const entries = await archiveEntries(delta.content);
    const manifest = JSON.parse(
      entries.get(".blame/delta-manifest.json")!.toString("utf8"),
    );

    assert.equal(delta.baseHash, base.hash);
    assert.equal(manifest.baseHash, base.hash);
    assert.equal(manifest.finalHash, delta.workspaceHash);
    assert.deepEqual(delta.changed.sort(), ["index.js", "new.txt"]);
    assert.deepEqual(delta.deleted, ["removed.txt"]);
    assert.equal(
      entries.get("files/index.js")?.toString("utf8"),
      "console.log('live')\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [kind, build, prefix] of [
  ["full", buildWorkspaceArtifact, "workspace"],
  ["delta", buildWorkspaceDeltaArtifact, "files"],
] as const) {
  for (const latest of ["console.log('a longer final source')\n", "x\n"]) {
    test(`${kind} artifacts retry a changed prepared file (${latest.length} bytes)`, async () => {
      const root = await mkdtemp(join(tmpdir(), "blame-artifact-stale-"));
      try {
        await exec("git", ["init", "--quiet", root]);
        await writeFile(join(root, "index.js"), "base\n");
        await exec("git", ["-C", root, "add", "."]);
        await exec("git", [
          "-C",
          root,
          "-c",
          "user.name=Blame Test",
          "-c",
          "user.email=test@blame.so",
          "commit",
          "--quiet",
          "-m",
          "base",
        ]);
        await writeFile(join(root, "index.js"), "prepared source\n");
        const prepared = await prepareWorkspaceSource(root);
        await writeFile(join(root, "index.js"), latest);
        const expected = await snapshotWorkspace(root);

        const artifact = await build(root, prepared);

        assert.equal(artifact.workspaceHash, expected.hash);
        assert.equal(
          artifact.snapshot.files["index.js"]!.sha256,
          expected.files["index.js"]!.sha256,
        );
        assert.equal(
          (await archiveEntries(artifact.content))
            .get(`${prefix}/index.js`)
            ?.toString("utf8"),
          latest,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

function archiveEntries(content: Buffer) {
  return new Promise<Map<string, Buffer>>((resolve, reject) => {
    const entries = new Map<string, Buffer>();
    const archive = extract();
    archive.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.once("end", () => {
        entries.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.once("error", reject);
    });
    archive.once("finish", () => resolve(entries));
    archive.once("error", reject);
    Readable.from(gunzipSync(content)).pipe(archive);
  });
}
