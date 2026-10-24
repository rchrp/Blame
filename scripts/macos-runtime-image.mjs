import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadEnvFiles, requiredEnv, text } from "./env-files.mjs";
import { hostCanChroot, provisionImageInChroot } from "./lima-image-chroot.mjs";
import { resolveLimaBundle } from "./lima-runtime-bundle.mjs";
import { sha256File } from "./file-sha256.mjs";
import { runtimeLimaImageFileName } from "./runtime-manifest.mjs";
import { runtimeClineSdkVersion } from "./runtime-sdk-version.mjs";
import { prepareSemanticHarnessPayload } from "./semantic-harness-payload.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(rootDir, "packages/desktop");
const runtimeRoot = join(desktopDir, "resources/runtime/macos");
const manifestPath = join(runtimeRoot, "manifest.json");
const provisionerPath = join(runtimeRoot, "scripts/provision-blame-runtime.sh");
const outputDir = join(desktopDir, "dist/runtime/macos");
const buildRoot = join(tmpdir(), "blame-runtime-macos");
const semanticHarnessPayload = join(buildRoot, "blame-semantic-harness.tgz");
const architectures = ["x86_64", "aarch64"];
const instanceStartTimeout = "30m";
const command = process.argv[2] ?? "help";
const rawArgs = process.argv.slice(3);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

await loadEnvFiles(rootDir);

if (command === "build") await buildImages();
else if (command === "verify") await verifyImages();
else {
  printHelp();
  process.exit(command === "help" ? 0 : 1);
}

async function buildImages() {
  if (process.platform !== "linux")
    throw new Error("The Lima image builder currently requires a Linux host.");
  await assertExecutable(
    "qemu-img",
    "qemu-img is required to build Lima runtime images.",
  );
  await mkdir(outputDir, { recursive: true });
  await mkdir(buildRoot, { recursive: true });
  await prepareSemanticHarnessPayload({
    runtimeVersion: requiredRuntimeVersion(),
    outputPaths: [semanticHarnessPayload],
  });
  for (const architecture of selectedArchitectures()) {
    await buildImage(architecture);
  }
}

async function buildImage(architecture) {
  await assertQemuArchitecture(architecture);
  const manifest = await runtimeManifest();
  const bundle = await resolveLimaBundle(manifest, "linux", hostArchitecture());
  const runtimeVersion = requiredRuntimeVersion();
  const buildId = `${runtimeVersion}-${architecture}-${process.pid}`;
  const limaHome = join(buildRoot, buildId);
  // Outside LIMA_HOME: Lima treats every directory there as an instance.
  const chrootDirectory = join(buildRoot, `${buildId}-chroot`);
  const instanceName = "build";
  const templatePath = join(limaHome, "builder.yaml");
  const outputPath = join(
    outputDir,
    runtimeLimaImageFileName(architecture, runtimeVersion),
  );
  const temporaryOutputPath = `${outputPath}.building-${process.pid}`;
  const environment = limaEnvironment(bundle, limaHome);

  await rm(limaHome, { force: true, recursive: true });
  await mkdir(limaHome, { recursive: true });

  try {
    // Provisioning in a chroot runs natively and takes minutes; booting the
    // image to provision it is the fallback for another architecture.
    if (architecture === hostArchitecture() && (await hostCanChroot())) {
      await provisionImageInChroot({
        baseImage: baseImage(manifest, architecture),
        workDirectory: chrootDirectory,
        outputImage: temporaryOutputPath,
        provisioner: await readFile(provisionerPath, "utf8"),
        provisionerArgs: [runtimeVersion, await runtimeClineSdkVersion()],
        environment: bakeEnvironment(),
        files: [
          {
            source: semanticHarnessPayload,
            target: "tmp/blame-semantic-harness.tgz",
          },
        ],
        setup: builderUserCommand,
        finalizer: finalizeCommands().join("\n"),
      });
    } else {
      await writeFile(
        templatePath,
        builderTemplate(manifest, architecture),
        "utf8",
      );
      await startInstance(bundle, instanceName, templatePath, environment);
      await provisionImage(bundle, instanceName, environment);
      await finalizeImage(bundle, instanceName, environment);
      await waitForStoppedInstance(bundle, instanceName, environment);
      await flattenImage(
        join(limaHome, instanceName, "disk"),
        temporaryOutputPath,
      );
    }
    await verifyImage(bundle, architecture, temporaryOutputPath, environment);
    await rename(temporaryOutputPath, outputPath);
    console.log(`Built ${outputPath}`);
  } finally {
    await bestEffortLimactl(
      bundle,
      ["delete", "--force", instanceName],
      environment,
    );
    await rm(temporaryOutputPath, { force: true });
    await rm(limaHome, { force: true, recursive: true });
    await rm(chrootDirectory, { force: true, recursive: true });
  }
}

async function verifyImages() {
  if (process.platform !== "linux")
    throw new Error("The Lima image verifier currently requires a Linux host.");
  for (const architecture of selectedArchitectures()) {
    await verifyExistingImage(architecture);
  }
}

async function verifyExistingImage(architecture) {
  await assertQemuArchitecture(architecture);
  const manifest = await runtimeManifest();
  const bundle = await resolveLimaBundle(manifest, "linux", hostArchitecture());
  const runtimeVersion = requiredRuntimeVersion();
  const limaHome = join(
    buildRoot,
    `${runtimeVersion}-verify-${architecture}-${process.pid}`,
  );
  const image = join(
    outputDir,
    runtimeLimaImageFileName(architecture, runtimeVersion),
  );
  await mkdir(limaHome, { recursive: true });
  try {
    await verifyImage(
      bundle,
      architecture,
      image,
      limaEnvironment(bundle, limaHome),
    );
  } finally {
    await rm(limaHome, { force: true, recursive: true });
  }
}

async function verifyImage(bundle, architecture, image, environment) {
  await access(image);
  const instanceName = "verify";
  const templatePath = join(environment.LIMA_HOME, "verify.yaml");
  await writeFile(
    templatePath,
    await verificationTemplate(image, architecture),
    "utf8",
  );
  try {
    await startInstance(bundle, instanceName, templatePath, environment).catch(
      async (error) => {
        await printBootLog(join(environment.LIMA_HOME, instanceName));
        throw error;
      },
    );
    await verifyRuntime(bundle, instanceName, environment);
    console.log(`Verified ${image}`);
  } finally {
    await bestEffortLimactl(
      bundle,
      ["delete", "--force", instanceName],
      environment,
    );
  }
}

// Lima deletes the instance afterwards: show why the image did not boot.
async function printBootLog(instanceDirectory) {
  for (const file of ["serial.log", "serialv.log", "ha.stderr.log"]) {
    const content = await readFile(join(instanceDirectory, file), "utf8").catch(
      () => undefined,
    );
    if (!content) continue;
    console.error(`--- last lines of ${file}`);
    console.error(content.split("\n").slice(-60).join("\n"));
  }
}

async function verifyRuntime(bundle, instanceName, environment) {
  const runtimeVersion = requiredRuntimeVersion();
  const clineSdkVersion = await runtimeClineSdkVersion();
  const nodeVersion = requiredNodeVersion();
  const checks = [
    "set -eu",
    `grep -qx ${JSON.stringify(runtimeVersion)} /etc/blame-runtime-version`,
    "test -x /usr/local/bin/blame-runtime-agent",
    `blame-runtime-agent version | grep -qx ${JSON.stringify(runtimeVersion)}`,
    `node -e 'process.exit(process.versions.node === process.argv[1] ? 0 : 1)' ${JSON.stringify(nodeVersion)}`,
    `node "$(npm root -g)/@blame/semantic-harness-runtime/runtime-sdk-check.mjs" ${JSON.stringify(clineSdkVersion)}`,
    "command -v blame-semantic-harness",
    "test -s /etc/blame-semantic-harness-sha256",
    "test \"$(/opt/blame/package-managers/pnpm/10.33.2/bin/pnpm --version)\" = \"10.33.2\"",
    "test \"$(/opt/blame/package-managers/npm/11.6.4/bin/npm --version)\" = \"11.6.4\"",
    "test \"$(/opt/blame/package-managers/yarn/1.22.22/bin/yarn --version)\" = \"1.22.22\"",
    `test -z "$(find "$(npm root -g)" -type d \\( -path "*/node_modules/@openai/codex-linux-*" -o -path "*/node_modules/@anthropic-ai/claude-agent-sdk-linux-*" \\) -print -quit)"`,
    "docker --version",
    "dockerd --version",
    "test -x /usr/local/bin/docker-init",
    "docker compose version",
    "docker buildx version",
    "test -s /etc/docker/daemon.json",
    "id blame",
    // Lima creates its own user with UID 1000 on a user's first boot.
    'test "$(id -u blame)" = 1001',
    "! id blamebuilder >/dev/null 2>&1",
  ].join("\n");
  await runLimactl(
    bundle,
    ["shell", instanceName, "sudo", "-n", "sh", "-lc", checks],
    environment,
  );
}

async function startInstance(bundle, instanceName, templatePath, environment) {
  await runLimactl(
    bundle,
    [
      "start",
      "--name",
      instanceName,
      `--timeout=${instanceStartTimeout}`,
      "--tty=false",
      templatePath,
    ],
    environment,
  );
}

async function verificationTemplate(image, architecture) {
  return [
    "vmType: qemu",
    `arch: ${architecture}`,
    "plain: true",
    "images:",
    `  - location: ${JSON.stringify(image)}`,
    `    arch: ${architecture}`,
    `    digest: ${JSON.stringify(`sha256:${await sha256File(image)}`)}`,
    "cpus: 2",
    'memory: "2GiB"',
    'disk: "20GiB"',
    ...qemuFirmwareConfiguration(architecture),
    "mounts: []",
    "containerd:",
    "  system: false",
    "  user: false",
    "networks: []",
    "user:",
    "  name: blamecheck",
    "  uid: 1000",
    '  home: "/home/blamecheck"',
    '  shell: "/bin/bash"',
    "",
  ].join("\n");
}

async function provisionImage(bundle, instanceName, environment) {
  const runtimeVersion = requiredRuntimeVersion();
  const clineSdkVersion = await runtimeClineSdkVersion();
  const provisioner = await readFile(provisionerPath, "utf8");
  await runLimactl(
    bundle,
    [
      "copy",
      semanticHarnessPayload,
      `${instanceName}:/tmp/blame-semantic-harness.tgz`,
    ],
    environment,
  );
  await runLimactl(
    bundle,
    [
      "shell",
      instanceName,
      "sudo",
      "-n",
      "env",
      ...bakeEnvironment(),
      "sh",
      "-s",
      "--",
      runtimeVersion,
      clineSdkVersion,
    ],
    environment,
    provisioner,
  );
}

// The VM builder logs in as this user, created by Lima with UID 1000 before
// provisioning, and finalizeCommands deletes it. The chroot creates it too, so
// the provisioned blame user still gets UID 1001 and leaves UID 1000 free for
// the user Lima creates on a user's first boot.
const builderUserCommand =
  "useradd --uid 1000 --user-group --create-home --shell /bin/bash blamebuilder";

function bakeEnvironment() {
  return [
    "BLAME_RUNTIME_BAKE=1",
    ...dockerVersionAssignments(),
    `BLAME_NODE_VERSION=${requiredNodeVersion()}`,
  ];
}

// Leaves no build state behind, so the first boot of a user's VM runs
// cloud-init from scratch.
function finalizeCommands() {
  return [
    "set -eu",
    "cd /",
    "cloud-init clean --logs --seed >/dev/null 2>&1 || true",
    "rm -rf /home/blamebuilder/.ssh /root/.ssh /var/lib/cloud/instances/*",
    "rm -f /etc/ssh/ssh_host_* /var/lib/dbus/machine-id",
    ": >/etc/machine-id",
    "apt-get clean >/dev/null 2>&1 || true",
    "rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /root/.npm /root/.cache",
    "find /var/log -type f -exec truncate -s 0 {} \\; >/dev/null 2>&1 || true",
    "userdel --force --remove blamebuilder >/dev/null 2>&1 || true",
  ];
}

async function finalizeImage(bundle, instanceName, environment) {
  const script = [
    ...finalizeCommands(),
    "sync",
    "fstrim -av >/dev/null 2>&1 || true",
    "nohup sh -c 'sleep 1; poweroff' >/dev/null 2>&1 &",
  ].join("\n");
  await runLimactl(
    bundle,
    ["shell", instanceName, "sudo", "-n", "sh", "-s"],
    environment,
    script,
  );
}

async function waitForStoppedInstance(bundle, instanceName, environment) {
  if (await instanceStopsWithin(bundle, instanceName, environment, 60)) return;
  await runLimactl(
    bundle,
    ["stop", "--force", "--tty=false", instanceName],
    environment,
  );
  if (!(await instanceStopsWithin(bundle, instanceName, environment, 10)))
    throw new Error(`Lima builder instance ${instanceName} did not stop.`);
}

async function instanceStopsWithin(
  bundle,
  instanceName,
  environment,
  attempts,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await instanceState(bundle, instanceName, environment)) === "Stopped")
      return true;
    await delay(1000);
  }
  return false;
}

async function instanceState(bundle, instanceName, environment) {
  const result = await output(
    limactlPath(bundle),
    ["list", "--json", instanceName],
    environment,
  );
  if (!result.trim()) return "Missing";
  return JSON.parse(result).status;
}

async function flattenImage(source, destination) {
  await access(source);
  await waitForDiskUnlock(source);
  await rm(destination, { force: true });
  await run("qemu-img", [
    "convert",
    "-S",
    "4k",
    "-O",
    "qcow2",
    "-c",
    source,
    destination,
  ]);
  await run("qemu-img", ["check", destination]);
}

async function waitForDiskUnlock(image) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await output("qemu-img", ["info", "--output=json", image], process.env);
      return;
    } catch {
      await delay(1000);
    }
  }
  throw new Error(`QEMU did not release the image lock for ${image}.`);
}

function baseImage(manifest, architecture) {
  const image = manifest.baseImages[architecture];
  if (!image?.url || !image?.sha256)
    throw new Error(`Missing base image for ${architecture}.`);
  return image;
}

function builderTemplate(manifest, architecture) {
  const image = baseImage(manifest, architecture);
  return [
    "vmType: qemu",
    `arch: ${architecture}`,
    "plain: true",
    "images:",
    `  - location: ${JSON.stringify(image.url)}`,
    `    arch: ${architecture}`,
    `    digest: ${JSON.stringify(`sha256:${image.sha256}`)}`,
    "cpus: 4",
    'memory: "4GiB"',
    'disk: "20GiB"',
    ...qemuFirmwareConfiguration(architecture),
    "mounts: []",
    "containerd:",
    "  system: false",
    "  user: false",
    "networks: []",
    "user:",
    "  name: blamebuilder",
    "  uid: 1000",
    '  home: "/home/blamebuilder"',
    '  shell: "/bin/bash"',
    "",
  ].join("\n");
}

function qemuFirmwareConfiguration(architecture) {
  const firmware = text(process.env.BLAME_QEMU_AARCH64_FIRMWARE);
  if (architecture !== "aarch64" || !firmware) return [];
  return [
    "firmware:",
    "  images:",
    `    - location: ${JSON.stringify(resolve(rootDir, firmware))}`,
    "      arch: aarch64",
    "      vmType: qemu",
  ];
}

function selectedArchitectures() {
  if (args.includes("--all-architectures")) return architectures;
  const explicit = valueArg("--arch");
  const selected = explicit
    ? explicit
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [hostArchitecture()];
  for (const architecture of selected) {
    if (!architectures.includes(architecture))
      throw new Error(`Unsupported Lima architecture: ${architecture}`);
  }
  return selected;
}

function hostArchitecture() {
  return process.arch === "arm64" ? "aarch64" : "x86_64";
}

async function assertQemuArchitecture(architecture) {
  const command =
    architecture === "aarch64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
  await assertExecutable(
    command,
    `${command} is required. Install the matching QEMU system emulator and UEFI firmware.`,
  );
}

async function runtimeManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

function requiredRuntimeVersion() {
  return requiredEnv("BLAME_RUNTIME_VERSION");
}

// The Docker Engine, Compose and Buildx versions the provisioner installs;
// it pins a checksum for each.
function dockerVersionAssignments() {
  return [
    `BLAME_DOCKER_VERSION=${text(process.env.BLAME_DOCKER_VERSION) ?? "29.9.1"}`,
    `BLAME_COMPOSE_VERSION=${text(process.env.BLAME_COMPOSE_VERSION) ?? "5.6.0"}`,
    `BLAME_BUILDX_VERSION=${text(process.env.BLAME_BUILDX_VERSION) ?? "0.38.0"}`,
  ];
}

function requiredNodeVersion() {
  return text(process.env.BLAME_NODE_VERSION) ?? "22.23.1";
}

function valueArg(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function limaEnvironment(bundle, limaHome) {
  return {
    ...process.env,
    LIMA_HOME: limaHome,
    PATH: `${join(bundle, "bin")}:${process.env.PATH ?? ""}`,
  };
}

function limactlPath(bundle) {
  return join(bundle, "bin/limactl");
}

function runLimactl(bundle, commandArgs, environment, input) {
  return run(limactlPath(bundle), commandArgs, { env: environment, input });
}

async function bestEffortLimactl(bundle, commandArgs, environment) {
  try {
    await runLimactl(bundle, commandArgs, environment);
  } catch {
    return;
  }
}

async function assertExecutable(executable, message) {
  const candidates = (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .map((entry) => join(entry, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return;
    } catch {
      continue;
    }
  }
  throw new Error(message);
}

function run(commandName, commandArgs, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(commandName, commandArgs, {
      cwd: rootDir,
      env: options.env ?? process.env,
      shell: false,
      stdio: [
        options.input === undefined ? "inherit" : "pipe",
        "inherit",
        "inherit",
      ],
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else
        rejectRun(
          new Error(
            `${commandName} ${commandArgs.join(" ")} exited with ${code}`,
          ),
        );
    });
  });
}

function output(commandName, commandArgs, environment) {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(commandName, commandArgs, {
      cwd: rootDir,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectOutput);
    child.once("exit", (code) => {
      if (code === 0) resolveOutput(stdout);
      else
        rejectOutput(
          new Error(
            `${commandName} ${commandArgs.join(" ")} exited with ${code}: ${stderr}`,
          ),
        );
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function printHelp() {
  console.log(
    "Usage: node scripts/macos-runtime-image.mjs <build|verify> [--arch x86_64,aarch64] [--all-architectures]",
  );
}
