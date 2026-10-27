import { readFile, writeFile } from "node:fs/promises";
import YAML from "yaml";

// A production deploy omits renderer/build dependencies, whose patches still
// belong in the workspace install. pnpm 12's legacy deploy reads this setting
// from the workspace file, not from --config or npm_config_* overrides.
export async function withDeploymentConfig(
  workspaceFile,
  supportedArchitectures,
  deploy,
) {
  const original = await readFile(workspaceFile, "utf8");
  const config = YAML.parse(original);
  config.allowUnusedPatches = true;
  if (supportedArchitectures) {
    config.supportedArchitectures = supportedArchitectures;
    if (
      !supportedArchitectures.os.includes(process.platform) ||
      !supportedArchitectures.cpu.includes(process.arch)
    ) {
      // Cross-packages carry target binaries; pnpm's install script tries
      // to link a host binary that deliberately is not installed there.
      config.allowBuilds = { ...config.allowBuilds, pnpm: false };
    }
  }
  try {
    await writeFile(workspaceFile, YAML.stringify(config), "utf8");
    return await deploy();
  } finally {
    // Keep normal installs strict, and preserve comments and formatting.
    await writeFile(workspaceFile, original, "utf8");
  }
}
