import type {
  FrontendFramework,
  UiLibrary,
  BackendFramework,
  DatabaseOption,
  OrmOption,
  PackageManager,
  CodeQualityOption,
  AdvancedProjectOption,
  NewProjectConfiguration,
} from "@blame/agent-runtime/new-project-options";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ApiConnection, ReasoningSelection } from "@blame/agent-runtime";
import { withoutTelemetryEnvironment } from "@blame/telemetry";
import { hostGitCommand } from "./host-git.ts";
import { projectNameError } from "@blame/agent-runtime/project-name";
import {
  installGeneratedProjectDependencies,
  type ProjectCreationEvent,
  type ProjectCommandRunner,
} from "./project-creation-dependencies.ts";
import { sanitizeWorkspaceConfigFiles } from "./workspace-config-sanitizer.ts";
import { generatedProjectBuildDependencies } from "./project-creation-pnpm-builds.ts";
import {
  blamePreview,
  dockerCompose,
  dockerfile,
  e2eTest,
  envExample,
  fastApiMain,
  githubActions,
  nodePackageManager,
  pnpmWorkspace,
  pyproject,
  readme,
  unitTest,
} from "./project-creation-templates.ts";

const execFileAsync = promisify(execFile);
const gitMaxBuffer = 20 * 1024 * 1024;
const generatedProjectGitignoreEntries = [
  ".blame/",
  ".blame-preview/",
  ".pnpm-store/",
  "node_modules/",
  "**/node_modules/",
  ".venv/",
  "**/.venv/",
  "__pycache__/",
  "**/.nuxt/",
  "**/.next/",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
];

export type {
  ProjectPlatform,
  FrontendFramework,
  StylingOption,
  UiLibrary,
  BackendFramework,
  DatabaseOption,
  OrmOption,
  PackageManager,
  CodeQualityOption,
  AdvancedProjectOption,
  NewProjectConfiguration,
} from "@blame/agent-runtime/new-project-options";

export type CreateProjectInput = {
  apiConnection: ApiConnection;
  configuration: NewProjectConfiguration;
  credentialLabel?: string;
  modelId: string;
  parentPath: string;
  projectName: string;
  providerId: string;
  reasoningEffort?: ReasoningSelection;
  runId: string;
};

export type NewProjectAgentRuntime = {
  generate(input: {
    apiConnection: ApiConnection;
    configuration: NewProjectConfiguration;
    credentialLabel?: string;
    cwd: string;
    modelId: string;
    projectName: string;
    providerId: string;
    reasoningEffort?: ReasoningSelection;
    sessionId?: string;
    workspaceRoot: string;
  }): Promise<{
    path: string;
    sessionId: string;
  }>;
};

export type CommandRecipe = {
  command: string;
  args: string[];
  cwd: string;
};

export type ProjectCreationRecipe = {
  scaffold: CommandRecipe;
  scaffoldTarget: string;
  installs: CommandRecipe[];
  overlays: Array<{ path: string; content: string }>;
};

type ProjectCreationWindow = {
  webContents: {
    send(channel: string, event: ProjectCreationEvent): void;
  };
};

let projectCreationWindowsProvider = () => [] as ProjectCreationWindow[];
let newProjectAgentRuntime: NewProjectAgentRuntime | undefined;
// A failed installation can be retried in this wizard without regenerating files.
const generatedProjects = new Map<string, { key: string; target: string }>();

export function setProjectCreationWindowsProvider(
  provider: () => ProjectCreationWindow[],
) {
  projectCreationWindowsProvider = provider;
}

export function setNewProjectAgentRuntime(
  runtime: NewProjectAgentRuntime | undefined,
) {
  newProjectAgentRuntime = runtime;
}

export async function createProject(
  input: CreateProjectInput,
  options: { runCommand?: ProjectCommandRunner } = {},
) {
  const key = JSON.stringify([
    input.parentPath.trim(),
    input.projectName.trim(),
    input.configuration,
  ]);
  const previous = generatedProjects.get(input.runId);
  const resume = previous?.key === key ? previous : undefined;
  const target =
    resume?.target ??
    (await validateProjectTarget(input.parentPath, input.projectName));
  const emit = projectCreationEmitter(input.runId);

  if (!newProjectAgentRuntime) {
    throw new Error("New project agent runtime is not available.");
  }

  if (!resume) {
    await mkdir(target);
    emit({
      type: "stdout",
      data: `Preparing empty project folder: ${target}\n`,
    });
    emit({ type: "stdout", data: "Starting AI project generation agent...\n" });

    await newProjectAgentRuntime.generate({
      apiConnection: input.apiConnection,
      configuration: input.configuration,
      credentialLabel: input.credentialLabel,
      cwd: target,
      modelId: input.modelId,
      projectName: basename(target),
      providerId: input.providerId,
      reasoningEffort: input.reasoningEffort,
      sessionId: input.runId,
      workspaceRoot: target,
    });
    if (generatedProjects.size >= 20)
      generatedProjects.delete(generatedProjects.keys().next().value!);
    generatedProjects.set(input.runId, { key, target });
  }

  await sanitizeWorkspaceConfigFiles(target);
  await installGeneratedProjectDependencies(
    target,
    input.configuration,
    emit,
    options.runCommand,
  );

  await initializeGeneratedRepository(target, emit);
  generatedProjects.delete(input.runId);

  emit({ type: "exit", data: "0" });
  return {
    path: target,
  };
}

export async function initializeGeneratedRepository(
  target: string,
  emit: (event: ProjectCreationEvent) => void = () => undefined,
) {
  emit({ type: "stdout", data: "$ git init\n" });
  await git(target, ["init"]);
  await ensureGeneratedProjectGitignore(target);
  await git(target, ["add", "--all", "--", "."]);
  const changed = await hasStagedChanges(target);
  if (!changed) return;
  await git(target, [
    "-c",
    "user.name=Blame",
    "-c",
    "user.email=blame@example.local",
    "commit",
    "-m",
    "chore: initialize project",
  ]);
}

async function hasStagedChanges(target: string) {
  try {
    await git(target, ["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    return true;
  }
}

async function ensureGeneratedProjectGitignore(target: string) {
  const path = join(target, ".gitignore");
  const existing = existsSync(path) ? await readFile(path, "utf8") : "";
  const existingEntries = new Set(existing.split(/\r?\n/));
  const missingEntries = generatedProjectGitignoreEntries.filter(
    (entry) => !existingEntries.has(entry),
  );
  if (!missingEntries.length) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  await appendFile(path, `${prefix}${missingEntries.join("\n")}\n`, "utf8");
}

async function git(cwd: string, args: string[]) {
  const env = withoutTelemetryEnvironment(process.env);
  await execFileAsync(hostGitCommand({ env }), args, {
    cwd,
    env,
    maxBuffer: gitMaxBuffer,
  });
}

export async function validateProjectTarget(
  parentPath: string,
  projectName: string,
) {
  const name = projectName.trim();
  const nameError = projectNameError(projectName);
  if (nameError) throw new Error(nameError);
  if (!parentPath.trim())
    throw new Error("Choose a location for your project.");

  const parent = resolve(parentPath.trim());
  const target = resolve(parent, name);
  const pathInsideParent = relative(parent, target);
  if (!pathInsideParent || pathInsideParent.startsWith("..")) {
    throw new Error(
      "Project path must stay inside the selected parent folder.",
    );
  }

  if (existsSync(target)) {
    throw new Error(
      "A file or folder already exists here. Choose another name or location.",
    );
  }

  await mkdir(parent, { recursive: true });
  return target;
}

export function projectCreationRecipe(
  configuration: NewProjectConfiguration,
  target: string,
): ProjectCreationRecipe {
  if (configuration.platform !== "web") {
    throw new Error("Only web applications are supported in this version.");
  }

  if (configuration.frontend === "none") {
    throw new Error(
      "A frontend framework is required for the first web generator.",
    );
  }

  const scaffold = scaffoldCommand(configuration, target);
  const scaffoldTarget = resolve(scaffold.cwd, scaffoldProjectName(target));
  const installs = installCommands(configuration, target);
  const overlays = projectOverlays(configuration, target);
  return { scaffold, scaffoldTarget, installs, overlays };
}

function scaffoldCommand(
  configuration: NewProjectConfiguration,
  target: string,
): CommandRecipe {
  const name = basename(target);
  const scaffoldName = scaffoldProjectName(target);
  const parent = resolve(target, "..");
  const pm = nodePackageManager(configuration.packageManager);

  if (configuration.frontend === "next") {
    return {
      command: pm,
      args: [
        ...createArgs(pm, "next-app"),
        scaffoldName,
        "--ts",
        "--app",
        "--src-dir",
        configuration.styling === "tailwind" ? "--tailwind" : "--no-tailwind",
        ...nextQualityArgs(configuration.codeQuality),
        ...nextImportAliasArgs(configuration.advancedOptions),
        ...nextPackageManagerArgs(pm),
        "--skip-install",
        "--disable-git",
        "--yes",
      ],
      cwd: parent,
    };
  }

  if (configuration.frontend === "react-vite") {
    return viteCommand(pm, parent, scaffoldName, "react-ts");
  }

  if (configuration.frontend === "vue-vite") {
    return viteCommand(pm, parent, scaffoldName, "vue-ts");
  }

  if (configuration.frontend === "nuxt") {
    return {
      command: pm,
      args: [
        ...createArgs(pm, "nuxt"),
        scaffoldName,
        "--template",
        "minimal",
        "--no-install",
        `--packageManager=${pm}`,
        "--gitInit=false",
        "--modules=",
      ],
      cwd: parent,
    };
  }

  return {
    command: pm === "npm" ? "npx" : pm,
    args:
      pm === "npm"
        ? [
            "sv",
            "create",
            scaffoldName,
            "--template",
            "minimal",
            "--types",
            "ts",
            "--no-add-ons",
            "--no-install",
            "--no-dir-check",
            "--no-download-check",
          ]
        : [
            "dlx",
            "sv",
            "create",
            scaffoldName,
            "--template",
            "minimal",
            "--types",
            "ts",
            "--no-add-ons",
            "--no-install",
            "--no-dir-check",
            "--no-download-check",
          ],
    cwd: parent,
  };
}

function viteCommand(
  packageManager: string,
  parent: string,
  name: string,
  template: string,
): CommandRecipe {
  return {
    command: packageManager,
    args: [...createArgs(packageManager, "vite"), name, "--template", template],
    cwd: parent,
  };
}

function installCommands(
  configuration: NewProjectConfiguration,
  target: string,
): CommandRecipe[] {
  const packageManager = nodePackageManager(configuration.packageManager);
  const packages = additionalPackages(configuration);
  const commands = [installCommand(packageManager, target)];

  if (packages.dependencies.length > 0) {
    commands.push(
      addCommand(packageManager, target, packages.dependencies, false),
    );
  }

  if (packages.devDependencies.length > 0) {
    commands.push(
      addCommand(packageManager, target, packages.devDependencies, true),
    );
  }

  return commands;
}

function additionalPackages(configuration: NewProjectConfiguration) {
  const dependencies = new Set<string>();
  const devDependencies = new Set<string>();

  addUiPackages(configuration.uiLibrary, dependencies, devDependencies);
  addBackendPackages(configuration.backend, dependencies, devDependencies);
  addDataPackages(
    configuration.database,
    configuration.orm,
    dependencies,
    devDependencies,
  );
  addQualityPackages(configuration.codeQuality, devDependencies);
  addAdvancedPackages(configuration.advancedOptions, devDependencies);

  if (configuration.styling === "sass") devDependencies.add("sass");
  if (
    configuration.styling === "tailwind" &&
    configuration.frontend !== "next"
  ) {
    devDependencies.add("tailwindcss");
    devDependencies.add("@tailwindcss/vite");
  }

  return {
    dependencies: [...dependencies],
    devDependencies: [...devDependencies],
  };
}

function addUiPackages(
  uiLibrary: UiLibrary,
  dependencies: Set<string>,
  devDependencies: Set<string>,
) {
  const dependencyMap: Partial<Record<UiLibrary, string[]>> = {
    radix: ["radix-ui"],
    mantine: ["@mantine/core", "@mantine/hooks"],
    mui: ["@mui/material", "@emotion/react", "@emotion/styled"],
    "ant-design": ["antd"],
    daisyui: ["daisyui"],
    "nuxt-ui": ["@nuxt/ui"],
    primevue: ["primevue"],
    vuetify: ["vuetify"],
    "naive-ui": ["naive-ui"],
    skeleton: ["@skeletonlabs/skeleton"],
    "melt-ui": ["@melt-ui/svelte"],
    "flowbite-svelte": ["flowbite-svelte", "flowbite"],
  };

  for (const name of dependencyMap[uiLibrary] ?? []) dependencies.add(name);
  if (uiLibrary === "shadcn" || uiLibrary === "shadcn-svelte") {
    devDependencies.add(uiLibrary === "shadcn" ? "shadcn" : "shadcn-svelte");
  }
}

function addBackendPackages(
  backend: BackendFramework,
  dependencies: Set<string>,
  devDependencies: Set<string>,
) {
  if (backend === "hono") dependencies.add("hono");
  if (backend === "fastify") dependencies.add("fastify");
  if (backend === "nest") {
    dependencies.add("@nestjs/common");
    dependencies.add("@nestjs/core");
    dependencies.add("reflect-metadata");
    devDependencies.add("@nestjs/cli");
  }
}

function addDataPackages(
  database: DatabaseOption,
  orm: OrmOption,
  dependencies: Set<string>,
  devDependencies: Set<string>,
) {
  if (database === "postgresql") dependencies.add("pg");
  if (database === "mysql") dependencies.add("mysql2");
  if (database === "sqlite") dependencies.add("better-sqlite3");
  if (database === "mongodb") dependencies.add("mongodb");
  if (orm === "prisma") {
    dependencies.add("@prisma/client");
    devDependencies.add("prisma");
  }
  if (orm === "drizzle") {
    dependencies.add("drizzle-orm");
    devDependencies.add("drizzle-kit");
  }
  if (orm === "kysely") dependencies.add("kysely");
}

function addQualityPackages(
  codeQuality: CodeQualityOption,
  devDependencies: Set<string>,
) {
  if (codeQuality === "biome") devDependencies.add("@biomejs/biome");
  if (codeQuality === "prettier" || codeQuality === "eslint-prettier") {
    devDependencies.add("prettier");
  }
  if (codeQuality === "eslint" || codeQuality === "eslint-prettier") {
    devDependencies.add("eslint");
  }
}

function addAdvancedPackages(
  advancedOptions: AdvancedProjectOption[],
  devDependencies: Set<string>,
) {
  if (advancedOptions.includes("unitTests")) devDependencies.add("vitest");
  if (advancedOptions.includes("e2eTests"))
    devDependencies.add("@playwright/test");
  if (advancedOptions.includes("auth")) devDependencies.add("better-auth");
}

function projectOverlays(
  configuration: NewProjectConfiguration,
  target: string,
) {
  const overlays: Array<{ path: string; content: string }> = [];
  const advanced = configuration.advancedOptions;

  if (advanced.includes("envExample")) {
    overlays.push({
      path: join(target, ".env.example"),
      content: envExample(configuration),
    });
  }

  if (advanced.includes("readme")) {
    overlays.push({
      path: join(target, "README.md"),
      content: readme(configuration, target),
    });
  }

  if (advanced.includes("docker")) {
    overlays.push({
      path: join(target, "Dockerfile"),
      content: dockerfile(configuration),
    });
  }

  if (advanced.includes("dockerCompose")) {
    overlays.push({
      path: join(target, "docker-compose.yml"),
      content: dockerCompose(configuration),
    });
  }

  if (advanced.includes("githubActions")) {
    overlays.push({
      path: join(target, ".github", "workflows", "ci.yml"),
      content: githubActions(configuration),
    });
  }

  if (advanced.includes("blamePreview")) {
    overlays.push({
      path: join(target, ".blame", "preview.json"),
      content: blamePreview(configuration),
    });
  }

  if (configuration.backend === "fastapi") {
    overlays.push({
      path: join(target, "api", "main.py"),
      content: fastApiMain(),
    });
    overlays.push({
      path: join(target, "pyproject.toml"),
      content: pyproject(configuration),
    });
  }

  if (advanced.includes("unitTests")) {
    overlays.push({
      path: join(target, "src", "blame.generated.test.ts"),
      content: unitTest(configuration),
    });
  }

  if (advanced.includes("e2eTests")) {
    overlays.push({
      path: join(target, "tests", "preview.spec.ts"),
      content: e2eTest(),
    });
  }

  if (
    advanced.includes("monorepo") &&
    configuration.packageManager === "pnpm"
  ) {
    overlays.push({
      path: join(target, "pnpm-workspace.yaml"),
      content: pnpmWorkspace(),
    });
  }

  return overlays;
}

export async function applyProjectOverlays(
  target: string,
  overlays: Array<{ path: string; content: string }>,
  configuration: NewProjectConfiguration,
) {
  await updatePackageJson(target, configuration);
  await updateTypeScriptAliases(target, configuration);

  for (const overlay of overlays) {
    await mkdir(resolve(overlay.path, ".."), { recursive: true });
    await writeFile(overlay.path, overlay.content, "utf8");
  }
}

async function renameScaffoldTarget(scaffoldTarget: string, target: string) {
  if (scaffoldTarget === target) return;
  if (!existsSync(scaffoldTarget)) {
    throw new Error(
      "Scaffold command did not create the expected project directory.",
    );
  }
  if (existsSync(target)) {
    throw new Error("Project directory already exists after scaffold.");
  }
  await rename(scaffoldTarget, target);
}

async function updatePackageJson(
  target: string,
  configuration: NewProjectConfiguration,
) {
  const path = join(target, "package.json");
  if (!existsSync(path)) return;
  const parsed = JSON.parse(await readFile(path, "utf8"));
  parsed.scripts = packageScripts(parsed.scripts, configuration);
  const onlyBuiltDependencies = pnpmOnlyBuiltDependencies(configuration);
  if (onlyBuiltDependencies.length > 0) {
    parsed.pnpm = {
      ...parsed.pnpm,
      onlyBuiltDependencies,
    };
  }
  if (configuration.advancedOptions.includes("monorepo")) {
    parsed.workspaces = parsed.workspaces ?? ["apps/*", "packages/*"];
  }
  parsed.packageManager = packageManagerVersion(configuration.packageManager);
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

function pnpmOnlyBuiltDependencies(configuration: NewProjectConfiguration) {
  if (configuration.packageManager !== "pnpm") return [];
  return generatedProjectBuildDependencies(configuration);
}

async function updateTypeScriptAliases(
  target: string,
  configuration: NewProjectConfiguration,
) {
  if (!configuration.advancedOptions.includes("typescriptAlias")) return;
  for (const file of ["tsconfig.json", "tsconfig.app.json"]) {
    const path = join(target, file);
    if (!existsSync(path)) continue;
    const parsed = parseJsonc(await readFile(path, "utf8"));
    parsed.compilerOptions = {
      ...parsed.compilerOptions,
      baseUrl: parsed.compilerOptions?.baseUrl ?? ".",
      paths: {
        ...parsed.compilerOptions?.paths,
        "@/*": ["./src/*"],
      },
    };
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }
}

function parseJsonc(content: string) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(content)));
}

function stripJsonComments(content: string) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const current = content[index];
    const next = content[index + 1];
    if (inString) {
      output += current;
      escaped = current === "\\" && !escaped;
      if (current === quote && !escaped) inString = false;
      if (current !== "\\") escaped = false;
      continue;
    }
    if (current === '"' || current === "'") {
      inString = true;
      quote = current;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < content.length && content[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (
        index < content.length &&
        !(content[index] === "*" && content[index + 1] === "/")
      )
        index += 1;
      index += 1;
      continue;
    }
    output += current;
  }
  return output;
}

function stripTrailingCommas(content: string) {
  return content.replace(/,\s*([}\]])/g, "$1");
}

function packageScripts(
  scripts: Record<string, string> | undefined,
  configuration: NewProjectConfiguration,
) {
  const nextScripts = { ...scripts };
  if (configuration.advancedOptions.includes("standardScripts")) {
    nextScripts.dev =
      nextScripts.dev ?? defaultDevScript(configuration.frontend);
    nextScripts.build =
      nextScripts.build ?? defaultBuildScript(configuration.frontend);
    nextScripts.lint = nextScripts.lint ?? "eslint .";
  }
  if (configuration.advancedOptions.includes("unitTests")) {
    nextScripts.test = nextScripts.test ?? "vitest run";
  } else if (configuration.advancedOptions.includes("standardScripts")) {
    nextScripts.test = nextScripts.test ?? 'echo "No tests configured"';
  }
  if (configuration.advancedOptions.includes("e2eTests")) {
    nextScripts.e2e = nextScripts.e2e ?? "playwright test";
  }
  return nextScripts;
}

function installCommand(packageManager: string, target: string): CommandRecipe {
  if (packageManager === "npm")
    return { command: "npm", args: ["install"], cwd: target };
  if (packageManager === "yarn")
    return { command: "yarn", args: ["install"], cwd: target };
  if (packageManager === "bun")
    return { command: "bun", args: ["install"], cwd: target };
  return { command: "pnpm", args: ["install"], cwd: target };
}

function addCommand(
  packageManager: string,
  target: string,
  packages: string[],
  dev: boolean,
): CommandRecipe {
  if (packageManager === "npm") {
    return {
      command: "npm",
      args: ["install", dev ? "--save-dev" : "--save", ...packages],
      cwd: target,
    };
  }
  if (packageManager === "yarn") {
    return {
      command: "yarn",
      args: ["add", ...(dev ? ["--dev"] : []), ...packages],
      cwd: target,
    };
  }
  if (packageManager === "bun") {
    return {
      command: "bun",
      args: ["add", ...(dev ? ["--dev"] : []), ...packages],
      cwd: target,
    };
  }
  return {
    command: "pnpm",
    args: ["add", ...(dev ? ["-D"] : []), ...packages],
    cwd: target,
  };
}

function createArgs(packageManager: string, packageName: string) {
  if (packageManager === "npm") return ["create", `${packageName}@latest`];
  if (packageManager === "yarn") return ["create", packageName];
  if (packageManager === "bun") return ["create", packageName];
  return ["create", packageName];
}

function nextQualityArgs(codeQuality: CodeQualityOption) {
  if (codeQuality === "biome") return ["--biome"];
  if (codeQuality === "none" || codeQuality === "prettier")
    return ["--no-linter"];
  return ["--eslint"];
}

function nextPackageManagerArgs(packageManager: string) {
  if (packageManager === "npm") return ["--use-npm"];
  if (packageManager === "yarn") return ["--use-yarn"];
  if (packageManager === "bun") return ["--use-bun"];
  return ["--use-pnpm"];
}

function nextImportAliasArgs(advancedOptions: AdvancedProjectOption[]) {
  if (!advancedOptions.includes("typescriptAlias")) return [];
  return ["--import-alias", "@/*"];
}

function defaultDevScript(frontend: FrontendFramework) {
  if (frontend === "next") return "next dev";
  if (frontend === "nuxt") return "nuxt dev";
  return "vite --host 0.0.0.0";
}

function defaultBuildScript(frontend: FrontendFramework) {
  if (frontend === "next") return "next build";
  if (frontend === "nuxt") return "nuxt build";
  return "vite build";
}

function packageManagerVersion(packageManager: PackageManager) {
  if (packageManager === "pnpm") return "pnpm@10.33.2";
  if (packageManager === "npm") return "npm@11.6.4";
  if (packageManager === "yarn") return "yarn@1.22.22";
  if (packageManager === "bun") return "bun@1.3.4";
  return "npm@11.6.4";
}

function scaffoldProjectName(target: string) {
  const name = basename(target);
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .toLowerCase();
}

function projectCreationEmitter(runId: string) {
  return (event: ProjectCreationEvent) => {
    for (const window of projectCreationWindowsProvider()) {
      window.webContents.send(
        `workspace:project-creation:event:${runId}`,
        event,
      );
    }
  };
}
