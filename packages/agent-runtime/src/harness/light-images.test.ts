import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import type { AgentToolContext, ToolResultContent } from "@cline/sdk";
import { projectProviderContext } from "../context-projection.js";
import { unwrapFeedbackEnvelope } from "../tool-result-envelope.js";
import { executeLightWorkspaceRequest } from "./light-executor.js";
import { lightSemanticHarnessTools } from "./light-tools.js";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlL8AAAAASUVORK5CYII=", "base64");
const context: AgentToolContext = { agentId: "image-reader", iteration: 1, metadata: { modelSupportsImages: true } };

for (const executor of [undefined, executeLightWorkspaceRequest]) {
  test(`image reads reach the provider as media through ${executor ? "the bridge" : "local execution"}`, async () => {
    await fixture(async (root) => {
      const tool = lightSemanticHarnessTools(root, { executor }).find((tool) => tool.name === "read_code")!;
      const output = await tool.execute({ target: "pixel.png" }, context);
      assert.ok(Array.isArray(output));
      assert.deepEqual(output[1], { type: "image", mediaType: "image/png", data: pixel.toString("base64") });
      assert.doesNotMatch(output[0].text, /base64|�/);
      const content: ToolResultContent = { type: "tool_result", tool_use_id: "image-1", name: "read_code", content: output };
      const result = projectProviderContext([{ role: "user", content: [content] }], { systemPrompt: "", tools: [] });
      assert.deepEqual(result.messages[0]?.content, [content]);
    });
  });
}

test("image reads fail clearly when the model has no image capability", async () => {
  await fixture(async (root) => {
    for (const metadata of [undefined, { modelSupportsImages: false }]) {
      const result = await read(root, "pixel.png", { ...context, metadata });
      assert.equal(result.status, "blocked");
      assert.match(String(result.message), /does not support image input/);
      assert.equal(result.content, undefined);
    }
  });
});

test("mislabeled and oversized images never become provider image blocks", async () => {
  await fixture(async (root) => {
    await writeFile(join(root, "invalid.png"), "this is text");
    assert.equal((await read(root, "invalid.png")).status, "blocked");
    const file = await open(join(root, "pixel.png"), "r+");
    try { await file.truncate(10_000_001); } finally { await file.close(); }
    const result = await read(root, "pixel.png");
    assert.equal(result.status, "blocked");
    assert.match(String(result.message), /encoded image limit/);
  });
});

test("image reads retain workspace and symlink boundaries", async () => {
  await fixture(async (root) => {
    assert.equal((await read(root, "../outside.png")).status, "blocked");
    if (process.platform !== "win32") {
      await symlink(join(root, "pixel.png"), join(root, "linked.png"));
      assert.equal((await read(root, "linked.png")).status, "blocked");
    }
  });
});

async function read(root: string, target: string, inputContext = context) {
  const tool = lightSemanticHarnessTools(root).find((tool) => tool.name === "read_code")!;
  // Results with source text come in the model-facing multipart form.
  return unwrapFeedbackEnvelope(await tool.execute({ target }, inputContext)) as Record<string, unknown>;
}

async function fixture(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "blame-image-read-"));
  try {
    await writeFile(join(root, "pixel.png"), pixel);
    await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const executor of [undefined, executeLightWorkspaceRequest]) {
  test(`explicit isolation permits external image reads through ${executor ? "the bridge" : "local execution"}`, async () => {
    await outsideImageFixture(async (root, outside) => {
      const tools = isolatedImageTools(root, executor);
      const output = await tools.find((tool) => tool.name === "read_code")!.execute({ target: outside }, context);
      assert.ok(Array.isArray(output));
      assert.equal(output[1].data, pixel.toString("base64"));
      const edit = await tools.find((tool) => tool.name === "edit_code")!.execute({
        operations: [{ kind: "patch", path: outside, patch: "replacement" }],
      }, context) as Record<string, unknown>;
      assert.equal(edit.status, "blocked");
      assert.deepEqual(await readFile(outside), pixel);
    });
  });
}

test("external image reads preserve host boundaries and require absolute paths", async () => {
  await outsideImageFixture(async (root, outside) => {
    assert.equal((await read(root, outside)).status, "blocked");
    const tools = isolatedImageTools(root);
    const reader = tools.find((tool) => tool.name === "read_code")!;
    const output = await reader.execute({ target: relative(root, outside) }, context) as Record<string, unknown>;
    assert.equal(output.status, "blocked");
    await writeFile(outside.replace(".png", ".txt"), "external text");
    const text = await reader.execute({ target: outside.replace(".png", ".txt") }, context) as Record<string, unknown>;
    assert.equal(text.status, "blocked");
  });
});

test("external image reads preserve model capability and symlink validation", async () => {
  await outsideImageFixture(async (root, outside) => {
    const reader = isolatedImageTools(root).find((tool) => tool.name === "read_code")!;
    const unsupported = await reader.execute({ target: outside }, { ...context, metadata: { modelSupportsImages: false } }) as Record<string, unknown>;
    assert.equal(unsupported.status, "blocked");
    assert.match(String(unsupported.message), /does not support image input/);
    if (process.platform === "win32") return;
    const linked = outside.replace(".png", "-link.png");
    await symlink(outside, linked);
    const output = await reader.execute({ target: linked }, context) as Record<string, unknown>;
    assert.equal(output.status, "blocked");
  });
});

test("image reader rejects a file exceeding the SDK encoded-image budget", async () => {
  await fixture(async (root) => {
    const file = await open(join(root, "pixel.png"), "r+");
    try { await file.truncate(4 * 1024 * 1024); } finally { await file.close(); }
    const output = await read(root, "pixel.png");
    assert.equal(output.status, "blocked");
    assert.match(String(output.message), /encoded image limit/);
  });
});

function isolatedImageTools(root: string, executor?: typeof executeLightWorkspaceRequest) {
  return lightSemanticHarnessTools(root, {
    executor,
    taskContract: { session_id: "isolated-image-reader", environment: { isolated: true, managedPreview: false } },
  });
}

async function outsideImageFixture(action: (root: string, outside: string) => Promise<void>) {
  const outsideRoot = await mkdtemp(join(tmpdir(), "blame-external-image-"));
  const outside = join(outsideRoot, "external.png");
  try {
    await writeFile(outside, pixel);
    await fixture((root) => action(root, outside));
  } finally {
    await rm(outsideRoot, { recursive: true, force: true });
  }
}

for (const [name, content] of [
  ["binary.dat", Buffer.from([0, 65, 66])],
  ["invalid.txt", Buffer.from([0xff, 0xfe, 65])],
  ["document.pdf", Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF")],
] as const) {
  test(`source reads reject binary or PDF bytes in ${name}`, async () => {
    await fixture(async (root) => {
      await writeFile(join(root, name), content);
      const output = await read(root, name);
      assert.equal(output.status, "blocked");
      assert.match(String(output.message), /read_attachment/);
    });
  });
}

test("source reads preserve ordinary UTF-8 configuration content", async () => {
  await fixture(async (root) => {
    const content = "\uFEFFlabel = café 🐈\npattern = \\0\n";
    await writeFile(join(root, "settings.ini"), content);
    const output = await read(root, "settings.ini");
    assert.equal(output.status, "ok");
    assert.ok(JSON.stringify(output).includes("café 🐈"));
  });
});
