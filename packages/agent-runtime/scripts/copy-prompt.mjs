import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(packageRoot, "src", "prompt");
const target = join(packageRoot, "dist", "prompt");
const pluginSkillsSource = join(
  packageRoot,
  "src",
  "plugins",
  "blame-native",
  "skills",
);
const pluginSkillsTarget = join(
  packageRoot,
  "dist",
  "plugins",
  "blame-native",
  "skills",
);

rmSync(target, { force: true, recursive: true });
cpSync(source, target, { recursive: true });
rmSync(pluginSkillsTarget, { force: true, recursive: true });
cpSync(pluginSkillsSource, pluginSkillsTarget, { recursive: true });
