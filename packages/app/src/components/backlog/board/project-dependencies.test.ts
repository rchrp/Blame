import assert from "node:assert/strict"
import test from "node:test"

import {
  approveBuildsCommand,
  blockedBuildScripts,
  dependencyInstallCommand,
  dependencyInstallFailure,
  dependencyInstallProgress,
  missingPackagesInOutput,
  outputSaysNothingInstalled,
  packageName,
  packagesNotInstalled,
  projectDependencies,
  type DependencyFiles,
} from "./project-dependencies.ts"

function files(tree: Record<string, string>): DependencyFiles {
  return {
    exists: async (path) =>
      Object.keys(tree).some(
        (file) => file === path || file.startsWith(`${path}/`)
      ),
    read: async (path) => tree[path],
  }
}

const app = JSON.stringify({ dependencies: { react: "^19.0.0" } })

test("finds a package with nothing installed", async () => {
  const result = await projectDependencies(
    files({ "package.json": app, "pnpm-lock.yaml": "" }),
    { cwd: ".", command: "pnpm dev" }
  )
  assert.deepEqual(result, {
    manager: "pnpm",
    root: "",
    packageDir: "",
    declared: ["react"],
    missing: true,
  })
})

test("installed packages are not missing", async () => {
  const result = await projectDependencies(
    files({
      "package.json": app,
      "package-lock.json": "{}",
      "node_modules/react/package.json": "{}",
    }),
    { cwd: ".", command: "npm run dev" }
  )
  assert.equal(result?.manager, "npm")
  assert.equal(result?.missing, false)
})

test("installs at the workspace root a package belongs to", async () => {
  const tree = {
    "package.json": JSON.stringify({
      packageManager: "pnpm@10.0.0",
      devDependencies: { turbo: "^2" },
    }),
    "pnpm-workspace.yaml": "packages: [apps/*]",
    "apps/web/package.json": JSON.stringify({
      dependencies: { vite: "^7" },
    }),
    "node_modules/turbo/package.json": "{}",
  }
  const result = await projectDependencies(files(tree), {
    cwd: "apps/web",
    command: "pnpm dev",
  })
  assert.equal(result?.root, "")
  assert.equal(result?.packageDir, "apps/web")
  assert.deepEqual(result?.declared, ["vite", "turbo"])
  // pnpm links the package's own dependencies in its folder.
  assert.equal(result?.missing, true)
  const installed = await projectDependencies(
    files({ ...tree, "apps/web/node_modules/vite/package.json": "{}" }),
    { cwd: "apps/web", command: "pnpm dev" }
  )
  assert.equal(installed?.missing, false)
})

test("the manager comes from the manifest, then the lockfile, then the command", async () => {
  const declared = await projectDependencies(
    files({
      "package.json": JSON.stringify({
        packageManager: "yarn@4.5.0",
        dependencies: { react: "1" },
      }),
      "package-lock.json": "{}",
    }),
    { cwd: ".", command: "npm run dev" }
  )
  assert.equal(declared?.manager, "yarn")
  const fromCommand = await projectDependencies(
    files({ "package.json": app }),
    { cwd: ".", command: "bun run dev" }
  )
  assert.equal(fromCommand?.manager, "bun")
  const fallback = await projectDependencies(files({ "package.json": app }), {
    cwd: ".",
    command: "vite",
  })
  assert.equal(fallback?.manager, "npm")
})

test("Yarn Plug'n'Play installs have no node_modules", async () => {
  const result = await projectDependencies(
    files({ "package.json": app, "yarn.lock": "", ".pnp.cjs": "" }),
    { cwd: ".", command: "yarn dev" }
  )
  assert.equal(result?.missing, false)
})

test("nothing to install without a manifest or dependencies", async () => {
  assert.equal(
    await projectDependencies(files({ "main.py": "" }), {
      cwd: ".",
      command: "python main.py",
    }),
    undefined
  )
  assert.equal(
    await projectDependencies(files({ "package.json": "{}" }), {
      cwd: ".",
      command: "node server.js",
    }),
    undefined
  )
  assert.equal(
    await projectDependencies(files({ "package.json": app }), {
      cwd: "../other",
      command: "pnpm dev",
    }),
    undefined
  )
})

test("installs without stopping to ask", () => {
  assert.equal(
    dependencyInstallCommand("pnpm"),
    "pnpm install --config.confirm-modules-purge=false"
  )
  assert.equal(dependencyInstallCommand("yarn"), "yarn install")
})

test("only declared packages missing from node_modules need an install", async () => {
  const tree = {
    "package.json": JSON.stringify({
      dependencies: { react: "1", zod: "3" },
    }),
    "package-lock.json": "{}",
    "node_modules/react/package.json": "{}",
  }
  const dependencies = await projectDependencies(files(tree), {
    cwd: ".",
    command: "npm run dev",
  })
  assert.ok(dependencies)
  assert.deepEqual(
    await packagesNotInstalled(files(tree), dependencies, [
      "react",
      "zod",
      "left-pad",
    ]),
    ["zod"]
  )
})

test("reads the packages an app cannot find", () => {
  const output = [
    "Error: Cannot find module 'express'",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@tanstack/react-query' imported from /app/src/main.js",
    '[plugin:vite:import-analysis] Failed to resolve import "react-dom/client" from "src/main.tsx". Does the file exist?',
    '[plugin:vite:import-analysis] Failed to resolve import "./missing" from "src/main.tsx".',
    "Module not found: Can't resolve 'zod/v4'",
    "Error: Cannot find module './routes'",
    "Error: Cannot find module 'node:fs'",
    "The following dependencies are imported but could not be resolved:",
    "",
    "  \u001b[36mreact-router\u001b[39m (imported by /app/src/App.tsx)",
    "",
    "Are they installed?",
  ].join("\n")
  assert.deepEqual(missingPackagesInOutput(output).sort(), [
    "@tanstack/react-query",
    "express",
    "react-dom",
    "react-router",
    "zod",
  ])
  assert.deepEqual(missingPackagesInOutput("VITE ready in 300 ms"), [])
})

test("keeps only installable package names", () => {
  assert.equal(packageName("@scope/pkg/sub/path"), "@scope/pkg")
  assert.equal(packageName("lodash/get"), "lodash")
  assert.equal(packageName("/abs/file"), undefined)
  assert.equal(packageName("C:\\code\\file"), undefined)
  assert.equal(packageName("virtual:pwa-register"), undefined)
  assert.equal(packageName("~/components"), undefined)
})

test("pnpm says when nothing is installed", () => {
  assert.equal(
    outputSaysNothingInstalled(
      " WARN  Local package.json exists, but node_modules missing, did you mean to install?"
    ),
    true
  )
  assert.equal(outputSaysNothingInstalled("ready"), false)
})

test("follows pnpm's install progress", () => {
  const resolving = dependencyInstallProgress(
    "$ pnpm install\r\nProgress: resolved 120, reused 100, downloaded 0, added 0\r\n"
  )
  assert.equal(resolving.percent, undefined)
  assert.equal(
    resolving.detail,
    "Progress: resolved 120, reused 100, downloaded 0, added 0"
  )
  const adding = dependencyInstallProgress(
    [
      "Packages: +400",
      "++++++++++++",
      "Progress: resolved 400, reused 380, downloaded 20, added 100",
      "\u001b[1AProgress: resolved 400, reused 380, downloaded 20, added 300",
    ].join("\n")
  )
  assert.equal(adding.percent, 75)
  const npm = dependencyInstallProgress("⠙ idealTree: timing arborist\r⠹ reify")
  assert.equal(npm.percent, undefined)
  assert.equal(npm.detail, "⠹ reify")
})

test("a failed install tells its error line", () => {
  assert.equal(
    dependencyInstallFailure(
      [
        "Progress: resolved 10, reused 0, downloaded 0, added 0",
        " ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/nope: Not Found - 404",
        "",
        "This error happened while installing a direct dependency.",
        "exit",
      ].join("\r\n")
    ),
    "ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/nope: Not Found - 404"
  )
  assert.equal(
    dependencyInstallFailure("npm error code E404\nnpm error 404 Not Found"),
    "npm error 404 Not Found"
  )
  assert.equal(dependencyInstallFailure(""), undefined)
})

test("reads the build scripts pnpm 11 waits on", () => {
  const output = [
    "\u001b[31m[ERR_PNPM_IGNORED_BUILDS]\u001b[39m Ignored build scripts: esbuild@0.28.2, @prisma/engines@6.1.0, sharp@0.34.1.",
    "",
    'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.',
  ].join("\r\n")
  const packages = blockedBuildScripts(output)
  assert.deepEqual(packages, ["esbuild", "@prisma/engines", "sharp"])
  assert.equal(
    approveBuildsCommand(packages),
    "pnpm approve-builds esbuild @prisma/engines sharp"
  )
  // pnpm 10 only warns: nothing waits.
  assert.deepEqual(
    blockedBuildScripts("│   Ignored build scripts: esbuild@0.28.2.   │"),
    []
  )
})
