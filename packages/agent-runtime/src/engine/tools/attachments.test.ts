import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAttachment } from "../../attachment-reader.js";
import { storeWorkspaceAttachment } from "../../development-attachments.js";
import { executeLightWorkspaceRequest } from "../../harness/light-executor.js";
import type { ClientTool } from "../tool.js";
import { attachmentTool } from "./attachments.js";
import { callThroughToolSet, toolContext } from "./testing.js";

const fixtures = new URL("../../../src/fixtures/attachments/", import.meta.url);

async function read(tool: ClientTool<never>, input: Record<string, unknown>) {
  const output = await tool.run(input as never, toolContext());
  return (output as { json: unknown }).json;
}

for (const executor of [undefined, executeLightWorkspaceRequest]) {
  test(`reads original documents through ${executor ? "the workspace bridge" : "the local tool"}`, async () => {
    await fixture(async (root) => {
      const tool = attachmentTool(root, executor)!;
      for (const [name, expected] of [
        ["report.pdf", "revenue is 42 EUR"],
        ["report.docx", "owner is Alice"],
        ["report.xlsx", "Travel\t42"],
      ]) {
        const bytes = await readFile(new URL(name!, fixtures));
        const path = await store(root, name!, bytes);
        const result = (await read(tool, { path })) as {
          status: string;
          data: { text: string; pages?: number };
        };
        assert.equal(result.status, "ok", JSON.stringify(result));
        assert.ok(result.data.text.includes(expected!), result.data.text);
        assert.deepEqual(await readFile(path), bytes);
        if (name === "report.pdf") {
          assert.equal(result.data.pages, 2);
          const second = await read(tool, { path, page: 2 });
          assert.match(JSON.stringify(second), /deadline is Friday/);
          assert.equal(
            (await readAttachment(root, { path, page: 3 })).status,
            "blocked",
          );
        }
        if (name === "report.xlsx")
          assert.match(
            JSON.stringify(await read(tool, { path, sheet: "Schedule" })),
            /Friday/,
          );
      }
    });
  });
}

test("the tool set refuses to read a developer env file, not its example", async () => {
  await fixture(async (root) => {
    const tool = attachmentTool(root)!;
    const blocked = await callThroughToolSet([tool], "read_attachment", {
      path: "apps/api/.env.local",
    });
    assert.equal(blocked.outcome, "failed");
    assert.match(
      JSON.stringify(blocked.content),
      /keeps the values of apps\/api\/\.env\.local/,
    );
    const example = await callThroughToolSet([tool], "read_attachment", {
      path: ".env.example",
    });
    assert.equal(example.outcome, "completed");
    assert.match(JSON.stringify(example.content), /blocked/);
  });
});

test("reads PDF, DOCX and XLSX documents anywhere in the workspace, but not beyond it", async () => {
  await fixture(async (root) => {
    const bytes = await readFile(new URL("report.pdf", fixtures));
    await mkdir(join(root, "hw1"));
    await writeFile(join(root, "hw1", "HW 1 - report.pdf"), bytes);
    const tool = attachmentTool(root, executeLightWorkspaceRequest)!;
    assert.match(
      JSON.stringify(await read(tool, { path: "hw1/HW 1 - report.pdf" })),
      /revenue is 42 EUR/,
    );
    assert.match(
      JSON.stringify(
        await readAttachment(root, {
          path: join(root, "hw1/HW 1 - report.pdf"),
        }),
      ),
      /revenue is 42 EUR/,
    );
    const docx = await readFile(new URL("report.docx", fixtures));
    await writeFile(join(root, "notes.docx"), docx);
    assert.match(
      JSON.stringify(await readAttachment(root, { path: "notes.docx" })),
      /owner is Alice/,
    );
    const elsewhere = await mkdtemp(join(tmpdir(), "blame-outside-"));
    try {
      const outside = join(elsewhere, "secret.pdf");
      await writeFile(outside, bytes);
      assert.equal(
        (await readAttachment(root, { path: outside })).status,
        "blocked",
      );
      await symlink(outside, join(root, "linked.pdf"));
      assert.equal(
        (await readAttachment(root, { path: "linked.pdf" })).status,
        "blocked",
      );
    } finally {
      await rm(elsewhere, { force: true, recursive: true });
    }
  });
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
