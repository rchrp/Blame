import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const script = new URL("./preview-image-pins.mjs", import.meta.url).pathname;
const imagesPath = "packages/preview-runtime/src/compose/blame-images.ts";
const runtimePaths = ["macos", "windows"].map(
  (platform) =>
    `packages/desktop/resources/runtime/${platform}/scripts/provision-blame-runtime.sh`,
);
const pins = Object.fromEntries(
  ["display", "node", "tauri"].map((kind, index) => [
    kind,
    `ghcr.io/blame/test-${kind}@sha256:${String(index + 1).repeat(64)}`,
  ]),
);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "preview-image-pins-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = new Map();
  for (const path of [imagesPath, ...runtimePaths]) {
    const content = await readFile(
      new URL(`../${path}`, import.meta.url),
      "utf8",
    );
    original.set(path, content);
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await mkdir(join(root, "pins"));
  for (const [kind, image] of Object.entries(pins))
    await writeFile(join(root, "pins", `${kind}.image`), `${image}\n`);
  return {
    root,
    original,
    run: () =>
      spawnSync(process.execPath, [script, "pins"], {
        cwd: root,
        encoding: "utf8",
      }),
  };
}

test("importing pins preserves the display image contract and is repeatable", async (t) => {
  const { root, original, run } = await fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const updated = await readFile(join(root, imagesPath), "utf8");
  const functionStart = "export function previewDisplayImage";
  assert.equal(
    updated.slice(updated.indexOf(functionStart)),
    original
      .get(imagesPath)
      .slice(original.get(imagesPath).indexOf(functionStart)),
  );
  const { publishedPreviewImages, previewDisplayImage } = await import(
    pathToFileURL(join(root, imagesPath)).href
  );
  assert.deepEqual(publishedPreviewImages, pins);
  assert.equal(previewDisplayImage(), pins.display);
  assert.equal(previewDisplayImage(pins.node), pins.node);
  assert.throws(() => previewDisplayImage("latest"), /published display image/);
  const previous = process.env.BLAME_PREVIEW_DISPLAY_IMAGE;
  try {
    publishedPreviewImages.display = undefined;
    process.env.BLAME_PREVIEW_DISPLAY_IMAGE = pins.display;
    assert.equal(previewDisplayImage(), pins.display);
  } finally {
    if (previous === undefined) delete process.env.BLAME_PREVIEW_DISPLAY_IMAGE;
    else process.env.BLAME_PREVIEW_DISPLAY_IMAGE = previous;
  }
  for (const path of runtimePaths)
    assert.ok(
      (await readFile(join(root, path), "utf8")).includes(
        `preview_display_image="${pins.display}"`,
      ),
    );
  assert.equal(run().status, 0);
  assert.equal(await readFile(join(root, imagesPath), "utf8"), updated);
});

test("invalid release pins leave all source files unchanged", async (t) => {
  const { root, original, run } = await fixture(t);
  await writeFile(
    join(root, "pins", "tauri.image"),
    "ghcr.io/blame/gui:latest\n",
  );
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid immutable tauri image/);
  for (const [path, content] of original)
    assert.equal(await readFile(join(root, path), "utf8"), content);
});

test("missing pin declarations fail before writing any source files", async (t) => {
  for (const path of [imagesPath, runtimePaths[1]]) {
    await t.test(path, async (t) => {
      const { root, original, run } = await fixture(t);
      await writeFile(join(root, path), "// No pin declaration.\n");
      original.set(path, "// No pin declaration.\n");
      const result = run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Cannot find/);
      for (const [file, content] of original)
        assert.equal(await readFile(join(root, file), "utf8"), content);
    });
  }
});
