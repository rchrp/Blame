import type {
  PreviewVariableSource,
  PreviewVariableStatus,
} from "@blame/agent-runtime";
import type {
  PreviewExecutionPlan,
  ServiceLaunchPlan,
  SetupTaskPlan,
} from "@blame/preview-runtime";
import {
  localDatabaseHostRewrite,
  previewDatabaseEnvironmentKey,
  type PreviewDatabaseMode,
} from "./database-environment.ts";
import {
  developmentEnvFileRank,
  envFileDirectory,
  parseEnvEntries,
  placeholderEnvValue,
  runtimeEnvFileName,
  templateEnvFileName,
  withinDirectory,
} from "./dotenv.ts";

// The environment each preview service and setup task receives, from five
// layers, strongest first:
//   1. Blame's own values, which a person cannot override: the addresses of
//      the preview's services and ports they listen on, the preview origin,
//      and the isolated database.
//   2. A story override.
//   3. A project variable, set once for every story of the project.
//   4. The developer's env files, read live at each start.
//   5. Defaults: the setup's own values, then `.env.example`, only when
//      nothing else sets the key.
//
// Layers 1 to 3 and the defaults reach the container's environment, which
// every loader reads first; the env files stay files, mounted with the same
// stronger values written in, so a loader that expands `${VAR}` or lets the
// file win still reads them.

export type EnvFileInput = {
  /** Relative to the project root, with forward slashes. */
  path: string;
  content: string;
};

export type StoredVariable = { key: string; value: string; serviceId?: string };

export type EnvDeclaration = {
  key: string;
  required: boolean;
  file: string;
  /** The app refuses an empty value too, as AdonisJS does. */
  rejectsEmpty?: boolean;
};

export type ResolveEnvironmentInput = {
  plan: Pick<PreviewExecutionPlan, "services" | "setup">;
  /** The value of each binding, by service id, as Compose renders it. */
  bindings: Record<string, Record<string, string>>;
  previewOrigin?: string;
  databaseMode: PreviewDatabaseMode;
  /** The name containers reach the developer's computer at. */
  hostAlias?: string;
  envFiles: EnvFileInput[];
  project: StoredVariable[];
  story: StoredVariable[];
  /** Keys the code declares, by directory. */
  declarations?: Record<string, EnvDeclaration[]>;
};

export type ResolvedVariable = {
  key: string;
  value: string;
  source: PreviewVariableSource;
  file?: string;
  note?: string;
  locked: boolean;
  status: PreviewVariableStatus;
  required?: boolean;
  rejectsEmpty?: boolean;
};

export type ResolvedItem = {
  id: string;
  kind: "service" | "setup";
  /** Relative working directory; undefined outside the workspace. */
  directory?: string;
  variables: ResolvedVariable[];
  /** What Compose puts in the container's environment, bindings aside. */
  environment: Record<string, string>;
  /** What its env files get written in: the stronger layers. */
  fileValues: Record<string, string>;
};

export type ResolvedEnvironment = {
  items: ResolvedItem[];
  /** Values written into the env files of each directory. */
  fileValues: Record<string, Record<string, string>>;
};

type Candidate = {
  layer: 1 | 2 | 3 | 4 | 5;
  source: PreviewVariableSource;
  value: string;
  file?: string;
  note?: string;
  removed?: boolean;
  /** The preview origin in place of localhost, which env files get too. */
  origin?: boolean;
  /** A binding: Compose renders it, after the environment. */
  binding?: boolean;
  /** Expected (by `.env.example` or the code) but set nowhere. */
  expectedOnly?: boolean;
};

export const publicOriginEnvironmentKeys = new Set([
  "APP_URL",
  "APPLICATION_URL",
  "BETTER_AUTH_URL",
  "CANONICAL_URL",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_BASE_URL",
  "NEXTAUTH_URL",
  "PUBLIC_URL",
  "SITE_URL",
]);

export function resolvePreviewEnvironment(
  input: ResolveEnvironmentInput,
): ResolvedEnvironment {
  const serviceIds = new Set(input.plan.services.map(({ id }) => id));
  const files = parsedFiles(input.envFiles);
  const items = [
    ...input.plan.setup.map((task) => ({ kind: "setup" as const, task })),
    ...input.plan.services.map((task) => ({ kind: "service" as const, task })),
  ].map(({ kind, task }) => resolveItem(input, files, serviceIds, kind, task));
  return { items, fileValues: directoryFileValues(items) };
}

type ParsedFile = {
  path: string;
  directory: string;
  name: string;
  entries: Map<string, string>;
};

function parsedFiles(envFiles: EnvFileInput[]) {
  return envFiles.map((file): ParsedFile => ({
    path: file.path,
    directory: envFileDirectory(file.path),
    name: file.path.split("/").at(-1)!,
    entries: new Map(
      parseEnvEntries(file.content).map(({ key, value }) => [key, value]),
    ),
  }));
}

function resolveItem(
  input: ResolveEnvironmentInput,
  files: ParsedFile[],
  serviceIds: Set<string>,
  kind: "service" | "setup",
  task: ServiceLaunchPlan | SetupTaskPlan,
): ResolvedItem {
  const directory = workspaceDirectory(task, kind);
  const candidates = new Map<string, Candidate[]>();
  // Within a layer the first candidate wins: add the strongest first.
  const add = (key: string, candidate: Candidate) =>
    candidates.set(key, [...(candidates.get(key) ?? []), candidate]);
  for (const [key, value] of Object.entries(input.bindings[task.id] ?? {}))
    add(key, {
      layer: 1,
      source: bindingSource(task, key),
      value,
      binding: true,
    });
  const runtimeFiles =
    directory === undefined
      ? []
      : scopedFiles(files, directory, runtimeEnvFileName);
  for (const file of runtimeFiles)
    for (const [key, value] of file.entries)
      add(key, envFileCandidate(input, key, value, file.path, 4));
  for (const [key, value] of Object.entries(task.environment)) {
    const owned = blameOwnedValue(input, serviceIds, task, key, value);
    add(
      key,
      owned
        ? { layer: 1, source: owned, value }
        : { layer: 5, source: "manifest", value },
    );
  }
  // An example only fills in for missing env files, as copying it to
  // `.env` would; next to the developer's own files it lists what they lack.
  if (directory !== undefined) {
    for (const file of scopedFiles(files, directory, templateEnvFileName))
      for (const [key, value] of file.entries)
        add(key, {
          ...envFileCandidate(input, key, value, file.path, 5),
          expectedOnly: runtimeFiles.length > 0,
        });
  }
  for (const [layer, source, variables] of [
    [3, "project", input.project],
    [2, "story", input.story],
  ] as const) {
    for (const variable of scopedVariables(variables, task.id))
      add(variable.key, {
        ...computerHostRewrite(input, variable.key, variable.value),
        layer,
        source,
      });
  }
  const declared = new Map(
    (directory === undefined
      ? []
      : declarationsFor(input.declarations, directory)
    ).map((declaration) => [declaration.key, declaration]),
  );
  for (const [key, declaration] of declared) {
    if (!candidates.has(key))
      add(key, {
        layer: 5,
        source: "env-example",
        value: "",
        file: declaration.file,
        expectedOnly: true,
      });
  }
  const variables: ResolvedVariable[] = [];
  const environment: Record<string, string> = {};
  const fileValues: Record<string, string> = {};
  for (const [key, list] of [...candidates].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const winner = withPreviewOrigin(input, key, strongest(list));
    const declaration = declared.get(key);
    variables.push({
      ...resolvedVariable(key, winner, declaration?.required),
      ...(declaration?.rejectsEmpty ? { rejectsEmpty: true } : {}),
    });
    if (winner.removed || winner.expectedOnly) continue;
    // Env files get the origin from their own rewrite, which also names it
    // NEXT_PUBLIC_APP_URL.
    if (winner.layer <= 3 && !winner.origin) fileValues[key] = winner.value;
    if (winner.binding) continue;
    if (winner.layer !== 4) environment[key] = winner.value;
  }
  return { id: task.id, kind, directory, variables, environment, fileValues };
}

function envFileCandidate(
  input: ResolveEnvironmentInput,
  key: string,
  value: string,
  file: string,
  layer: 4 | 5,
): Candidate {
  const source = layer === 4 ? "env-file" : "env-example";
  if (!previewDatabaseEnvironmentKey(key))
    return { layer, source, value, file };
  if (input.databaseMode === "compose")
    return {
      layer,
      source,
      value,
      file,
      removed: true,
      note: "Left out: this preview uses its own isolated database.",
    };
  return { ...computerHostRewrite(input, key, value), layer, source, file };
}

// The project's own database on the developer's computer, as the env file
// or a person wrote it, renamed to what containers reach.
function computerHostRewrite(
  input: ResolveEnvironmentInput,
  key: string,
  value: string,
) {
  const rewritten =
    input.databaseMode === "existing" &&
    previewDatabaseEnvironmentKey(key) &&
    input.hostAlias &&
    localDatabaseHostRewrite(key, value, input.hostAlias);
  return rewritten
    ? {
        value: rewritten,
        note: `Points at your computer: localhost became ${input.hostAlias}.`,
      }
    : { value };
}

// Values of the setup that only work as written: the address of another
// preview service, the port or address a service listens on, and the
// isolated database's settings.
function blameOwnedValue(
  input: ResolveEnvironmentInput,
  serviceIds: Set<string>,
  task: ServiceLaunchPlan | SetupTaskPlan,
  key: string,
  value: string,
): PreviewVariableSource | undefined {
  if (input.databaseMode === "compose" && previewDatabaseEnvironmentKey(key))
    return "blame-database";
  if (namesPreviewService(key, value, serviceIds)) return "blame-service";
  if (listenSetting(key, value, task)) return "blame-listen";
  return undefined;
}

function namesPreviewService(
  key: string,
  value: string,
  serviceIds: Set<string>,
) {
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([^:/?#\s]+)/i.exec(
    value,
  )?.[1];
  if (host) return serviceIds.has(host);
  if (!/(?:HOST|HOSTNAME|ADDR|ADDRESS|SERVER)$/.test(key)) return false;
  return serviceIds.has(value.split(":")[0]!);
}

function listenSetting(
  key: string,
  value: string,
  task: ServiceLaunchPlan | SetupTaskPlan,
) {
  if (!/(?:^|_)(?:HOST|HOSTNAME|BIND|LISTEN|ADDRESS|PORT)$/.test(key))
    return false;
  if (value === "0.0.0.0" || value === "::") return true;
  const ports =
    "endpoints" in task ? task.endpoints.map(({ port }) => port) : [];
  return /^\d+$/.test(value) && ports.includes(Number(value));
}

function bindingSource(
  task: ServiceLaunchPlan | SetupTaskPlan,
  key: string,
): PreviewVariableSource {
  const binding =
    "bindings" in task
      ? task.bindings.find(({ targetKey }) => targetKey === key)
      : undefined;
  return binding?.exposure === "browser" ? "blame-origin" : "blame-service";
}

function strongest(list: Candidate[]) {
  return list.reduce((best, candidate) =>
    candidate.layer < best.layer ? candidate : best,
  );
}

// A public origin that names localhost is the preview's own origin there.
function withPreviewOrigin(
  input: ResolveEnvironmentInput,
  key: string,
  winner: Candidate,
): Candidate {
  if (
    !input.previewOrigin ||
    winner.layer <= 3 ||
    !publicOriginEnvironmentKeys.has(key)
  )
    return winner;
  const value = previewOriginValue(winner.value, input.previewOrigin);
  if (value === undefined) return winner;
  return {
    layer: 1,
    source: "blame-origin",
    value,
    ...(winner.file ? { file: winner.file } : {}),
    note: "The preview's own address replaces localhost.",
    origin: true,
  };
}

export function previewOriginValue(value: string, origin: string) {
  try {
    const url = new URL(value);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      return undefined;
    return `${origin}${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`;
  } catch {
    return origin;
  }
}

function resolvedVariable(
  key: string,
  winner: Candidate,
  required: boolean | undefined,
): ResolvedVariable {
  return {
    key,
    value: winner.value,
    source: winner.source,
    ...(winner.file ? { file: winner.file } : {}),
    ...(winner.note ? { note: winner.note } : {}),
    locked: winner.layer === 1,
    status: variableStatus(winner),
    ...(required === undefined ? {} : { required }),
  };
}

function variableStatus(winner: Candidate): PreviewVariableStatus {
  if (winner.removed) return "removed";
  if (winner.expectedOnly) return "missing";
  if (!winner.value.trim())
    return winner.source === "env-example" ? "missing" : "empty";
  if (placeholderEnvValue(winner.value)) return "placeholder";
  return "set";
}

function scopedFiles(
  files: ParsedFile[],
  directory: string,
  kind: (name: string) => boolean,
) {
  return files
    .filter(
      (file) =>
        kind(file.name) &&
        withinDirectory(directory, file.directory) &&
        (!runtimeEnvFileName(file.name) ||
          developmentEnvFileRank(file.name) >= 0),
    )
    .sort(
      (left, right) =>
        right.directory.length - left.directory.length ||
        developmentEnvFileRank(left.name) - developmentEnvFileRank(right.name),
    );
}

// A variable for one service wins over one for every service.
function scopedVariables(variables: StoredVariable[], serviceId: string) {
  return [
    ...variables.filter((variable) => variable.serviceId === serviceId),
    ...variables.filter((variable) => !variable.serviceId),
  ];
}

function declarationsFor(
  declarations: ResolveEnvironmentInput["declarations"],
  directory: string,
) {
  return Object.entries(declarations ?? {})
    .filter(([root]) => withinDirectory(directory, root))
    .flatMap(([, list]) => list);
}

function workspaceDirectory(
  task: ServiceLaunchPlan | SetupTaskPlan,
  kind: "service" | "setup",
) {
  if (kind === "service" && (task as ServiceLaunchPlan).kind === "dependency") {
    const service = task as ServiceLaunchPlan;
    if (!service.command) return undefined;
  }
  if (task.workingDir === "/workspace") return ".";
  if (!task.workingDir.startsWith("/workspace/")) return undefined;
  return task.workingDir.slice("/workspace/".length).replace(/\/+$/g, "");
}

// Values every task of a directory agrees on; two tasks of one directory
// with different values leave the file's own.
function directoryFileValues(items: ResolvedItem[]) {
  const byDirectory = new Map<string, Map<string, string | null>>();
  for (const item of items) {
    if (item.directory === undefined) continue;
    const values = byDirectory.get(item.directory) ?? new Map();
    for (const [key, value] of Object.entries(item.fileValues)) {
      const current = values.get(key);
      values.set(
        key,
        current === undefined || current === value ? value : null,
      );
    }
    byDirectory.set(item.directory, values);
  }
  return Object.fromEntries(
    [...byDirectory].map(([directory, values]) => [
      directory,
      Object.fromEntries(
        [...values].filter(
          (entry): entry is [string, string] => entry[1] !== null,
        ),
      ),
    ]),
  );
}
