// Keeps the Cline SDK packages current. Used by .github/workflows/cline-sdk-update.yml:
//   check                 compare the installed version with npm's latest release
//   apply <version>       pin every @cline/* dependency, sync runtime manifests, bump the runtime
//   patch <version>       regenerate the removed patches that have a generator script
//   notes <from> <to>     pull request body with release dates, commits and follow-up steps
// pnpm patches of @cline/* packages target exact versions and cannot follow an
// upgrade: apply removes them, patch regenerates those it can, and the pull
// request asks to regenerate the rest by hand.
import { execFileSync } from "node:child_process"
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)))
const referencePackage = "packages/agent-runtime/package.json"
const runtimeManifests = [
  "packages/desktop/resources/runtime/macos/manifest.json",
  "packages/desktop/resources/runtime/windows/manifest.json",
]
// Files that pin the SDK version outside package.json: the sandbox runner image
// and the fallbacks of the runtime provisioning scripts.
export const pinnedVersionFiles = [
  "packages/sandbox-runner/Dockerfile",
  "packages/sandbox-runner/src/runner-application.ts",
  "packages/desktop/resources/runtime/macos/scripts/blame-lima-runtime.sh",
  "packages/desktop/resources/runtime/macos/scripts/provision-blame-runtime.sh",
  "packages/desktop/resources/runtime/windows/scripts/blame-wsl2-runtime.ps1",
  "packages/desktop/resources/runtime/windows/scripts/build-blame-wsl-rootfs.ps1",
  "packages/desktop/resources/runtime/windows/scripts/provision-blame-runtime.sh",
]
const workspaceFile = "pnpm-workspace.yaml"
// Scripts that rebuild a Blame patch on a pristine package directory.
const patchGenerators = { "@cline/core": "scripts/patch-cline-core.mjs" }
const registry = "https://registry.npmjs.org"
const clineRepository = "cline/cline"

export function compareVersions(left, right) {
  const parse = (value) => value.split(/[.-]/).slice(0, 3).map(Number)
  const [a, b] = [parse(left), parse(right)]
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

export async function installedVersion(root = rootDir) {
  const manifest = JSON.parse(await readFile(join(root, referencePackage), "utf8"))
  const version = manifest.dependencies?.["@cline/sdk"]
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    throw new Error(`@cline/sdk must be pinned to an exact version in ${referencePackage}`)
  }
  return version
}

export async function clinePackageManifests(root = rootDir) {
  const packages = await readdir(join(root, "packages"), { withFileTypes: true })
  const manifests = []
  for (const entry of packages) {
    if (!entry.isDirectory()) continue
    const path = join(root, "packages", entry.name, "package.json")
    const text = await readFile(path, "utf8").catch(() => undefined)
    if (!text) continue
    const names = clineDependencyNames(JSON.parse(text))
    if (names.length) manifests.push({ path, names })
  }
  return manifests
}

function clineDependencyNames(manifest) {
  return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]
    .flatMap((group) => Object.keys(group ?? {}))
    .filter((name) => name.startsWith("@cline/"))
}

export async function applyVersion(version, root = rootDir) {
  const previous = await installedVersion(root)
  for (const { path } of await clinePackageManifests(root)) {
    const manifest = JSON.parse(await readFile(path, "utf8"))
    for (const group of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[group] ?? {})) {
        if (name.startsWith("@cline/")) manifest[group][name] = version
      }
    }
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  }
  // The SDK is baked into the runtime images, so a new SDK needs a new runtime.
  const runtimeVersions = new Set()
  for (const relativePath of runtimeManifests) {
    const path = join(root, relativePath)
    const manifest = JSON.parse(await readFile(path, "utf8"))
    manifest.clineSdkVersion = version
    manifest.runtimeVersion = String(Number(manifest.runtimeVersion) + 1)
    runtimeVersions.add(manifest.runtimeVersion)
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  }
  if (runtimeVersions.size !== 1) {
    throw new Error("Runtime manifests disagree on runtimeVersion")
  }
  await updatePinnedVersions(previous, version, root)
  const stalePatches = await removeClinePatches(root)
  return { runtimeVersion: [...runtimeVersions][0], stalePatches }
}

async function updatePinnedVersions(previous, version, root) {
  const pinned = versionPattern(previous)
  for (const relativePath of pinnedVersionFiles) {
    const path = join(root, relativePath)
    const text = await readFile(path, "utf8")
    if (!pinned.test(text)) {
      throw new Error(`${relativePath} no longer pins Cline ${previous}; update pinnedVersionFiles in scripts/cline-sdk-update.mjs`)
    }
    await writeFile(path, text.replace(versionPattern(previous, "g"), version), "utf8")
  }
}

export function versionPattern(version, flags = "") {
  return new RegExp(`(?<![\\d.])${version.replaceAll(".", "\\.")}(?![\\d.])`, flags)
}

async function removeClinePatches(root) {
  const path = join(root, workspaceFile)
  const text = await readFile(path, "utf8").catch(() => undefined)
  if (!text) return []
  const stale = []
  const kept = text.split("\n").filter((line) => {
    const match = line.match(/^\s+['"]?(@cline\/[^@'"]+@[^'":]+)['"]?:\s*(\S+)\s*$/)
    if (match) stale.push({ dependency: match[1], patch: match[2] })
    return !match
  })
  if (stale.length) await writeFile(path, kept.join("\n"), "utf8")
  return stale
}

async function npmMetadata(name, request = fetch) {
  const response = await request(`${registry}/${encodeURIComponent(name).replace("%40", "@")}`)
  if (!response.ok) throw new Error(`npm returned HTTP ${response.status} for ${name}`)
  return response.json()
}

export async function latestRelease(names, request = fetch) {
  const metadata = await Promise.all(names.map((name) => npmMetadata(name, request)))
  const sdk = metadata[names.indexOf("@cline/sdk")]
  const latest = sdk?.["dist-tags"]?.latest
  if (!latest) throw new Error("npm has no latest release of @cline/sdk")
  const missing = names.filter((name, index) => !metadata[index].versions?.[latest])
  if (missing.length) {
    throw new Error(`Cline ${latest} is not published for ${missing.join(", ")} yet`)
  }
  return { latest, time: sdk.time ?? {} }
}

async function check() {
  const current = await installedVersion()
  const names = [...new Set((await clinePackageManifests()).flatMap(({ names }) => names))]
  const { latest } = await latestRelease(names)
  const updated = compareVersions(latest, current) > 0
  console.log(updated ? `Cline SDK ${current} -> ${latest}` : `Cline SDK ${current} is current`)
  await output({ current, latest, updated: String(updated) })
}

async function notes(from, to) {
  const { time } = await latestRelease(["@cline/sdk"])
  const releases = Object.keys(time)
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
    .filter((version) => compareVersions(version, from) > 0 && compareVersions(version, to) <= 0)
    .sort(compareVersions)
  const commits = await sdkCommits(time[from], time[to])
  const { runtimeVersion } = JSON.parse(await readFile(join(rootDir, runtimeManifests[0]), "utf8"))
  const stalePatches = (process.env.STALE_PATCHES ?? "").split(",").filter(Boolean)
  const lines = [
    ...(stalePatches.length
      ? [
          "> [!WARNING]",
          `> Blame patches ${stalePatches.map((patch) => `\`${patch}\``).join(", ")}. A patch targets one exact version, so this pull request removes it from \`pnpm-workspace.yaml\`. Regenerate it against the new version (see \`patches/README.md\`) before marking this pull request ready.`,
          "",
        ]
      : []),
    `Updates every \`@cline/*\` dependency from **${from}** to **${to}** and bumps the desktop runtime to **v${runtimeVersion}**, because the SDK is baked into the runtime images.`,
    "",
    "## Releases",
    "",
    ...releases.map((version) => `- [${version}](https://www.npmjs.com/package/@cline/sdk/v/${version}) — ${time[version]?.slice(0, 10) ?? "unknown date"}`),
    "",
    `[Full diff](https://github.com/${clineRepository}/compare/sdk/sdk/v${from}...sdk/sdk/v${to})`,
  ]
  if (commits.length) {
    lines.push("", `## SDK commits${commits.length >= 50 ? " (latest 50)" : ""}`, "", ...commits.map(({ sha, message, url }) => `- [\`${sha}\`](${url}) ${message}`))
  }
  lines.push(
    "",
    "## Before merging",
    "",
    "- [ ] CI is green, including **Agent runtime tests** and its Cline SDK smoke test",
    "- [ ] Breaking changes above are handled",
    "",
    "## After merging",
    "",
    `1. Publish the runtime: \`git tag runtime-v${runtimeVersion} && git push origin runtime-v${runtimeVersion}\``,
    "2. Once it is published, release the desktop app (see RELEASING.md)",
    "3. Publish the cloud preview sandbox runner image: `pnpm release:sandbox-runner`",
    "",
    "The API picks up the new model catalog on its next deployment.",
  )
  console.log(lines.join("\n"))
}

async function sdkCommits(since, until) {
  if (!since || !until) return []
  const query = new URLSearchParams({ path: "sdk", since, until, per_page: "50" })
  const headers = process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}
  const response = await fetch(`https://api.github.com/repos/${clineRepository}/commits?${query}`, { headers })
  if (!response.ok) return []
  return (await response.json()).map((commit) => ({
    sha: commit.sha.slice(0, 7),
    message: commit.commit.message.split("\n")[0].replaceAll("|", "\\|"),
    url: commit.html_url,
  }))
}

export function patchDependency(patchPath) {
  const name = basename(patchPath, ".patch").replace("__", "/")
  return name.slice(0, name.lastIndexOf("@"))
}

/** Regenerates stale patches for `version`; returns the ones left to redo by hand. */
export async function regeneratePatches(stalePatches, version, root = rootDir) {
  const remaining = []
  for (const patchPath of stalePatches) {
    const dependency = patchDependency(patchPath)
    const generator = patchGenerators[dependency]
    if (!generator) {
      remaining.push(patchPath)
      continue
    }
    const editDir = await mkdtemp(join(tmpdir(), "cline-patch-"))
    try {
      await rm(editDir, { recursive: true, force: true })
      const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" })
      run("pnpm", ["patch", `${dependency}@${version}`, "--edit-dir", editDir])
      run(process.execPath, [join(root, generator), editDir])
      // patch-commit installs after writing the patch and workspace entry. In
      // CI pnpm freezes the lockfile by default, leaving those writes behind
      // with an outdated lockfile unless we explicitly allow its update.
      run("pnpm", ["patch-commit", editDir, "--config.frozen-lockfile=false"])
      await rm(join(root, patchPath), { force: true })
      console.log(`Regenerated the ${dependency} patch for ${version}`)
    } catch (error) {
      console.error(`Could not regenerate ${patchPath}: ${error.message}`)
      remaining.push(patchPath)
    } finally {
      await rm(editDir, { recursive: true, force: true })
    }
  }
  return remaining
}

async function output(values) {
  if (!process.env.GITHUB_OUTPUT) return
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  if (command === "check") await check()
  else if (command === "apply" && args[0]) {
    const { runtimeVersion, stalePatches } = await applyVersion(args[0])
    console.log(`Pinned @cline/* to ${args[0]}; runtime v${runtimeVersion}`)
    for (const { dependency } of stalePatches) console.log(`Removed the stale ${dependency} patch`)
    await output({
      runtime_version: runtimeVersion,
      stale_patches: stalePatches.map(({ patch }) => patch).join(","),
    })
  } else if (command === "patch" && args[0]) {
    const stale = (process.env.STALE_PATCHES ?? "").split(",").filter(Boolean)
    const remaining = await regeneratePatches(stale, args[0])
    await output({ stale_patches: remaining.join(",") })
  } else if (command === "notes" && args.length === 2) await notes(args[0], args[1])
  else {
    console.error("Usage: node scripts/cline-sdk-update.mjs <check | apply <version> | patch <version> | notes <from> <to>>")
    process.exit(1)
  }
}
