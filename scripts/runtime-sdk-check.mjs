import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function verifyPackagedSdk(packageRoot, version) {
  if (!version) throw new Error("Expected Cline SDK version is required");
  const sdk = join(packageRoot, "node_modules/@cline/sdk");
  const core = join(packageRoot, "vendor/cline-core");
  for (const directory of [sdk, core]) {
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (manifest.version !== version) {
      throw new Error(`Incompatible SDK in ${directory}: expected ${version}, got ${manifest.version}`);
    }
    await access(join(directory, "dist/index.js"));
  }
  await access(join(core, "dist/blame-patch.json"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await verifyPackagedSdk(dirname(fileURLToPath(import.meta.url)), process.argv[2]);
}
