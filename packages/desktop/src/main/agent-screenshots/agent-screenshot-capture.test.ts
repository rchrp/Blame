import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  modelImageTarget,
  storeResultScreenshots,
  type ImageCodec,
} from "./agent-screenshot-capture.ts";
import {
  AgentScreenshotStore,
  agentScreenshotId,
} from "./agent-screenshot-store.ts";

// The fake codec reads the size from the first bytes and "encodes" by
// returning a buffer of a chosen length, so each branch can be reached.
function fakeCodec(sizes: { jpeg: number; png: number }) {
  const calls: string[] = [];
  const codec: ImageCodec = {
    size: (data) => ({
      width: data.readUInt16BE(0),
      height: data.readUInt16BE(2),
    }),
    encode: (_data, target, format) => {
      calls.push(`${format}:${target.width}x${target.height}`);
      return Buffer.alloc(format === "png" ? sizes.png : sizes.jpeg, 1);
    },
  };
  return { calls, codec };
}

function image(width: number, height: number, bytes = 64) {
  const data = Buffer.alloc(bytes, 3);
  data.writeUInt16BE(width, 0);
  data.writeUInt16BE(height, 2);
  return data;
}

function result(data: Buffer) {
  return {
    content: [
      { type: "text", text: "Took a screenshot." },
      { type: "image", data: data.toString("base64"), mimeType: "image/png" },
    ],
  };
}

async function withStore(run: (store: AgentScreenshotStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "blame-capture-"));
  try {
    await run(new AgentScreenshotStore(root));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

const context = {
  page: {
    colorScheme: "dark" as const,
    url: "http://127.0.0.1:5173/settings/providers",
    viewport: { height: 900, width: 1440 },
  },
  runId: "run-1",
  scope: "story:1",
  sessionId: "session-1",
  toolCallId: "call-1",
};

test("model images stay within 1568 px on the longest side", () => {
  assert.deepEqual(modelImageTarget(1440, 900), { width: 1440, height: 900 });
  assert.deepEqual(modelImageTarget(2880, 1800), { width: 1568, height: 980 });
  assert.deepEqual(modelImageTarget(1440, 6000), { width: 376, height: 1568 });
});

test("stores the original and names it for the model", () =>
  withStore(async (store) => {
    const original = image(1440, 900);
    const { calls, codec } = fakeCodec({ jpeg: 10, png: 10 });
    const output = (await storeResultScreenshots(
      result(original),
      context,
      store,
      codec,
    )) as {
      content: Array<Record<string, string>>;
      _meta: Record<string, any>;
    };
    const id = agentScreenshotId(original);
    assert.deepEqual(calls, []);
    assert.equal(output.content[1].data, original.toString("base64"));
    assert.match(
      output.content.at(-1)!.text,
      new RegExp(`screenshot:${id} \\(1440×900, dark\\)`),
    );
    assert.equal(output._meta.blameScreenshots[0].id, id);
    assert.equal(output._meta.blameScreenshots[0].sessionId, "session-1");
    const stored = await store.read(id);
    assert.deepEqual(stored?.data, original);
    assert.equal(stored?.metadata.toolCallId, "call-1");
    assert.equal(stored?.metadata.runId, "run-1");
  }));

test("large captures reach the model resized, as JPEG when PNG stays heavy", () =>
  withStore(async (store) => {
    const original = image(2880, 1800);
    const heavy = fakeCodec({ jpeg: 1000, png: 2 * 1024 * 1024 });
    const output = (await storeResultScreenshots(
      result(original),
      context,
      store,
      heavy.codec,
    )) as { content: Array<Record<string, string>> };
    assert.deepEqual(heavy.calls, ["png:1568x980", "jpeg:1568x980"]);
    assert.equal(output.content[1].mimeType, "image/jpeg");
    assert.equal(
      (await store.read(agentScreenshotId(original)))?.metadata.width,
      2880,
    );

    const light = fakeCodec({ jpeg: 1000, png: 2000 });
    const small = (await storeResultScreenshots(
      result(image(2880, 1800, 80)),
      context,
      store,
      light.codec,
    )) as { content: Array<Record<string, string>> };
    assert.deepEqual(light.calls, ["png:1568x980"]);
    assert.equal(small.content[1].mimeType, "image/png");
  }));

test("results without images are returned unchanged", () =>
  withStore(async (store) => {
    const value = { content: [{ type: "text", text: "uid=1" }] };
    assert.equal(
      await storeResultScreenshots(
        value,
        context,
        store,
        fakeCodec({ jpeg: 1, png: 1 }).codec,
      ),
      value,
    );
  }));
