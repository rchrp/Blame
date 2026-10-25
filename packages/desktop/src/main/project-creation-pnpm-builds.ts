import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument, type Document } from "yaml";
import type { NewProjectConfiguration } from "./project-creation.ts";

const legacyKeys = [
  "onlyBuiltDependencies",
  "ignoredBuiltDependencies",
  "neverBuiltDependencies",
] as const;

export function generatedProjectBuildDependencies(
  configuration: NewProjectConfiguration,
) {
  return [
    "esbuild",
    "unrs-resolver",
    ...(configuration.frontend === "next" ? ["sharp"] : []),
    ...(configuration.orm === "prisma"
      ? ["@prisma/client", "@prisma/engines", "prisma"]
      : []),
    ...(configuration.database === "sqlite" ? ["better-sqlite3"] : []),
    ...(configuration.advancedOptions.includes("auth") ? ["msw"] : []),
  ].sort();
}

/** Prepare only the known starter's build scripts, preserving explicit decisions. */
export async function prepareGeneratedProjectPnpmBuilds(
  cwd: string,
  configuration: NewProjectConfiguration,
) {
  const manifestPath = join(cwd, "package.json");
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  const workspacePath = join(cwd, "pnpm-workspace.yaml");
  const workspaceText = existsSync(workspacePath)
    ? await readFile(workspacePath, "utf8")
    : "";
  const document: Document = parseDocument(workspaceText);
  if (document.errors.length)
    throw new Error(
      `Invalid pnpm-workspace.yaml: ${document.errors[0]!.message}`,
    );
  const workspace = document.toJS() ?? {};
  if (typeof workspace !== "object" || Array.isArray(workspace)) {
    throw new Error("pnpm-workspace.yaml must contain a settings object.");
  }
  if (document.toJS() == null) document.contents = document.createNode({});
  const decisions: Record<string, unknown> = {};
  for (const settings of [manifest.pnpm, workspace]) {
    if (!settings) continue;
    for (const key of legacyKeys) {
      if (!Array.isArray(settings[key])) continue;
      for (const name of settings[key]) {
        if (typeof name === "string")
          decisions[name] = key === "onlyBuiltDependencies";
      }
    }
  }
  Object.assign(decisions, workspace.allowBuilds);
  for (const name of generatedProjectBuildDependencies(configuration)) {
    if (typeof decisions[name] !== "boolean") decisions[name] = true;
  }

  const version =
    typeof manifest.packageManager === "string"
      ? /^pnpm@(\d+)\.(\d+)/.exec(manifest.packageManager)
      : undefined;
  const modern =
    !version ||
    Number(version[1]) > 10 ||
    (Number(version[1]) === 10 && Number(version[2]) >= 26);
  if (modern) {
    // pnpm 11 no longer reads package.json.pnpm; 10.26+ accepts the same YAML map.
    for (const key of legacyKeys) {
      document.delete(key);
      if (manifest.pnpm) delete manifest.pnpm[key];
    }
    document.set("allowBuilds", decisions);
    if (manifest.pnpm && !Object.keys(manifest.pnpm).length)
      delete manifest.pnpm;
  } else {
    manifest.pnpm = { ...manifest.pnpm };
    for (const key of legacyKeys) {
      document.delete(key);
      delete manifest.pnpm[key];
    }
    document.delete("allowBuilds");
    manifest.pnpm.onlyBuiltDependencies = Object.keys(decisions)
      .filter((name) => decisions[name] === true)
      .sort();
    manifest.pnpm.ignoredBuiltDependencies = Object.keys(decisions)
      .filter((name) => decisions[name] === false)
      .sort();
  }
  const nextManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  if (JSON.stringify(JSON.parse(manifestText)) !== JSON.stringify(manifest)) {
    await writeFile(manifestPath, nextManifest, "utf8");
  }
  const nextWorkspace = document.toString();
  if (nextWorkspace !== workspaceText && (modern || workspaceText)) {
    await writeFile(workspacePath, nextWorkspace, "utf8");
  }
}
