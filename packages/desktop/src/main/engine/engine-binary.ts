import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const executable = process.platform === "win32" ? "blame-engine.exe" : "blame-engine";

/**
 * The one place that finds the `blame-engine` binary. `BLAME_ENGINE_BIN`
 * wins; in development it is the Cargo build of this checkout (release
 * first, then debug). Packaging it with the app is a later step: a packaged
 * app without the variable has no engine yet.
 */
export function engineBinaryPath(input: {
  applicationPath: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): string | undefined {
  const env = input.env ?? process.env;
  const exists = input.exists ?? existsSync;
  const configured = env.BLAME_ENGINE_BIN?.trim();
  if (configured) return configured;
  // The desktop package sits at packages/desktop in the repository.
  const repository = resolve(input.applicationPath, "../..");
  return ["release", "debug"]
    .map((profile) => join(repository, "target", profile, executable))
    .find(exists);
}
