import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import test from "node:test";
import { pack } from "tar-stream";
import { runtimePaths } from "../runtime-paths.js";
import {
  checkpointChangeJournal,
  initializeChangeJournal,
  readChangeJournal,
} from "./change-journal.js";
import { importSourceArtifact } from "./source-importer.js";
import {
  snapshotWorkspace,
  writeWorkspaceSnapshotPolicy,
} from "./workspace-snapshot.js";

const paths = runtimePaths as unknown as Record<string, string>;

async function sandbox(context: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "blame-journal-"));
  const original = { ...paths };
  paths.workspace = join(root, "workspace");
  paths.journal = join(root, "journal/state.json");
  paths.journalLock = join(root, "journal/lock");
  paths.snapshotPolicy = join(root, "runtime/snapshot-policy");
  paths.runtimeState = join(root, "runtime/state.json");
  await mkdir(paths.workspace!, { recursive: true });
  await writeFile(join(paths.workspace!, "page.tsx"), "base\n");
  await writeFile(join(paths.workspace!, "schema.rb"), "version 1\n");
  context.after(async () => {
    Object.assign(paths, original);
    await rm(root, { recursive: true, force: true });
  });
  return paths.workspace!;
}

test("tool rewrites become drift instead of work to export", async (context) => {
  const workspace = await sandbox(context);
  const initial = await initializeChangeJournal();

  await writeFile(join(workspace, "schema.rb"), "version 2 by a migration\n");
  let journal = await checkpointChangeJournal();
  assert.equal(journal.revision, 0);
  assert.equal(journal.current.hash, initial.current.hash);
  assert.deepEqual(Object.keys(journal.drift ?? {}), ["schema.rb"]);

  await writeFile(join(workspace, "schema.rb"), "version 1\n");
  journal = await checkpointChangeJournal();
  assert.deepEqual(journal.drift, {});

  await writeFile(join(workspace, "schema.rb"), "version 2 by a migration\n");
  await checkpointChangeJournal();
  await writeFile(join(workspace, "notes.md"), "written by a remote writer\n");
  journal = await checkpointChangeJournal({ attribute: true });
  assert.equal(journal.revision, 1);
  assert.ok(journal.current.files["notes.md"]);
  assert.deepEqual(Object.keys(journal.drift ?? {}), ["schema.rb"]);
  assert.equal((await readChangeJournal()).revision, 1);
});

test("a local delta applies over drift and keeps the tool's file", async (context) => {
  const workspace = await sandbox(context);
  await initializeChangeJournal();
  const base = await snapshotWorkspace(workspace, "legacy");
  await writeFile(join(workspace, "page.tsx"), "changed locally\n");
  const final = await snapshotWorkspace(workspace, "legacy");
  await writeFile(join(workspace, "page.tsx"), "base\n");
  await writeFile(join(workspace, "schema.rb"), "version 2 by a migration\n");

  const archive = await deltaArchive({
    version: 1,
    baseHash: base.hash,
    finalHash: final.hash,
    changed: ["page.tsx"],
    deleted: [],
    files: { "page.tsx": final.files["page.tsx"] },
  });
  context.mock.method(globalThis, "fetch", async () => new Response(archive));
  const result = await importSourceArtifact({
    id: "delta",
    mode: "delta",
    revision: "1",
    downloadUrl: "https://artifacts.example/delta",
    sha256: createHash("sha256").update(archive).digest("hex"),
    size: archive.byteLength,
    baseHash: base.hash,
    workspaceHash: final.hash,
  });

  assert.equal(result.workspaceHash, final.hash);
  assert.equal(
    await readFile(join(workspace, "page.tsx"), "utf8"),
    "changed locally\n",
  );
  assert.equal(
    await readFile(join(workspace, "schema.rb"), "utf8"),
    "version 2 by a migration\n",
  );
  assert.deepEqual(Object.keys((await readChangeJournal()).drift ?? {}), [
    "schema.rb",
  ]);
});

test("cloud exclusions stay out of the journal while manual exceptions remain exportable", async (context) => {
  const workspace = await sandbox(context);
  await writeWorkspaceSnapshotPolicy("blameignore-v1");
  await mkdir(join(workspace, "archives"));
  await writeFile(
    join(workspace, ".blameignore"),
    "/archives/**\n!/archives/keep.json\n",
  );
  await writeFile(join(workspace, "archives/results.zip"), "old archive");
  await writeFile(join(workspace, "archives/keep.json"), "old fixture");
  const initial = await initializeChangeJournal();
  await writeFile(join(workspace, "archives/results.zip"), "new archive");
  const unchanged = await checkpointChangeJournal({ attribute: true });
  assert.equal(unchanged.current.hash, initial.current.hash);
  assert.equal(unchanged.revision, 0);
  await writeFile(join(workspace, "archives/keep.json"), "new fixture");
  const changed = await checkpointChangeJournal({ attribute: true });
  assert.equal(changed.revision, 1);
  assert.ok(changed.current.files["archives/keep.json"]);
  assert.equal(changed.current.files["archives/results.zip"], undefined);
});

test("a local exclusion update removes the old remote copy and verifies the new hash", async (context) => {
  const workspace = await sandbox(context);
  await writeWorkspaceSnapshotPolicy("blameignore-v1");
  await mkdir(join(workspace, "archives"));
  await writeFile(join(workspace, ".blameignore"), "");
  await writeFile(join(workspace, "archives/results.zip"), "archive");
  const base = (await initializeChangeJournal()).current;
  const rules = "/archives/**\n";
  await writeFile(join(workspace, ".blameignore"), rules);
  const final = await snapshotWorkspace();
  await writeFile(join(workspace, ".blameignore"), "");
  const archive = await deltaArchive(
    {
      version: 1,
      snapshotPolicy: "blameignore-v1",
      baseHash: base.hash,
      finalHash: final.hash,
      changed: [".blameignore"],
      deleted: ["archives/results.zip"],
      files: { ".blameignore": final.files[".blameignore"] },
    },
    { ".blameignore": rules },
  );
  context.mock.method(globalThis, "fetch", async () => new Response(archive));
  const result = await importSourceArtifact({
    id: "delta",
    mode: "delta",
    revision: "1",
    downloadUrl: "https://artifacts.example/delta",
    sha256: createHash("sha256").update(archive).digest("hex"),
    size: archive.byteLength,
    baseHash: base.hash,
    workspaceHash: final.hash,
  });
  assert.equal(result.workspaceHash, final.hash);
  await assert.rejects(readFile(join(workspace, "archives/results.zip")), {
    code: "ENOENT",
  });
  assert.equal(await readFile(join(workspace, ".blameignore"), "utf8"), rules);
});

async function deltaArchive(
  manifest: object,
  files = { "page.tsx": "changed locally\n" } as Record<string, string>,
) {
  const archive = pack();
  const chunks: Buffer[] = [];
  const gzip = createGzip();
  gzip.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const writing = pipeline(archive, gzip);
  archive.entry(
    { name: ".blame/delta-manifest.json" },
    JSON.stringify(manifest),
  );
  for (const [path, content] of Object.entries(files))
    archive.entry({ name: `files/${path}`, mode: 0o644 }, content);
  archive.finalize();
  await writing;
  return Buffer.concat(chunks);
}
