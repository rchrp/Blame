import { execFile } from "node:child_process"
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { promisify } from "node:util"
import { gzip, gunzip } from "node:zlib"
import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
const downloadBaseUrl = text(process.env.BLAME_DOWNLOAD_BASE_URL)
const homepage = text(process.env.BLAME_HOMEPAGE) ?? "https://blame.dev"
const maintainerEmail =
  text(process.env.BLAME_MAINTAINER_EMAIL) ?? "hello@blame.dev"
const maintainerName = text(process.env.BLAME_MAINTAINER_NAME) ?? "Blame"
const releaseVersion = text(process.env.BLAME_VERSION)
const rebuildNativeDependencies =
  text(process.env.BLAME_DESKTOP_NPM_REBUILD) !== "false"
const projectDir = dirname(fileURLToPath(import.meta.url))
const macosInheritedEntitlements = join(
  projectDir,
  "resources/runtime/macos/entitlements.inherit.plist",
)
// Lima ships limactl with these entitlements; re-signing it with --force drops
// them, and without com.apple.security.virtualization the VM cannot start.
const limactlEntitlements = join(
  projectDir,
  "resources/runtime/macos/entitlements.lima.plist",
)

const publish = downloadBaseUrl
  ? {
      provider: "generic" as const,
      url: downloadBaseUrl,
    }
  : undefined

function text(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

type PackContext = {
  appOutDir: string
  electronPlatformName: string
  packager: {
    appInfo: {
      productFilename: string
    }
    codeSigningInfo?: {
      value: Promise<{
        keychainFile?: string | null
      }>
    }
  }
}

async function finalizePackage(context: PackContext) {
  await restoreBundledPackageManagers(context)
  if (context.electronPlatformName !== "darwin") return
  await execFileAsync("xattr", ["-cr", context.appOutDir])
  console.log(`Removed macOS extended attributes from ${context.appOutDir}`)
  await assertMacosRuntimeArchitecture(context)
  if (macosCodeSigningRequested()) {
    await signMacosRuntimeExecutables(context)
  }
}

async function restoreBundledPackageManagers(context: PackContext) {
  const resources = context.electronPlatformName === "darwin"
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents/Resources")
    : join(context.appOutDir, "resources")
  const runtimeManifest = await realpath(join(projectDir, "node_modules/@blame/agent-runtime/package.json"))
  const runtimeRequire = createRequire(runtimeManifest)
  for (const name of ["npm", "npm-legacy"]) {
    // The pnpm collector omits npm's vendored dependency tree. External Node
    // executes these unpacked CLIs, so restore their complete isolated trees.
    const source = join(dirname(runtimeRequire.resolve(`${name}/package.json`)), "node_modules")
    await cp(source, join(resources, "app.asar.unpacked/node_modules", name, "node_modules"), {
      recursive: true,
      dereference: true,
    })
  }
}

function macosCodeSigningRequested() {
  return Boolean(
    releaseVersion || text(process.env.CSC_LINK) || text(process.env.CSC_NAME),
  )
}

async function signMacosRuntimeExecutables(context: PackContext) {
  const signingInfo = context.packager.codeSigningInfo
  if (!signingInfo) {
    throw new Error(
      "Electron Builder did not expose macOS code-signing information",
    )
  }

  const { keychainFile } = await signingInfo.value
  const identity = await developerIdApplicationIdentity(keychainFile)
  const appRoot = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )
  const limaBundleDir = join(
    appRoot,
    "Contents/Resources/runtime/macos/lima/bundle",
  )
  const limaShareDir = join(limaBundleDir, "share/lima")
  const archives = (await readdir(limaShareDir))
    .filter(
      (file) =>
        file.startsWith("lima-guestagent.Darwin-") && file.endsWith(".gz"),
    )
    .map((file) => join(limaShareDir, file))

  const limactl = join(limaBundleDir, "bin/limactl")
  for (const executable of await macosExecutables(limaBundleDir)) {
    await signMacosExecutable(
      executable,
      identity,
      keychainFile,
      executable === limactl ? limactlEntitlements : undefined,
    )
  }
  for (const archive of archives) {
    await signGzipMachO(archive, identity, keychainFile)
  }
  await assertVirtualizationEntitlement(limactl)
}

async function assertVirtualizationEntitlement(executable: string) {
  const { stdout } = await execFileAsync("codesign", [
    "-d",
    "--entitlements",
    "-",
    "--xml",
    executable,
  ])
  if (!stdout.includes("com.apple.security.virtualization")) {
    throw new Error(
      `${executable} is missing the com.apple.security.virtualization entitlement; the Blame Runtime VM would not start.`,
    )
  }
}

async function macosExecutables(directory: string): Promise<string[]> {
  const executables: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      executables.push(...(await macosExecutables(path)))
      continue
    }
    if (!entry.isFile()) continue
    const { stdout } = await execFileAsync("file", ["-b", path])
    if (stdout.includes("Mach-O")) executables.push(path)
  }
  return executables
}

async function developerIdApplicationIdentity(keychainFile?: string | null) {
  const args = ["find-identity", "-v", "-p", "codesigning"]
  if (keychainFile) args.push(keychainFile)
  const { stdout } = await execFileAsync("security", args)
  const match = stdout.match(
    /^\s*\d+\)\s+([A-F0-9]{40})\s+"Developer ID Application:/im,
  )
  if (!match?.[1]) {
    throw new Error("No valid Developer ID Application identity was found")
  }
  return match[1]
}

async function signGzipMachO(
  archive: string,
  identity: string,
  keychainFile?: string | null,
) {
  const temporaryDir = await mkdtemp(join(tmpdir(), "blame-macos-sign-"))
  const executable = join(temporaryDir, basename(archive, ".gz"))
  const replacement = `${archive}.signed-${process.pid}`

  try {
    const archiveStat = await stat(archive)
    await writeFile(executable, await gunzipAsync(await readFile(archive)), {
      mode: 0o755,
    })
    await signMacosExecutable(executable, identity, keychainFile)
    await writeFile(
      replacement,
      await gzipAsync(await readFile(executable), { level: 9 }),
      { mode: archiveStat.mode },
    )
    await rename(replacement, archive)
    console.log(`Signed compressed macOS executable in ${archive}`)
  } finally {
    await rm(replacement, { force: true })
    await rm(temporaryDir, { force: true, recursive: true })
  }
}

async function signMacosExecutable(
  executable: string,
  identity: string,
  keychainFile?: string | null,
  entitlements?: string,
) {
  const signArgs = [
    "--force",
    "--sign",
    identity,
    "--options",
    "runtime",
    "--timestamp",
  ]
  if (entitlements) signArgs.push("--entitlements", entitlements)
  if (keychainFile) signArgs.push("--keychain", keychainFile)
  signArgs.push(executable)
  await execFileAsync("codesign", signArgs)
  await execFileAsync("codesign", ["--verify", "--strict", executable])
}

async function assertMacosRuntimeArchitecture(context: PackContext) {
  const appRoot = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )
  const appExecutable = join(
    appRoot,
    "Contents/MacOS",
    context.packager.appInfo.productFilename,
  )
  const limaExecutable = join(
    appRoot,
    "Contents/Resources/runtime/macos/lima/bundle/bin/limactl",
  )
  const [appArchitecture, limaArchitecture] = await Promise.all([
    executableArchitecture(appExecutable),
    executableArchitecture(limaExecutable),
  ])
  if (appArchitecture !== limaArchitecture) {
    throw new Error(
      `macOS runtime architecture mismatch: app is ${appArchitecture}, Lima is ${limaArchitecture}.`,
    )
  }
}

async function executableArchitecture(executable: string) {
  const { stdout } = await execFileAsync("lipo", ["-archs", executable])
  const architectures = stdout.trim().split(/\s+/)
  if (architectures.includes("arm64")) return "arm64"
  if (architectures.includes("x86_64")) return "x86_64"
  throw new Error(
    `Unsupported macOS executable architecture for ${executable}: ${stdout.trim()}`,
  )
}

// electron-builder drops every .d.ts from node_modules, but the agent
// runtime's TypeScript language service needs the compiler's default
// libraries: without lib.*.d.ts, built-in types such as Array or Promise do
// not resolve and semantic references miss most uses.
const typeScriptDefaultLibrary = /[\\/](?:typescript|@typescript[\\/](?:typescript6|old))[\\/]lib[\\/]lib(?:\.[^\\/]+)?\.d\.ts$/

const config: Configuration = {
  afterPack: finalizePackage,
  appId: "dev.blame.desktop",
  // Betas publish latest*.yml too: the beta channel reads them from the
  // release itself, and download.blame.so/latest never serves a prerelease.
  detectUpdateChannel: false,
  onNodeModuleFile: (file) => typeScriptDefaultLibrary.test(file),
  asarUnpack: [
    "**/node_modules/@ast-grep/lang-*/**/*",
    "**/node_modules/@vscode/ripgrep-*/**/*",
    "**/node_modules/npm/**/*",
    "**/node_modules/npm-legacy/**/*",
    "**/node_modules/pnpm/**/*",
    "**/node_modules/pnpm-legacy/**/*",
    "**/node_modules/@pnpm/exe.*/**/*",
    "**/node_modules/yarn/**/*",
  ],
  productName: "Blame",
  protocols: [{ name: "Blame", schemes: ["blame"] }],
  artifactName: "blame-${os}-${arch}.${ext}",
  directories: {
    buildResources: ".",
    output: "dist",
  },
  extraMetadata: {
    author: {
      email: maintainerEmail,
      name: maintainerName,
    },
    description: "Agentic desktop IDE for controlled AI development workflows.",
    homepage,
    ...(releaseVersion ? { version: releaseVersion } : {}),
  },
  extraResources: [
    {
      from: "resources/runtime",
      to: "runtime",
    },
  ],
  files: ["out/**/*", "icons/prod/**/*", "package.json"],
  npmRebuild: rebuildNativeDependencies,
  linux: {
    category: "Development",
    icon: "icons/prod",
    maintainer: `${maintainerName} <${maintainerEmail}>`,
    target: ["AppImage", "deb", "rpm"],
  },
  mac: {
    minimumSystemVersion: "13.0",
    category: "public.app-category.developer-tools",
    entitlements: macosInheritedEntitlements,
    entitlementsInherit: macosInheritedEntitlements,
    extendInfo: {
      NSMicrophoneUsageDescription: "Blame uses your microphone to turn your voice into text in the editor.",
    },
    forceCodeSigning: Boolean(releaseVersion),
    hardenedRuntime: true,
    icon: "icons/prod/icon.icns",
    notarize: true,
    signIgnore: ["/Contents/Resources/runtime/macos/lima/bundle/"],
    target: ["dmg", "zip"],
  },
  nsis: {
    allowToChangeInstallationDirectory: true,
    installerHeaderIcon: "icons/prod/icon.ico",
    installerIcon: "icons/prod/icon.ico",
    oneClick: false,
  },
  publish,
  win: {
    icon: "icons/prod/icon.ico",
    target: ["nsis"],
  },
}

export default config
