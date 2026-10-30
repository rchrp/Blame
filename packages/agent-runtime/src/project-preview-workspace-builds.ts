import type { ProjectInitializationScan } from "./project-initialization-scan.js";
import type { PreviewManifest } from "./types.js";
import { escape, runsIn } from "./project-preview-coverage.js";

// A workspace package whose exports point at build output (dist) must be
// built before a task loads it: a fresh clone has no dist, and `exec` or a
// direct command skips the package's own pre-scripts.

type Issue = {
  severity: "blocking" | "warning";
  rule: string;
  warning: string;
};

type Task =
  PreviewManifest["setup"][number] | PreviewManifest["services"][number];

type Package = {
  name: string;
  directory: string;
  built: boolean;
  scripts: Record<string, string>;
  dependencies: string[];
};

type Workspace = Map<string, Package>;

export function workspaceBuildIssues(
  manifest: PreviewManifest,
  scan: ProjectInitializationScan | undefined,
): Issue[] {
  if (!scan) return [];
  const workspace = workspacePackages(scan);
  if (![...workspace.values()].some(({ built }) => built)) return [];
  const setup = orderedSetup(manifest);
  // A setup task counts the tasks ordered before it and itself; a service
  // counts every setup task and its own command, pre-scripts included.
  const consumers: Array<[Task, Task[]]> = [
    ...setup
      .filter(({ command }) => !installs(command ?? ""))
      .map((task): [Task, Task[]] => [
        task,
        setup.slice(0, setup.indexOf(task) + 1),
      ]),
    ...manifest.services
      .filter(({ kind }) => kind !== "dependency")
      .map((service): [Task, Task[]] => [service, [...setup, service]]),
  ];
  const issues: Issue[] = [];
  for (const [task, builders] of consumers) {
    const users = [...workspace.values()].filter((pkg) =>
      runsIn(task, pkg.directory, pkg.name),
    );
    const missing = new Set<string>();
    for (const user of users)
      for (const name of closure(workspace, user.dependencies)) {
        if (!workspace.get(name)?.built) continue;
        if (builders.some((builder) => builds(builder, name, workspace)))
          continue;
        missing.add(name);
      }
    if (!missing.size) continue;
    const packages = [...missing].sort();
    const filters = packages.map((name) => `--filter ${name}`).join(" ");
    issues.push({
      severity: "blocking",
      rule: `must build the workspace packages ${packages.join(", ")} in a setup task, after installing dependencies and before ${task.id} runs (with pnpm: corepack pnpm ${filters} run build; with Turborepo: turbo run build ${filters.replaceAll("--filter ", "--filter=")}): their package.json exports point at build output that a fresh clone does not have, and exec or a direct command skips the package's own pre-scripts`,
      warning: `${task.id} loads workspace packages that are never built.`,
    });
  }
  return issues;
}

// The scan reads each package.json in full; its file excerpts are cut short.
function workspacePackages(scan: ProjectInitializationScan): Workspace {
  return new Map(
    (scan.workspacePackages ?? []).map((pkg) => [
      pkg.name,
      {
        name: pkg.name,
        directory: pkg.path,
        built: pkg.buildOutput,
        scripts: pkg.scripts,
        dependencies: pkg.workspaceDependencies,
      },
    ]),
  );
}

function closure(workspace: Workspace, names: string[]) {
  const seen = new Set<string>();
  const queue = [...names];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...(workspace.get(name)?.dependencies ?? []));
  }
  return seen;
}

function builds(task: Task, target: string, workspace: Workspace) {
  const cwd = resolvePath(".", task.workingDir ?? "");
  return commandBuilds(task.command ?? "", cwd, target, workspace, 0);
}

// Follows the command segment by segment: `cd`, filters, recursive runs,
// turbo, and the scripts it runs with their pre-scripts.
function commandBuilds(
  command: string,
  start: string,
  target: string,
  workspace: Workspace,
  depth: number,
): boolean {
  let cwd = start;
  for (const segment of command.split(/&&|\|\||[;\n|]/)) {
    const text = segment.trim();
    const cd = /^cd\s+["']?([^"'\s]+)/.exec(text);
    if (cd) {
      cwd = resolvePath(cwd, cd[1]!);
      continue;
    }
    const script = scriptName(text);
    if (!script) continue;
    const dir = /(?:--dir|-C|--prefix|--cwd)[= ]["']?([^"'\s]+)/.exec(
      text,
    )?.[1];
    const here = dir ? resolvePath(cwd, dir) : cwd;
    for (const pkg of actedOn(text, here, workspace)) {
      if (pkg.name === target && /^build\b/.test(script)) return true;
      if (
        /build[:-]?(?:workspace|deps|dependencies|packages)|(?:workspace|deps|dependencies|packages)[:-]?build/i.test(
          script,
        ) &&
        closure(workspace, pkg.dependencies).has(target)
      )
        return true;
      if (depth >= 3) continue;
      for (const body of [pkg.scripts[`pre${script}`], pkg.scripts[script]])
        if (
          body &&
          commandBuilds(body, pkg.directory, target, workspace, depth + 1)
        )
          return true;
    }
  }
  return false;
}

// The script a package manager or turbo runs; none for exec, install, dlx.
function scriptName(text: string) {
  const plain = text
    .replace(
      /(?:--filter|-F|--workspace|--dir|-C|--prefix|--cwd)[= ]["']?[^"'\s]+["']?/g,
      " ",
    )
    .replace(/\s-{1,2}[\w-]+(?:=\S+)?/g, " ");
  const name =
    /\bturbo\s+(?:run\s+)?([\w:.-]+)/.exec(plain)?.[1] ??
    /\brun(?:-script)?\s+([\w:.-]+)/.exec(plain)?.[1] ??
    /\b(?:pnpm|npm|yarn|bun)\s+([\w:.-]+)/.exec(plain)?.[1];
  if (
    !name ||
    /^(?:exec|x|dlx|install|i|ci|add|remove|create|rebuild|prisma|node|tsx|why|ls|list|store|fetch|workspaces)$/.test(
      name,
    )
  )
    return undefined;
  return name;
}

function actedOn(text: string, here: string, workspace: Workspace) {
  const all = [...workspace.values()];
  const selectors = [
    ...text.matchAll(/(?:--filter|-F|--workspace)[= ]["']?([^"'\s]+)["']?/g),
  ].map((match) => match[1]!);
  if (selectors.length) {
    const names = new Set(selectors.flatMap((s) => selected(s, workspace)));
    return all.filter(({ name }) => names.has(name));
  }
  if (
    /\bturbo\b|\blerna\s+run\b|\bnx\s+run-many\b|\bworkspaces\s+foreach\b|\s(?:-r|--recursive|--workspaces|-ws)\b/.test(
      text,
    )
  )
    return all;
  return all.filter(({ directory }) => directory === here);
}

// pnpm and turbo selectors: a name or glob, a path, `name...` (with its
// dependencies) and `name^...` (its dependencies only).
function selected(selector: string, workspace: Workspace) {
  const withDependencies = /\.\.\.$/.test(selector);
  const dependenciesOnly = /\^\.\.\.$/.test(selector);
  const base = selector
    .replace(/\^?\.\.\.$/, "")
    .replace(/^\.\.\.\^?/, "")
    .replace(/^\{(.*)\}$/, "$1");
  const pattern = new RegExp(`^${base.split("*").map(escape).join(".*")}$`);
  const path = resolvePath(".", base);
  const names: string[] = [];
  for (const pkg of workspace.values()) {
    if (!pattern.test(pkg.name) && pkg.directory !== path) continue;
    if (!dependenciesOnly) names.push(pkg.name);
    if (withDependencies) names.push(...closure(workspace, pkg.dependencies));
  }
  return names;
}

function installs(command: string) {
  return /\b(?:pnpm|npm|yarn|bun)\s+(?:install|i|ci|add)\b/.test(command);
}

// Setup tasks in the order previews run them.
function orderedSetup(manifest: PreviewManifest) {
  const pending = new Map(manifest.setup.map((task) => [task.id, task]));
  const ordered: PreviewManifest["setup"] = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((task) =>
      (task.dependsOn ?? []).every((id) => !pending.has(id)),
    );
    if (!ready.length) return [...ordered, ...pending.values()];
    for (const task of ready) {
      pending.delete(task.id);
      ordered.push(task);
    }
  }
  return ordered;
}

// A path relative to the workspace root, "." for the root itself.
function resolvePath(cwd: string, path: string) {
  const parts = path.startsWith("/") || cwd === "." ? [] : cwd.split("/");
  for (const part of path.replace(/^\/workspace\/?/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/") || ".";
}
