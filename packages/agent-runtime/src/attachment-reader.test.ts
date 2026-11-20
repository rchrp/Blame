import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAttachment } from "./attachment-reader.js";
import { readPdfAttachment } from "./attachment-pdf.js";
import { storeWorkspaceAttachment } from "./development-attachments.js";

const fixtures = new URL("../src/fixtures/attachments/", import.meta.url);

test("bounds text results and rejects unsupported files, traversal and symlink escapes", async () => {
  await fixture(async (root) => {
    const text = "a".repeat(20_000) + "end of document";
    const path = await store(root, "notes.md", Buffer.from(text));
    const first = await readAttachment(root, { path });
    assert.equal(first.status, "ok");
    if (first.status !== "ok") return;
    const data = first.data as {
      text: string;
      nextOffset: number;
      truncated: boolean;
    };
    assert.equal(data.text.length, 20_000);
    assert.equal(data.truncated, true);
    assert.match(
      JSON.stringify(
        await readAttachment(root, { path, offset: data.nextOffset }),
      ),
      /end of document/,
    );
    const outside = join(root, "private.txt");
    await writeFile(outside, "Not an attachment");
    assert.equal(
      (await readAttachment(root, { path: outside })).status,
      "blocked",
    );
    await symlink(outside, path + ".link");
    assert.equal(
      (await readAttachment(root, { path: path + ".link" })).status,
      "blocked",
    );
    const binary = await store(root, "audio.mp3", Buffer.from([0, 1, 255]));
    assert.equal(
      (await readAttachment(root, { path: binary })).status,
      "blocked",
    );
    const invalid = await store(root, "broken.pdf", Buffer.from("not a PDF"));
    assert.equal(
      (await readAttachment(root, { path: invalid })).status,
      "blocked",
    );
    const large = await store(
      root,
      "large.txt",
      Buffer.alloc(10 * 1024 * 1024 + 1),
    );
    assert.equal(
      (await readAttachment(root, { path: large })).status,
      "blocked",
    );
  });
});

test("cancels a PDF worker without breaking subsequent reads", async () => {
  const bytes = await readFile(new URL("report.pdf", fixtures));
  const controller = new AbortController();
  const pending = readPdfAttachment(bytes, 1, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  const result = await readPdfAttachment(bytes, 1);
  assert.match(result.text, /revenue is 42 EUR/);
});

function store(root: string, name: string, bytes: Buffer) {
  return storeWorkspaceAttachment(root, {
    name,
    contentBase64: bytes.toString("base64"),
  });
}

async function fixture(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "blame-attachment-reader-"));
  try {
    await action(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
