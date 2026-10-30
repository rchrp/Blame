import { readBoundedProjectFiles } from "./project-evidence-reader.js";
import { ignoredEvidence } from "./project-preview-coverage.js";

export type WorkspacePackageEvidence = {
  path: string;
  name: string;
  /** Its exports lead only to build output, such as dist, that a fresh clone lacks. */
  buildOutput: boolean;
  workspaceDependencies: string[];
  /** Its build, dev, start, serve, watch and preview scripts, with their pre-scripts. */
  scripts: Record<string, string>;
};

// Every package.json of a workspace, read in full: the scan's manifest
// excerpts are cut short, and dependencies come last.
export async function workspacePackageEvidence(
  root: string,
  files: string[],
): Promise<WorkspacePackageEvidence[] | undefined> {
  const paths = files
    .filter((path) => /(?:^|\/)package\.json$/.test(path))
    .filter((path) => !ignoredEvidence(path))
    .slice(0, 80);
  if (paths.length < 2) return undefined;
  const contents = await readBoundedProjectFiles(
    root,
    paths,
    2_000_000,
    64_000,
  );
  const parsed: Array<[string, Record<string, unknown>]> = [];
  for (const [path, text] of Object.entries(contents)) {
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      if (typeof json.name === "string") parsed.push([path, json]);
    } catch {
      // Cut short or invalid: it tells nothing reliable.
    }
  }
  const names = new Set(parsed.map(([, json]) => json.name as string));
  const packages = new Map<string, WorkspacePackageEvidence>();
  for (const [path, json] of parsed) {
    const name = json.name as string;
    if (packages.has(name)) continue;
    const scripts = stringRecord(json.scripts);
    packages.set(name, {
      path:
        path === "package.json" ? "." : path.slice(0, -"/package.json".length),
      name,
      buildOutput: Boolean(scripts.build) && exportsBuildOutput(json),
      workspaceDependencies: Object.keys({
        ...stringRecord(json.dependencies),
        ...stringRecord(json.devDependencies),
        ...stringRecord(json.optionalDependencies),
      }).filter((dependency) => names.has(dependency)),
      scripts: Object.fromEntries(
        Object.entries(scripts)
          .filter(([script]) =>
            /^(?:pre)?(?:build|dev|start|serve|watch|preview)\b/.test(script),
          )
          .map(([script, body]) => [script, body.slice(0, 400)]),
      ),
    });
  }
  return packages.size > 1 ? [...packages.values()] : undefined;
}

// Entry points other than type declarations that all lead to build output.
export function exportsBuildOutput(json: Record<string, unknown>) {
  const targets: string[] = [];
  const walk = (value: unknown, key?: string) => {
    if (key === "types" || key === "typings") return;
    if (typeof value === "string") targets.push(value);
    else if (value && typeof value === "object")
      for (const [child, inner] of Object.entries(value)) walk(inner, child);
  };
  walk(json.main);
  walk(json.module);
  walk(json.exports);
  return (
    targets.some((target) =>
      /^(?:\.\/)?(?:dist|build|lib|out)\//.test(target),
    ) && !targets.some((target) => /^(?:\.\/)?src\//.test(target))
  );
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
