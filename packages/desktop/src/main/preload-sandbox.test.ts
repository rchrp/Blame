import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import test from "node:test";

test("preload only imports Node modules supported by the sandbox", async () => {
  const preloadPath = new URL("../preload/index.ts", import.meta.url);
  const source = await readFile(preloadPath, "utf8");
  const importedModules = [
    ...source.matchAll(
      /(?:from\s+|import\s+|import\(|require\()\s*["']([^"']+)["']/g,
    ),
  ].map((match) => match[1]);
  const unsupportedModules = importedModules.filter((moduleName) => {
    const normalizedModuleName = moduleName.replace(/^node:/, "");
    return (
      builtinModules.includes(normalizedModuleName)
    );
  });

  assert.deepEqual(unsupportedModules, []);
});
