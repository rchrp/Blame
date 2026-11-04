import type {
  BackendFramework,
  FrontendFramework,
  NewProjectConfiguration,
  PackageManager,
} from "./new-project-options"

export function newProjectHostDependencyScript(
  configuration: NewProjectConfiguration
) {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "git --version",
    "docker --version",
    ...frontendCommands(configuration.frontend, configuration.packageManager),
    ...packageInstallCommands(configuration.packageManager),
    ...pythonCommands(configuration.backend, configuration.packageManager),
  ].join("\n")
}

function frontendCommands(
  frontend: FrontendFramework,
  packageManager: PackageManager
) {
  const manager = nodePackageManager(packageManager)
  if (frontend === "sveltekit" && manager === "npm") return ["npx sv --version"]
  if (frontend === "sveltekit") return [`${manager} dlx sv --version`]
  if (frontend === "next") return [`${manager} create next-app --help`]
  if (frontend === "nuxt") return [`${manager} create nuxt --help`]
  if (frontend === "react-vite" || frontend === "vue-vite")
    return [`${manager} create vite --help`]
  return []
}

function packageInstallCommands(packageManager: PackageManager) {
  const manager = nodePackageManager(packageManager)
  if (manager === "pnpm")
    return [
      "pnpm install --help",
      "corepack prepare pnpm@10.34.9 --activate",
      "corepack pnpm install --help",
    ]
  if (manager === "yarn")
    return [
      "yarn install --help",
      "corepack prepare yarn@stable --activate",
      "corepack yarn install --help",
    ]
  if (manager === "bun") return ["bun install --help"]
  return ["npm install --help"]
}

function pythonCommands(
  backend: BackendFramework,
  packageManager: PackageManager
) {
  if (backend !== "fastapi") return []
  if (packageManager === "pip") return ["pip --version"]
  if (packageManager === "poetry") return ["pip --version"]
  return ["pip --version"]
}

function nodePackageManager(packageManager: PackageManager) {
  if (packageManager === "pnpm") return "pnpm"
  if (packageManager === "yarn") return "yarn"
  if (packageManager === "bun") return "bun"
  return "npm"
}
