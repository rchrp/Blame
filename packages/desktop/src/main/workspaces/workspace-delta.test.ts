import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { createGzip } from "node:zlib";
import { pack } from "tar-stream";
import { applyWorkspaceDelta } from "./workspace-delta.ts";
import { snapshotWorkspace } from "./workspace-snapshot.ts";

test("applies a checked workspace delta and detects concurrent local edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-delta-test-"));
  try {
    await writeFile(join(root, "file.bin"), Buffer.from([0, 1, 2]), {
      mode: 0o600,
    });
    const base = await snapshotWorkspace(root);
    const nextContent = Buffer.from([9, 8, 7, 6]);
    await writeFile(join(root, "file.bin"), nextContent, { mode: 0o755 });
    const final = await snapshotWorkspace(root);
    await writeFile(join(root, "file.bin"), Buffer.from([0, 1, 2]), {
      mode: 0o600,
    });
    const archive = await deltaArchive(
      {
        version: 1,
        generation: 7,
        revision: "1",
        baseHash: base.hash,
        finalHash: final.hash,
        changed: ["file.bin"],
        deleted: [],
        files: { "file.bin": final.files["file.bin"]! },
        baseFiles: { "file.bin": base.files["file.bin"]! },
      },
      nextContent,
    );
    const result = await applyWorkspaceDelta({
      root,
      content: archive,
      size: archive.byteLength,
      sha256: createHash("sha256").update(archive).digest("hex"),
      expectedBaseHash: base.hash,
      expectedFinalHash: final.hash,
      expectedGeneration: 7,
    });
    assert.equal(result.finalHash, final.hash);
    assert.deepEqual(await readFile(join(root, "file.bin")), nextContent);
    await assert.rejects(
      () =>
        applyWorkspaceDelta({
          root,
          content: archive,
          size: archive.byteLength,
          sha256: createHash("sha256").update(archive).digest("hex"),
        }),
      /changed during the remote writer lease/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects deltas that target credential or repository metadata paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-delta-forbidden-test-"));
  try {
    const base = await snapshotWorkspace(root);
    const content = Buffer.from("SECRET=never-write\n");
    const metadata = {
      type: "file" as const,
      sha256: createHash("sha256").update(content).digest("hex"),
      mode: 0o600,
      size: content.byteLength,
    };
    const archive = await deltaArchive(
      {
        version: 1,
        generation: 1,
        revision: "1",
        baseHash: base.hash,
        finalHash: "0".repeat(64),
        changed: [".env"],
        deleted: [],
        files: { ".env": metadata },
        baseFiles: { ".env": null },
      },
      content,
      ".env",
    );
    await assert.rejects(
      () =>
        applyWorkspaceDelta({
          root,
          content: archive,
          size: archive.byteLength,
          sha256: createHash("sha256").update(archive).digest("hex"),
        }),
      /forbidden path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applies a gitignore-v1 delta beside generated local files", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-delta-policy-test-"));
  try {
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await writeFile(join(root, "page.tsx"), "base\n");
    await mkdir(join(root, "generated"));
    await writeFile(join(root, "generated/client.ts"), "local build\n");
    const base = await snapshotWorkspace(root, "gitignore-v1");
    const nextContent = Buffer.from("remote\n");
    await writeFile(join(root, "page.tsx"), nextContent);
    const final = await snapshotWorkspace(root, "gitignore-v1");
    await writeFile(join(root, "page.tsx"), "base\n");
    assert.notEqual((await snapshotWorkspace(root, "legacy")).hash, base.hash);
    const archive = await deltaArchive(
      {
        version: 1,
        snapshotPolicy: "gitignore-v1",
        generation: 1,
        revision: "1",
        baseHash: base.hash,
        finalHash: final.hash,
        changed: ["page.tsx"],
        deleted: [],
        files: { "page.tsx": final.files["page.tsx"]! },
        baseFiles: { "page.tsx": base.files["page.tsx"]! },
      },
      nextContent,
      "page.tsx",
    );
    const result = await applyWorkspaceDelta({
      root,
      content: archive,
      size: archive.byteLength,
      sha256: createHash("sha256").update(archive).digest("hex"),
    });
    assert.equal(result.finalHash, final.hash);
    assert.equal(
      await readFile(join(root, "generated/client.ts"), "utf8"),
      "local build\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function deltaArchive(
  manifest: object,
  content: Buffer,
  path = "file.bin",
) {
  const archive = pack();
  const chunks: Buffer[] = [];
  const gzip = createGzip();
  gzip.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const writing = pipeline(archive, gzip);
  archive.entry(
    { name: ".blame/delta-manifest.json" },
    JSON.stringify(manifest),
  );
  archive.entry(
    { name: `files/${path}`, size: content.byteLength, mode: 0o755 },
    content,
  );
  archive.finalize();
  await writing;
  return Buffer.concat(chunks);
}
