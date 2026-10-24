// Provisions a Lima base image without booting it. The image's root file
// system is mounted through a loop device and the provisioner runs in a
// chroot, so it only works for an image of the host's architecture: every
// program then runs natively. GitHub's Arm runners have no KVM, and booting
// the image there to provision it used to take about an hour under emulation.
// Requires a Linux host with sudo (or root), qemu-img, sfdisk, losetup and
// e2fsprogs. The caller still boots the result once to verify it.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sha256File } from "./file-sha256.mjs";

// Same size as the disk of the boot-based builder.
const diskSize = "20G";
const linuxFilesystem = "0FC63DAF-8483-4772-8E79-3D69D8477DE4";
const chrootPath =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * @param {object} options
 * @param {{ url: string, sha256: string }} options.baseImage
 * @param {string} options.workDirectory empty directory for the build
 * @param {string} options.outputImage compressed qcow2 to write
 * @param {string} options.provisioner shell script run with `sh -s`
 * @param {string[]} options.provisionerArgs
 * @param {string[]} options.environment `NAME=value` assignments
 * @param {{ source: string, target: string }[]} options.files copied in first
 * @param {string} options.finalizer shell script run after provisioning
 */
export async function provisionImageInChroot(options) {
  const { workDirectory } = options;
  const base = join(workDirectory, "base.img");
  const disk = join(workDirectory, "disk.raw");
  const root = join(workDirectory, "root");
  await mkdir(root, { recursive: true });
  await downloadVerified(options.baseImage, base);
  await run("qemu-img", ["convert", "-O", "raw", base, disk]);
  await rm(base, { force: true });
  const partition = await growRootPartition(disk);

  const loop = (
    await output(...sudo("losetup", [
      "--find",
      "--show",
      "--offset",
      String(partition.offset),
      "--sizelimit",
      String(partition.size),
      disk,
    ]))
  ).trim();
  try {
    await checkFilesystem(loop);
    await run(...sudo("resize2fs", [loop]));
    await run(...sudo("mount", [loop, root]));
    try {
      await mountSystem(root);
      await prepareChroot(root, options.files);
      await chroot(root, options.environment, options.provisioner, [
        "sh",
        "-s",
        "--",
        ...options.provisionerArgs,
      ]);
      await chroot(root, [], options.finalizer, ["sh", "-s"]);
      await run(...sudo("rm", ["-f", join(root, "usr/sbin/policy-rc.d")]));
      // Deleted files would otherwise stay in the image as data blocks. Their
      // blocks are only free, and trimmable, once the journal is committed.
      await run(...sudo("sync", ["--file-system", root]));
      await run(...sudo("fstrim", ["--verbose", root]));
    } finally {
      await run(...sudo("umount", ["--recursive", root])).catch(() =>
        run(...sudo("umount", ["--recursive", "--lazy", root])),
      );
    }
  } finally {
    await run(...sudo("losetup", ["--detach", loop]));
  }

  await rm(options.outputImage, { force: true });
  await run("qemu-img", [
    "convert",
    "-S",
    "4k",
    "-O",
    "qcow2",
    "-c",
    disk,
    options.outputImage,
  ]);
  await run("qemu-img", ["check", options.outputImage]);
  await rm(disk, { force: true });
}

async function downloadVerified({ url, sha256 }, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body)
    throw new Error(`Cannot download ${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  const actual = await sha256File(destination);
  if (actual !== sha256)
    throw new Error(`${url} has sha256 ${actual}, expected ${sha256}`);
}

// Cloud images keep the root file system in the last partition. Grow the disk
// and that partition, as cloud-init would on a first boot.
async function growRootPartition(disk) {
  await run("qemu-img", ["resize", "-f", "raw", disk, diskSize]);
  await run("sfdisk", ["--relocate", "gpt-bak-std", disk]);
  const root = rootPartition(await partitionTable(disk));
  const number = root.node.slice(disk.length);
  await run("sfdisk", ["--no-reread", "--no-tell-kernel", "-N", number, disk], ",+\n");
  const grown = rootPartition(await partitionTable(disk));
  return {
    offset: grown.start * grown.sectorSize,
    size: grown.size * grown.sectorSize,
  };
}

async function partitionTable(disk) {
  const { partitiontable } = JSON.parse(await output("sfdisk", ["--json", disk]));
  return partitiontable;
}

export function rootPartition(table) {
  const candidates = table.partitions.filter(
    (partition) => partition.type?.toUpperCase() === linuxFilesystem,
  );
  if (!candidates.length) throw new Error("The image has no Linux partition.");
  const root = candidates.reduce((largest, partition) =>
    partition.size > largest.size ? partition : largest,
  );
  const last = table.partitions.reduce((latest, partition) =>
    partition.start > latest.start ? partition : latest,
  );
  if (root !== last)
    throw new Error("The root partition is not the last one and cannot grow.");
  return { ...root, sectorSize: table.sectorsize ?? 512 };
}

async function checkFilesystem(device) {
  // 1 means e2fsck fixed something, which is fine before a resize.
  await run(...sudo("e2fsck", ["-p", "-f", device])).catch(async (error) => {
    if (!String(error.message).endsWith("exited with 1")) throw error;
  });
}

async function mountSystem(root) {
  await run(...sudo("mount", ["--bind", "/dev", join(root, "dev")]));
  await run(...sudo("mount", ["--bind", "/dev/pts", join(root, "dev/pts")]));
  await run(...sudo("mount", ["-t", "proc", "proc", join(root, "proc")]));
  await run(...sudo("mount", ["-t", "sysfs", "sysfs", join(root, "sys")]));
  // Ubuntu's resolv.conf points into /run: a tmpfs keeps the image unchanged.
  await run(...sudo("mount", ["-t", "tmpfs", "tmpfs", join(root, "run")]));
}

async function prepareChroot(root, files) {
  const staging = join(dirname(root), "staging");
  await mkdir(staging, { recursive: true });
  await install(staging, root, await resolvConfTarget(root), await hostResolvConf());
  // Packages must not start services in a system that is not running.
  await install(staging, root, "usr/sbin/policy-rc.d", "#!/bin/sh\nexit 101\n", "0755");
  for (const file of files) {
    await run(...sudo("install", ["-D", "-m", "0644", file.source,
      join(root, file.target)]));
  }
}

// The file /etc/resolv.conf resolves to, which must lie on the /run tmpfs.
async function resolvConfTarget(root) {
  const link = await readlink(join(root, "etc/resolv.conf")).catch(() => undefined);
  if (!link) throw new Error("The image's /etc/resolv.conf is not a symbolic link.");
  const target = posix.normalize(
    link.startsWith("/") ? link : posix.join("/etc", link),
  ).slice(1);
  if (!target.startsWith("run/"))
    throw new Error(`The image's /etc/resolv.conf points outside /run: ${link}`);
  return target;
}

async function hostResolvConf() {
  for (const file of ["/run/systemd/resolve/resolv.conf", "/etc/resolv.conf"]) {
    const content = await readFile(file, "utf8").catch(() => undefined);
    if (content) return content;
  }
  throw new Error("The host has no resolv.conf to share with the chroot.");
}

async function install(staging, root, target, content, mode = "0644") {
  const source = join(staging, target.replaceAll("/", "_"));
  await writeFile(source, content, "utf8");
  await run(...sudo("install", ["-D", "-m", mode, source, join(root, target)]));
}

function chroot(root, environment, script, command) {
  return run(...sudo("chroot", [
    root,
    "/usr/bin/env",
    "-i",
    `PATH=${chrootPath}`,
    "HOME=/root",
    "LANG=C.UTF-8",
    "DEBIAN_FRONTEND=noninteractive",
    ...environment,
    ...command,
  ]), script);
}

function sudo(command, args) {
  return process.getuid?.() === 0
    ? [command, args]
    : ["sudo", ["-n", command, ...args]];
}

export async function hostCanChroot() {
  if (process.platform !== "linux") return false;
  for (const tool of ["sfdisk", "losetup", "resize2fs", "e2fsck", "chroot"]) {
    const found = await Promise.any(
      ["/usr/sbin", "/usr/bin", "/sbin", "/bin"].map((dir) => access(join(dir, tool))),
    ).then(() => true, () => false);
    if (!found) return false;
  }
  return true;
}

function run(command, args, input) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    });
    if (input !== undefined) child.stdin.end(input);
    child.once("error", rejectRun);
    child.once("exit", (code) =>
      code === 0
        ? resolveRun()
        : rejectRun(new Error(`${command} ${args.join(" ")} exited with ${code}`)),
    );
  });
}

function output(command, args) {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", rejectOutput);
    child.once("exit", (code) =>
      code === 0
        ? resolveOutput(stdout)
        : rejectOutput(new Error(`${command} ${args.join(" ")} exited with ${code}`)),
    );
  });
}
