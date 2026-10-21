import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { loadEnvFiles } from "../../../scripts/env-files.mjs";
import { prepareRuntimeManifests } from "../../../scripts/runtime-manifest.mjs";
import {
  buildSemanticHarnessPayload,
  semanticHarnessPayloadPath,
} from "../../../scripts/semantic-harness-payload.mjs";

import { verifyStagedWorkspaceRuntime, verifyPackagedWorkspaceRuntime } from "./package-integrity.mjs";
import { pruneNodeModules } from "./package-prune.mjs";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = resolve(desktopDir, "../..");
const workspaceFile = join(rootDir, "pnpm-workspace.yaml");
const packageArgs = process.argv.slice(2);
const args = packageArgs[0] === "--" ? packageArgs.slice(1) : packageArgs;

await loadEnvFiles(rootDir);
assertSingleMacosArchitecture(args);

const stagingDir = await mkdtemp(
  join(stagingParentDir(), "blame-desktop-package-"),
);
const deployDir =
  process.platform === "win32" ? basename(stagingDir) : stagingDir;

try {
  await deployPackage(deployDir, args);
  const pruned = await pruneNodeModules(stagingDir, {
    platform: builderTargetPlatform(args),
    arch: builderTargetArchitecture(args),
  });
  console.log(
    `Pruned ${pruned.files} unused dependency files (${Math.round(pruned.bytes / 1048576)} MB)`,
  );
  const runtimeManifests = await prepareRuntimeManifests(
    join(stagingDir, "resources/runtime"),
    runtimePackagingOptions(args),
  );
  await buildSemanticHarnessPayload({
    runtimeVersion: runtimeManifests.macos.runtimeVersion,
    outputPaths: [
      semanticHarnessPayloadPath(
        join(stagingDir, "resources/runtime"),
        "macos",
      ),
      semanticHarnessPayloadPath(
        join(stagingDir, "resources/runtime"),
        "windows",
      ),
    ],
  });
  await rm(join(stagingDir, "out"), { force: true, recursive: true });
  await cp(join(desktopDir, "out"), join(stagingDir, "out"), {
    recursive: true,
  });
  await verifyStagedWorkspaceRuntime(stagingDir);
  const builderEnvironment = await electronBuilderEnvironment(args, stagingDir);
  await run(
    "pnpm",
    [
      "exec",
      "electron-builder",
      "--projectDir",
      stagingDir,
      "--config",
      join(stagingDir, "electron-builder.config.ts"),
      ...args,
    ],
    rootDir,
    builderEnvironment,
  );
  await verifyPackagedWorkspaceRuntime(join(stagingDir, "dist"));
  await preserveRuntimeArtifacts(join(stagingDir, "dist"));
  await rm(join(desktopDir, "dist"), { force: true, recursive: true });
  await cp(join(stagingDir, "dist"), join(desktopDir, "dist"), {
    recursive: true,
    verbatimSymlinks: true,
  });
} finally {
  await rm(stagingDir, { force: true, recursive: true });
}

function runtimePackagingOptions(builderArgs) {
  const requirePrebuilt = releaseRuntimeRequired();
  const targetPlatform = builderTargetPlatform(builderArgs);
  if (targetPlatform === "win32") {
    const architecture =
      builderArgs.includes("--arm64") ||
      (!builderArgs.includes("--x64") && process.arch === "arm64")
        ? "arm64"
        : "amd64";
    return {
      requireWindowsPrebuiltArchitecture: requirePrebuilt
        ? architecture
        : undefined,
    };
  }
  if (targetPlatform === "darwin") {
    const architecture = builderArgs.includes("--x64")
      ? "x86_64"
      : builderArgs.includes("--arm64") || process.arch === "arm64"
        ? "aarch64"
        : "x86_64";
    return {
      macosBundleArchitecture: architecture,
      requireMacosPrebuiltArchitecture: requirePrebuilt
        ? architecture
        : undefined,
    };
  }
  return {};
}

function builderTargetArchitecture(builderArgs) {
  if (builderArgs.includes("--arm64")) return "arm64";
  if (builderArgs.includes("--x64")) return "x64";
  return process.arch;
}

function builderTargetPlatform(builderArgs) {
  if (builderArgs.some((arg) => arg === "--win" || arg === "win"))
    return "win32";
  if (builderArgs.some((arg) => arg === "--mac" || arg === "mac"))
    return "darwin";
  if (builderArgs.some((arg) => arg === "--linux" || arg === "linux"))
    return "linux";
  return process.platform;
}

async function electronBuilderEnvironment(builderArgs, temporaryDirectory) {
  const targetPlatform = builderTargetPlatform(builderArgs);
  const environment = {
    ...process.env,
    BLAME_DESKTOP_NPM_REBUILD: String(targetPlatform === process.platform),
    JITI_FS_CACHE: "false",
  };
  if (targetPlatform !== "darwin") return environment;

  environment.CSC_LINK ||= environment.MAC_CSC_LINK;
  environment.CSC_KEY_PASSWORD ||= environment.MAC_CSC_KEY_PASSWORD;

  const encodedApiKey = environment.APPLE_API_KEY_P8_B64?.trim();
  if (!environment.APPLE_API_KEY && encodedApiKey) {
    const apiKey = Buffer.from(encodedApiKey.replace(/\s/g, ""), "base64");
    if (!apiKey.toString("utf8").includes("-----BEGIN PRIVATE KEY-----")) {
      throw new Error(
        "APPLE_API_KEY_P8_B64 is not a valid App Store Connect API key",
      );
    }
    const keyId = environment.APPLE_API_KEY_ID?.trim() || "notarization";
    const apiKeyPath = join(temporaryDirectory, `AuthKey_${keyId}.p8`);
    await writeFile(apiKeyPath, apiKey, { mode: 0o600 });
    environment.APPLE_API_KEY = apiKeyPath;
  }

  if (environment.BLAME_VERSION?.trim()) {
    for (const name of [
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "APPLE_API_KEY",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
    ]) {
      if (!environment[name]?.trim()) {
        throw new Error(`${name} is required for a signed macOS release`);
      }
    }
  }

  return environment;
}

function assertSingleMacosArchitecture(builderArgs) {
  if (
    builderTargetPlatform(builderArgs) === "darwin" &&
    builderArgs.includes("--x64") &&
    builderArgs.includes("--arm64")
  ) {
    throw new Error(
      "macOS x64 and arm64 packages must be staged separately so each app embeds the matching Lima bundle. Use `pnpm build:desktop --mac --x64 --arm64`.",
    );
  }
}

function releaseRuntimeRequired() {
  const explicit = process.env.BLAME_REQUIRE_PREBUILT_RUNTIME?.trim();
  if (explicit) return explicit === "true";
  return Boolean(process.env.BLAME_VERSION?.trim());
}

async function preserveRuntimeArtifacts(stagedDist) {
  const runtimeDist = join(desktopDir, "dist/runtime");
  try {
    await access(runtimeDist);
  } catch {
    return;
  }
  await cp(runtimeDist, join(stagedDist, "runtime"), { recursive: true });
}

async function deployPackage(targetDir, builderArgs) {
  const supportedArchitectures = targetSupportedArchitectures(builderArgs);
  if (!supportedArchitectures) {
    await runDeploy(targetDir);
    return;
  }

  const workspaceConfig = await readFile(workspaceFile, "utf8");
  const updatedConfig = YAML.parse(workspaceConfig);
  updatedConfig.supportedArchitectures = supportedArchitectures;

  try {
    await writeFile(workspaceFile, YAML.stringify(updatedConfig), "utf8");
    await runDeploy(targetDir);
  } finally {
    await writeFile(workspaceFile, workspaceConfig, "utf8");
  }
}

// Platform-specific optional dependencies (native binaries) are installed for
// the target, not for the machine that packages it.
function targetSupportedArchitectures(builderArgs) {
  const platform = builderTargetPlatform(builderArgs);
  if (platform === "darwin") {
    const arch = builderTargetArchitecture(builderArgs);
    if (process.platform === "darwin" && arch === process.arch) return undefined;
    return { cpu: [arch], os: ["darwin"] };
  }
  if (platform !== "win32") return undefined;

  const cpu = [];
  if (builderArgs.includes("--x64")) cpu.push("x64");
  if (builderArgs.includes("--arm64")) cpu.push("arm64");
  if (builderArgs.includes("--ia32")) cpu.push("ia32");

  return {
    cpu: cpu.length ? cpu : ["x64"],
    os: ["win32"],
  };
}

async function runDeploy(targetDir) {
  await run(
    "pnpm",
    ["--filter", "@blame/desktop", "deploy", "--prod", "--legacy", targetDir],
    rootDir,
  );
}

function run(command, args, cwd, env = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else
        rejectRun(
          new Error(`${command} ${args.join(" ")} exited with ${code}`),
        );
    });
  });
}

function stagingParentDir() {
  const customDir = process.env.BLAME_DESKTOP_PACKAGE_DIR?.trim();
  if (customDir) return resolve(customDir);
  if (process.platform === "darwin") return tmpdir();
  return rootDir;
}
