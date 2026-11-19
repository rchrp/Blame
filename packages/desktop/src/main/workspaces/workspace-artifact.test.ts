import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { extract, type Headers } from "tar-stream";
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
      // Committed and unchanged: the bundle carries it.
      assert.equal(entries.has("workspace/archives/keep.json"), false);
      const transport = await mkdtemp(join(tmpdir(), "blame-cloud-clone-"));
      try {
        const bundle = join(transport, "repository.bundle");
        const clone = join(transport, "checkout");
        await writeFile(bundle, entries.get(".blame/repository.bundle")!);
        await exec("git", [
          "clone",
          "--quiet",
          "--branch",
          "main",
          "--single-branch",
          bundle,
          clone,
        ]);
        await assert.rejects(readFile(join(clone, "archives/results.zip")), {
          code: "ENOENT",
        });
        assert.equal(
          await readFile(join(clone, "archives/keep.json"), "utf8"),
          "{}\n",
        );
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

test("snapshots hash again a file whose content changed, even with its old times", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-desktop-snapshot-"));
  try {
    const file = join(root, "page.ts");
    await writeFile(file, "export const a = 1;\n");
    const old = new Date(Date.now() - 60_000);
    await utimes(file, old, old);
    const first = await snapshotWorkspace(root);
    assert.equal((await snapshotWorkspace(root)).hash, first.hash);
    // Same size and modification time: only the change time differs.
    await writeFile(file, "export const b = 1;\n");
    await utimes(file, old, old);
    const changed = await snapshotWorkspace(root);
    assert.notEqual(changed.hash, first.hash);
    assert.equal(
      changed.files["page.ts"]!.sha256,
      createHash("sha256").update("export const b = 1;\n").digest("hex"),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

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

test("a full artifact carries only the files a clone of its bundle lacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-source-overlay-"));
  try {
    await committedRepository(root, {
      "index.js": "console.log('base')\n",
      "remove.js": "gone\n",
      "run.sh": "#!/bin/sh\n",
      "docs/readme.md": "# Docs\n",
    });
    await chmod(join(root, "run.sh"), 0o755);
    await exec("git", ["-C", root, "add", "run.sh"]);
    await commit(root, "executable");
    await writeFile(join(root, "index.js"), "console.log('story')\n");
    await unlink(join(root, "remove.js"));
    await writeFile(join(root, "new.txt"), "new\n");
    await chmod(join(root, "run.sh"), 0o644);

    const artifact = await buildWorkspaceArtifact(root);

    const overlay = [...(await archiveEntries(artifact.content)).keys()]
      .filter((name) => name.startsWith("workspace/"))
      .sort();
    assert.deepEqual(overlay, [
      "workspace/index.js",
      "workspace/new.txt",
      "workspace/run.sh",
    ]);
    assert.equal(
      await runnerWorkspaceHash(artifact.content, root),
      artifact.workspaceHash,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a full artifact carries the files Git converts on checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-source-attributes-"));
  try {
    await committedRepository(root, {
      ".gitattributes": "*.txt eol=crlf\nversion.c ident\n",
      "crlf.txt": "first\nsecond\n",
      "version.c": "// $Id$\n",
      "plain.md": "# Plain\n",
    });

    const artifact = await buildWorkspaceArtifact(root);

    const entries = await archiveEntries(artifact.content);
    assert.equal(entries.has("workspace/crlf.txt"), true);
    assert.equal(entries.has("workspace/version.c"), true);
    assert.equal(entries.has("workspace/plain.md"), false);
    assert.equal(entries.has("workspace/.gitattributes"), false);
    assert.equal(
      await runnerWorkspaceHash(artifact.content, root),
      artifact.workspaceHash,
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

async function committedRepository(
  root: string,
  files: Record<string, string>,
) {
  await exec("git", ["init", "--quiet", root]);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await exec("git", ["-C", root, "add", "."]);
  await commit(root, "base");
}

function commit(root: string, message: string) {
  return exec("git", [
    "-C",
    root,
    "-c",
    "user.name=Blame Test",
    "-c",
    "user.email=test@blame.so",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
}

// The sandbox runner's reconstruction of a full artifact: a clone of the
// bundle without Git configuration, the files the manifest does not list
// removed, the overlay copied on top. Returns the workspace hash.
async function runnerWorkspaceHash(content: Buffer, scratch: string) {
  const staging = await mkdtemp(join(scratch, ".runner-"));
  const entries = new Map<string, { header: Headers; content: Buffer }>();
  await new Promise<void>((resolve, reject) => {
    const archive = extract();
    archive.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.once("end", () => {
        entries.set(header.name, { header, content: Buffer.concat(chunks) });
        next();
      });
      stream.once("error", reject);
    });
    archive.once("finish", resolve);
    archive.once("error", reject);
    Readable.from(gunzipSync(content)).pipe(archive);
  });
  const bundle = join(staging, "repository.bundle");
  const workspace = join(staging, "workspace");
  await writeFile(bundle, entries.get(".blame/repository.bundle")!.content);
  await exec(
    "git",
    ["clone", "--quiet", "--branch", "main", bundle, workspace],
    {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
  const manifest = JSON.parse(
    entries.get(".blame/source-manifest.json")!.content.toString("utf8"),
  ) as { files: Record<string, unknown> };
  const { stdout } = await exec("git", ["-C", workspace, "ls-files", "-z"]);
  for (const path of stdout.split("\0").filter(Boolean))
    if (!manifest.files[path]) await unlink(join(workspace, path));
  for (const [name, entry] of entries) {
    if (!name.startsWith("workspace/")) continue;
    const target = join(workspace, name.slice("workspace/".length));
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { force: true });
    if (entry.header.type === "symlink")
      await symlink(entry.header.linkname!, target);
    else {
      await writeFile(target, entry.content);
      await chmod(target, entry.header.mode!);
    }
  }
  return (await snapshotWorkspace(workspace)).hash;
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
