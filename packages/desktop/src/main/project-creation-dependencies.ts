import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, matchesGlob, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { withoutTelemetryEnvironment } from "@blame/telemetry";
import { setupPath } from "./host-tool-path.ts";
import { prepareGeneratedProjectPnpmBuilds } from "./project-creation-pnpm-builds.ts";
import type {
  CommandRecipe,
  NewProjectConfiguration,
} from "./project-creation.ts";

export type ProjectCreationEvent = {
  type: "stdout" | "stderr" | "exit";
  data: string;
};
export type ProjectCommandRunner = (
  recipe: CommandRecipe,
  emit: (event: ProjectCreationEvent) => void,
) => Promise<void>;

const ignoredDirectories = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "__pycache__",
]);

export async function generatedProjectInstallCommands(
  target: string,
  configuration: NewProjectConfiguration,
): Promise<CommandRecipe[]> {
  const directories = await manifestDirectories(target);
  const commands: CommandRecipe[] = [];
  const workspaces: Array<{ root: string; patterns: string[] }> = [];
  for (const cwd of directories) {
    if (existsSync(join(cwd, "package.json"))) {
      const manifest = JSON.parse(
        await readFile(join(cwd, "package.json"), "utf8"),
      );
      if (
        !workspaces.some(({ root, patterns }) =>
          isWorkspacePackage(relative(root, cwd), patterns),
        )
      ) {
        const manager = nodeManager(
          cwd,
          manifest.packageManager,
          configuration.packageManager,
        );
        commands.push({
          command: manager,
          args:
            manager === "pnpm"
              ? ["install", "--no-frozen-lockfile"]
              : ["install"],
          cwd,
        });
        const workspaceFile = join(cwd, "pnpm-workspace.yaml");
        const patterns: unknown =
          manager === "pnpm" && existsSync(workspaceFile)
            ? parseYaml(await readFile(workspaceFile, "utf8"))?.packages
            : Array.isArray(manifest.workspaces)
              ? manifest.workspaces
              : manifest.workspaces?.packages;
        if (Array.isArray(patterns))
          workspaces.push({
            root: cwd,
            patterns: patterns.filter(
              (value): value is string => typeof value === "string",
            ),
          });
      }
    }
    if (configuration.backend === "fastapi") {
      commands.push(
        ...pythonInstallCommands(cwd, configuration.packageManager),
      );
    }
  }
  if (!commands.length)
    throw new Error(
      "The generated project has no dependency manifest to install.",
    );
  return commands;
}

function isWorkspacePackage(path: string, patterns: string[]) {
  return (
    patterns.some(
      (pattern) => !pattern.startsWith("!") && matchesGlob(path, pattern),
    ) &&
    !patterns.some(
      (pattern) =>
        pattern.startsWith("!") && matchesGlob(path, pattern.slice(1)),
    )
  );
}

async function manifestDirectories(root: string, depth = 0): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const manifests = new Set([
    "package.json",
    "pyproject.toml",
    "requirements.txt",
  ]);
  const result = entries.some(
    (entry) => entry.isFile() && manifests.has(entry.name),
  )
    ? [root]
    : [];
  if (depth >= 5) return result;
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith(".") ||
      ignoredDirectories.has(entry.name)
    )
      continue;
    result.push(
      ...(await manifestDirectories(join(root, entry.name), depth + 1)),
    );
  }
  return result;
}

function nodeManager(cwd: string, declared: unknown, selected: string) {
  const managers = ["pnpm", "npm", "yarn", "bun"];
  const name =
    typeof declared === "string" ? declared.split("@")[0] : undefined;
  if (name && managers.includes(name)) return name;
  for (const [file, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ]) {
    if (existsSync(join(cwd, file!))) return manager!;
  }
  return managers.includes(selected) ? selected : "npm";
}

function pythonInstallCommands(cwd: string, manager: string): CommandRecipe[] {
  const pyproject = existsSync(join(cwd, "pyproject.toml"));
  const requirements = existsSync(join(cwd, "requirements.txt"));
  if (!pyproject && !requirements) return [];
  const python = process.platform === "win32" ? "python" : "python3";
  if ((manager === "uv" || manager === "poetry") && pyproject) {
    // Bootstrap Python tooling locally; creating a project never needs a global pip install.
    const toolingDir = join(".blame", "python-tools");
    const toolingPython = join(
      cwd,
      toolingDir,
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    return [
      { command: python, args: ["-m", "venv", toolingDir], cwd },
      { command: toolingPython, args: ["-m", "pip", "install", manager], cwd },
      {
        command: toolingPython,
        args: [
          "-m",
          manager,
          ...(manager === "uv" ? ["sync"] : ["install", "--no-interaction"]),
        ],
        cwd,
      },
    ];
  }
  const venvPython = join(
    cwd,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  return [
    { command: python, args: ["-m", "venv", ".venv"], cwd },
    {
      command: venvPython,
      args: [
        "-m",
        "pip",
        "install",
        ...(requirements ? ["-r", "requirements.txt"] : ["-e", "."]),
      ],
      cwd,
    },
  ];
}

export async function installGeneratedProjectDependencies(
  target: string,
  configuration: NewProjectConfiguration,
  emit: (event: ProjectCreationEvent) => void,
  runCommand: ProjectCommandRunner = runProjectCommand,
) {
  emit({ type: "stdout", data: "Installing project dependencies...\n" });
  for (const command of await generatedProjectInstallCommands(
    target,
    configuration,
  )) {
    try {
      if (command.command === "pnpm") {
        await prepareGeneratedProjectPnpmBuilds(command.cwd, configuration);
      }
      await runCommand(command, emit);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Dependency installation failed in ${command.cwd}: ${detail} Your files are saved. Return to the summary and try again to resume installation.`,
      );
    }
  }
  emit({ type: "stdout", data: "Project dependencies installed.\n" });
}

export const runProjectCommand: ProjectCommandRunner = (recipe, emit) => {
  emit({
    type: "stdout",
    data: `$ ${recipe.command} ${recipe.args.join(" ")}\n`,
  });
  return new Promise<void>((resolveCommand, reject) => {
    const child = spawn(recipe.command, recipe.args, {
      cwd: recipe.cwd,
      env: {
        ...withoutTelemetryEnvironment(process.env),
        CI: "true",
        NODE_ENV: "development",
        PATH: setupPath(),
        npm_config_yes: "true",
        YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
        POETRY_VIRTUALENVS_IN_PROJECT: "true",
      },
      shell: process.platform === "win32" && !recipe.command.endsWith(".exe"),
    });
    child.stdin.end();
    child.stdout.on("data", (data: Buffer) =>
      emit({ type: "stdout", data: data.toString() }),
    );
    child.stderr.on("data", (data: Buffer) =>
      emit({ type: "stderr", data: data.toString() }),
    );
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolveCommand();
      reject(
        new Error(`${recipe.command} exited with code ${code ?? "unknown"}.`),
      );
    });
  });
};
