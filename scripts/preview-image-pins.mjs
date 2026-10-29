import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.argv[2];
if (!directory)
  throw new Error(
    "Pass the directory containing the three released .image files.",
  );
const pins = {};
for (const kind of ["display", "node", "tauri"]) {
  const image = (
    await readFile(join(directory, `${kind}.image`), "utf8")
  ).trim();
  if (!/^ghcr\.io\/[a-z0-9_.\/-]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error(`Invalid immutable ${kind} image.`);
  pins[kind] = image;
}
const updates = new Map();
const imagesPath = "packages/preview-runtime/src/compose/blame-images.ts";
const source = await readFile(imagesPath, "utf8");
const declaration =
  /^(export const publishedPreviewImages\b[\s\S]*?=\s*)\{[\s\S]*?^\}/m;
if (!declaration.test(source))
  throw new Error(`Cannot find the preview image pins in ${imagesPath}.`);
updates.set(
  imagesPath,
  source.replace(
    declaration,
    (_, prefix) => `${prefix}${JSON.stringify(pins, null, 2)}`,
  ),
);

for (const platform of ["macos", "windows"]) {
  const path = `packages/desktop/resources/runtime/${platform}/scripts/provision-blame-runtime.sh`;
  const source = await readFile(path, "utf8");
  const assignment = /^preview_display_image=".*"/m;
  if (!assignment.test(source))
    throw new Error(`Cannot find the display image pin in ${path}.`);
  updates.set(
    path,
    source.replace(assignment, `preview_display_image="${pins.display}"`),
  );
}

for (const [path, content] of updates) await writeFile(path, content);
