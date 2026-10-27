import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function checkJavaScript(source, name, format) {
  const result = spawnSync(process.execPath, ["--check", `--input-type=${format}`], {
    input: source,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Invalid generated JavaScript in ${name}:\n${result.stderr}`);
}

export async function checkGeneratedJavaScript(output) {
  let count = 0;
  async function checkDirectory(directory, format) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await checkDirectory(path, format);
      else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) {
        checkJavaScript(await readFile(path, "utf8"), path, format);
        count++;
      }
    }
  }
  await checkDirectory(join(output, "main"), "module");
  await checkDirectory(join(output, "preload"), "commonjs");
  if (!count) throw new Error(`No generated JavaScript found in ${output}`);
  console.log(`Verified syntax of ${count} generated main/preload files`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await checkGeneratedJavaScript(resolve(import.meta.dirname, "../out"));
}
