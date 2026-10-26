import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentToolContext } from "@cline/sdk";
import { attachmentTools } from "./attachment-tools.js";
import { readAttachment } from "./attachment-reader.js";
import { readPdfAttachment } from "./attachment-pdf.js";
import { storeWorkspaceAttachment } from "./development-attachments.js";
import { executeLightWorkspaceRequest } from "./harness/light-executor.js";
import {
  developmentUserInput,
  newAttachmentDirectory,
} from "./cline-runtime-prompts.js";

const context = {
  sessionId: "attachment-test",
  toolCallId: "read-1",
} as AgentToolContext;
const fixtures = new URL("../src/fixtures/attachments/", import.meta.url);

for (const executor of [undefined, executeLightWorkspaceRequest]) {
  test(`reads original documents through ${executor ? "the workspace bridge" : "the local tool"}`, async () => {
    await fixture(async (root) => {
      const tool = attachmentTools(root, executor)[0]!;
      for (const [name, expected] of [
        ["report.pdf", "revenue is 42 EUR"],
        ["report.docx", "owner is Alice"],
        ["report.xlsx", "Travel\t42"],
      ]) {
        const bytes = await readFile(new URL(name!, fixtures));
        const path = await store(root, name!, bytes);
        const result = (await tool.execute({ path }, context)) as {
          status: string;
          data: { text: string; pages?: number };
        };
        assert.equal(result.status, "ok", JSON.stringify(result));
        assert.ok(result.data.text.includes(expected!), result.data.text);
        assert.deepEqual(await readFile(path), bytes);
        if (name === "report.pdf") {
          assert.equal(result.data.pages, 2);
          const second = await tool.execute({ path, page: 2 }, context);
          assert.match(JSON.stringify(second), /deadline is Friday/);
          assert.equal(
            (await readAttachment(root, { path, page: 3 })).status,
            "blocked",
          );
        }
        if (name === "report.xlsx")
          assert.match(
            JSON.stringify(
              await tool.execute({ path, sheet: "Schedule" }, context),
            ),
            /Friday/,
          );
      }
    });
  });
}

test("feedback prompts point at readable originals without embedding document contents", async () => {
  await fixture(async (root) => {
    const content = await readFile(new URL("report.pdf", fixtures));
    const input = await developmentUserInput(
      {
        title: "Review",
        summary: "Read",
        feedbackOnly: true,
        feedback: "Can you read this file?",
        feedbackFileAttachments: [
          {
            name: "report.pdf",
            size: content.length,
            type: "application/pdf",
            content: content.toString("base64"),
          },
        ],
      },
      newAttachmentDirectory(root),
    );
    assert.ok(input.prompt.includes(input.userFiles[0]!));
    assert.match(input.prompt, /read_attachment/);
    assert.doesNotMatch(input.prompt, /revenue is 42|JVBER/);
    assert.match(
      JSON.stringify(await readAttachment(root, { path: input.userFiles[0] })),
      /revenue is 42/,
    );
  });
});

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
