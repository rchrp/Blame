import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The sandbox runner the API starts, kept in the repository so the control
// plane and its runner change in the same commit. The release workflow
// rewrites this file and opens a pull request with it.
export const runnerPinPath = fileURLToPath(
  new URL("../packages/api/config/sandbox_runner_pin.ts", import.meta.url),
);

export function runnerPinSource(image, version) {
  if (!/^[a-z0-9.\-/:_]+@sha256:[a-f0-9]{64}$/.test(image ?? ""))
    throw new Error("The runner image must be pinned by sha256 digest");
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ""))
    throw new Error("The runner version must use semantic versioning");
  return `// Written by the "Release sandbox runner" workflow; see RELEASING.md.
// BLAME_SANDBOX_RUNNER_IMAGE and BLAME_SANDBOX_RUNNER_VERSION override it.
export const sandboxRunnerPin: { image?: string; version: string } = {
  image:
    '${image}',
  version: '${version}',
}
`;
}

export async function writeRunnerPin(image, version, path = runnerPinPath) {
  await writeFile(path, runnerPinSource(image, version));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [image, version] = process.argv.slice(2);
  await writeRunnerPin(image, version);
  console.log(`Pinned sandbox runner ${version}: ${image}`);
}
