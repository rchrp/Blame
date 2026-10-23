import type { PreviewManifest } from "./types.js";

// Finds manifest commands that end up driving a container engine on the host.
// Preview containers have no Docker or Podman, so a package script such as
// `"dev": "node scripts/dev.mjs"` that starts `docker compose` before the app
// server can never run there. Projects often grow such wrappers after Blame
// initialized them, which silently turns a valid manifest into a broken one.

export type HostOrchestrationFinding = {
  owner: string;
  command: string;
  chain: string[];
};

type ProjectFiles = Record<string, string>;

type Invocation =
  | { kind: "script"; directory: string; name: string; label: string }
  | { kind: "file"; path: string; label: string };

const maxDepth = 6;

const packageManagerBuiltins = new Set([
  "add",
  "audit",
  "bin",
  "config",
  "create",
  "dedupe",
  "deploy",
  "dlx",
  "env",
  "exec",
  "fetch",
  "i",
  "import",
  "init",
  "install",
  "link",
  "list",
  "ls",
  "outdated",
  "pack",
  "patch",
  "prepare",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "rm",
  "root",
  "setup",
  "store",
  "unlink",
  "up",
  "update",
  "upgrade",
  "why",
  "x",
]);

const scriptRunners = new Set([
  "bash",
  "bun",
  "node",
  "sh",
  "ts-node",
  "tsx",
  "zsh",
  "zx",
]);

export function hostOrchestratedManifestCommand(
  manifest: PreviewManifest,
  files: ProjectFiles,
): HostOrchestrationFinding | undefined {
  const owners = [
    ...manifest.setup.map((task) => ({ ...task, label: `setup ${task.id}` })),
    ...manifest.services.map((service) => ({
      ...service,
      label: `service ${service.id}`,
    })),
  ];
  for (const owner of owners) {
    if (!owner.command) continue;
    const directory = workspaceRelativeDirectory(owner.workingDir);
    const chain = hostOrchestrationChain(owner.command, directory, files);
    if (chain) return { owner: owner.label, command: owner.command, chain };
  }
  return undefined;
}

export function hostOrchestrationError(finding: HostOrchestrationFinding) {
  return [
    `Initialization result ${finding.owner} runs ${finding.chain.join(" -> ")}, which starts Docker or another container engine on the host.`,
    "Preview containers have no container engine, so this command exits immediately.",
    "Run the application server that this wrapper eventually starts instead, declare the databases it provisions as dependency services, and move its migration or seed steps into setup tasks.",
  ].join(" ");
}

export function hostOrchestrationChain(
  command: string,
  directory: string,
  files: ProjectFiles,
): string[] | undefined {
  return followCommand(command, directory, files, new Set(), 0);
}

function followCommand(
  command: string,
  directory: string,
  files: ProjectFiles,
  visited: Set<string>,
  depth: number,
): string[] | undefined {
  if (depth > maxDepth) return undefined;
  if (drivesContainerEngine(command, "shell")) return [];
  for (const invocation of commandInvocations(command, directory, files)) {
    const key = invocationKey(invocation);
    if (visited.has(key)) continue;
    visited.add(key);
    const nested = followInvocation(invocation, files, visited, depth + 1);
    if (nested) return [invocation.label, ...nested];
  }
  return undefined;
}

function followInvocation(
  invocation: Invocation,
  files: ProjectFiles,
  visited: Set<string>,
  depth: number,
) {
  if (invocation.kind === "file") {
    const content = files[invocation.path];
    if (content === undefined) return undefined;
    return drivesContainerEngine(content, fileLanguage(invocation.path))
      ? []
      : undefined;
  }
  const body = packageScripts(files, invocation.directory)?.[invocation.name];
  if (!body) return undefined;
  return followCommand(body, invocation.directory, files, visited, depth);
}

function commandInvocations(
  command: string,
  directory: string,
  files: ProjectFiles,
): Invocation[] {
  const invocations: Invocation[] = [];
  let current = directory;
  for (const segment of commandSegments(command)) {
    const words = shellWords(segment);
    if (words[0] === "cd" && words[1]) {
      current = joinRelative(current, words[1]);
      continue;
    }
    const invocation = segmentInvocation(words, current, files);
    if (invocation) invocations.push(invocation);
  }
  return invocations;
}

function segmentInvocation(
  input: string[],
  directory: string,
  files: ProjectFiles,
): Invocation | undefined {
  const words = withoutEnvironmentPrefix(input);
  const [tool, ...rest] = words[0] === "corepack" ? words.slice(1) : words;
  if (!tool) return undefined;
  if (tool === "pnpm" || tool === "yarn" || tool === "npm" || tool === "bun") {
    return packageScriptInvocation(tool, rest, directory, files);
  }
  if (scriptRunners.has(tool)) return scriptFileInvocation(rest, directory);
  if (/^\.{0,2}\/?[\w./-]+\.(?:sh|mjs|cjs|js|ts|mts)$/.test(tool)) {
    return scriptFileInvocation([tool], directory);
  }
  return undefined;
}

function packageScriptInvocation(
  tool: string,
  args: string[],
  directory: string,
  files: ProjectFiles,
): Invocation | undefined {
  let packageDirectory = directory;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const [argument = "", inlineValue] = (args[index] ?? "").split(/=(.*)/s);
    if (argument === "--") break;
    const value = inlineValue ?? args[index + 1];
    const step = inlineValue === undefined ? 1 : 0;
    if (["--filter", "-F", "--workspace", "-w"].includes(argument) && value) {
      const filtered = filteredPackageDirectory(value, directory, files);
      if (!filtered) return undefined;
      packageDirectory = filtered;
      index += step;
      continue;
    }
    if (["-C", "--dir", "--prefix", "--cwd"].includes(argument) && value) {
      packageDirectory = joinRelative(directory, value);
      index += step;
      continue;
    }
    if (argument.startsWith("-")) continue;
    positional.push(argument);
  }
  const name = scriptName(tool, positional);
  if (!name || !packageScripts(files, packageDirectory)?.[name])
    return undefined;
  return {
    kind: "script",
    directory: packageDirectory,
    name,
    label: `${scriptPackageLabel(packageDirectory)} script "${name}"`,
  };
}

function scriptName(tool: string, positional: string[]) {
  const [first, second] = positional;
  if (!first) return undefined;
  if (first === "run" || first === "run-script") return second;
  if (tool === "npm") {
    return first === "start" || first === "test" ? first : undefined;
  }
  if (tool === "bun") return undefined;
  return packageManagerBuiltins.has(first) ? undefined : first;
}

function scriptFileInvocation(
  args: string[],
  directory: string,
): Invocation | undefined {
  const path = args.find(
    (argument) =>
      !argument.startsWith("-") &&
      /\.(?:sh|mjs|cjs|js|ts|mts|cts)$/.test(argument),
  );
  if (!path) return undefined;
  const relative = joinRelative(directory, path);
  return { kind: "file", path: relative, label: relative };
}

function filteredPackageDirectory(
  filter: string,
  directory: string,
  files: ProjectFiles,
) {
  if (filter.startsWith(".")) return joinRelative(directory, filter);
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith("package.json")) continue;
    if (parsePackageJson(content)?.name === filter) return dirname(path);
  }
  return undefined;
}

export function packageScripts(files: ProjectFiles, directory: string) {
  const path = directory === "." ? "package.json" : `${directory}/package.json`;
  const scripts = parsePackageJson(files[path] ?? "")?.scripts;
  if (!scripts || typeof scripts !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function parsePackageJson(content: string) {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as { name?: unknown; scripts?: Record<string, unknown> })
      : undefined;
  } catch {
    return undefined;
  }
}

// Collects local script files reached from package scripts so the scan can
// show the agent (and the validator) what a wrapper script actually does.
// Files behind long-running scripts (`dev`, `start`, ...) come first.
export function referencedScriptFiles(files: ProjectFiles) {
  const launch: string[] = [];
  const other: string[] = [];
  for (const path of Object.keys(files)) {
    if (!path.endsWith("package.json")) continue;
    const directory = dirname(path);
    const scripts = Object.entries(packageScripts(files, directory) ?? {});
    for (const [name, body] of scripts) {
      const bucket = /^(?:dev|start|serve|preview|watch)\b/.test(name)
        ? launch
        : other;
      for (const invocation of commandInvocations(body, directory, files)) {
        if (invocation.kind === "file") bucket.push(invocation.path);
      }
    }
  }
  return [...new Set([...launch, ...other])].filter(
    (path) => files[path] === undefined || files[path].endsWith("[truncated]"),
  );
}

function drivesContainerEngine(content: string, language: "shell" | "code") {
  const source = withoutComments(content, language);
  if (language === "code") {
    return /["'`](?:docker|docker-compose|podman|podman-compose|nerdctl)(?:["'`]|\s+(?:compose|info|run|up|start|ps|exec|build|pull)\b)/.test(
      source,
    );
  }
  return /(?:^|[\s;&|(`])(?:sudo\s+)?(?:docker|docker-compose|podman|podman-compose|nerdctl)(?=\s)/m.test(
    source,
  );
}

function withoutComments(content: string, language: "shell" | "code") {
  if (language === "shell") return content.replace(/(^|\s)#.*$/gm, "$1");
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function fileLanguage(path: string) {
  return /\.(?:sh|bash|zsh)$/.test(path) ? "shell" : "code";
}

function commandSegments(command: string) {
  return command
    .replace(/^\s*(?:sh|bash)\s+-l?c\s+/, "")
    .split(/&&|\|\||;|\n/)
    .map((segment) => segment.trim().replace(/^['"(]+|['")]+$/g, ""))
    .filter(Boolean);
}

function shellWords(segment: string) {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) =>
    word.replace(/^["']|["']$/g, ""),
  );
}

function withoutEnvironmentPrefix(words: string[]) {
  let index = 0;
  if (words[index] === "env") index += 1;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index += 1;
  return words.slice(index);
}

function workspaceRelativeDirectory(workingDir: string | undefined) {
  const normalized = (workingDir ?? "/workspace")
    .replaceAll("\\", "/")
    .replace(/^\/workspace\/?/, "");
  return joinRelative(".", normalized || ".");
}

function joinRelative(base: string, path: string) {
  const parts = base === "." ? [] : base.split("/");
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/") || ".";
}

function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

function scriptPackageLabel(directory: string) {
  return directory === "." ? "package.json" : `${directory}/package.json`;
}

function invocationKey(invocation: Invocation) {
  return invocation.kind === "file"
    ? `file:${invocation.path}`
    : `script:${invocation.directory}:${invocation.name}`;
}
