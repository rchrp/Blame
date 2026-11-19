import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunLogStore } from "./run-log-store.ts";

async function withStore(
  run: (store: RunLogStore, directory: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "run-log-store-"));
  try {
    await run(new RunLogStore(join(root, "run-logs")), join(root, "run-logs"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

const lines = Array.from(
  { length: 1_000 },
  (_, index) => `line ${index} ${"é🚀".repeat(index % 7)}`,
);

test("reads back any range of the lines appended, in batches of any size", async () => {
  await withStore(async (store) => {
    for (let index = 0; index < lines.length;) {
      const size = 1 + ((index * 37) % 290);
      store.append(
        "window:a",
        lines
          .slice(index, index + size)
          .map((line) => `${line}\n`)
          .join(""),
      );
      index += size;
    }
    for (const [from, to] of [
      [0, 1],
      [0, 100],
      [255, 257],
      [256, 512],
      [300, 700],
      [900, 1_000],
      [990, 2_000],
      [1_000, 1_100],
    ] as const)
      assert.deepEqual(
        await store.read("window:a", from, to),
        lines.slice(from, to),
      );
    assert.equal(
      await store.text("window:a"),
      lines.map((line) => `${line}\n`).join(""),
    );
  });
});

test("a read sees the lines appended before it", async () => {
  await withStore(async (store) => {
    store.append("window:a", "first\n");
    const first = store.read("window:a", 0, 10);
    store.append("window:a", "second\n");
    assert.deepEqual(await first, ["first"]);
    assert.deepEqual(await store.read("window:a", 0, 10), ["first", "second"]);
  });
});

test("closing a log, or a window's logs, removes their files", async () => {
  await withStore(async (store, directory) => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "left-by-a-crash.log"), "old\n");
    store.append("1:a", "a\n");
    store.append("1:b", "b\n");
    store.append("2:c", "c\n");
    assert.deepEqual(await store.read("2:c", 0, 1), ["c"]);
    assert.deepEqual((await readdir(directory)).sort(), [
      "1.log",
      "2.log",
      "3.log",
    ]);
    store.close("2:c");
    store.closeAll("1:");
    assert.deepEqual(await store.read("1:a", 0, 1), []);
    assert.equal(await store.text("2:c"), "");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await readdir(directory), []);
  });
});
