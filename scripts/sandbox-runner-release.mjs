import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const action = process.argv[2];
const image = process.env.BLAME_SANDBOX_RUNNER_IMAGE_TAG;
if (!image) throw new Error("BLAME_SANDBOX_RUNNER_IMAGE_TAG is required");
if (!new Set(["build", "release", "sign"]).has(action))
  throw new Error("Expected build, release or sign");
// Exceptions for critical findings without a fixed upstream build.
const grypeArgs = [
  "--config",
  "packages/sandbox-runner/grype.yaml",
  "--fail-on",
  "critical",
];
const runnerPackage = JSON.parse(
  await readFile("packages/sandbox-runner/package.json", "utf8"),
);
const runnerVersion = runnerPackage.version;
if (!/^\d+\.\d+\.\d+$/.test(runnerVersion)) {
  throw new Error(
    "Sandbox runner package version must use semantic versioning",
  );
}

if (action === "sign") {
  // Signs an already published digest again, e.g. after an expired Sigstore
  // login, without rebuilding a new unsigned image.
  const publishedDigest = process.argv[3];
  if (!/^sha256:[a-f0-9]{64}$/.test(publishedDigest ?? ""))
    throw new Error("Expected the published sha256 digest to sign");
  const immutableImage = `${imageRepository(image)}@${publishedDigest}`;
  await command("grype", [immutableImage, ...grypeArgs]);
  await sign(immutableImage, publishedDigest);
} else {
  await command("pnpm", ["--filter", "@blame/sandbox-runner", "build"]);
  await buildImage("build");
}
if (action === "release") {
  await command("grype", [`docker:${image}`, ...grypeArgs]);
  await buildImage("release");
  const digest = await output("docker", [
    "buildx",
    "imagetools",
    "inspect",
    image,
    "--format",
    "{{json .Manifest.Digest}}",
  ]);
  if (!/^"sha256:[a-f0-9]{64}"$/.test(digest.trim()))
    throw new Error("Published runner digest is unavailable");
  const publishedDigest = JSON.parse(digest);
  const immutableImage = `${imageRepository(image)}@${publishedDigest}`;
  await command("grype", [immutableImage, ...grypeArgs]);
  await sign(immutableImage, publishedDigest);
}

async function sign(immutableImage, publishedDigest) {
  if (immutableImage.startsWith("vcr.vercel.com/")) {
    const signatureImage = await signForVercelRegistry(
      immutableImage,
      publishedDigest,
    );
    console.log(`Sigstore bundle: ${signatureImage}`);
  } else {
    await command("cosign", ["sign", "--yes", immutableImage]);
  }
  console.log(immutableImage);
}

async function buildImage(mode) {
  const release = mode === "release";
  await command("docker", [
    "buildx",
    "build",
    "--platform",
    "linux/amd64",
    "--file",
    "packages/sandbox-runner/Dockerfile",
    "--tag",
    image,
    "--build-arg",
    `BLAME_RUNNER_VERSION=${runnerVersion}`,
    ...(release ? ["--sbom=true", "--provenance=mode=max"] : []),
    release ? "--push" : "--load",
    ".",
  ]);
}

async function signForVercelRegistry(immutableImage, digest) {
  // VCR accepts standard OCI images but currently rejects both the Cosign v3
  // bundle layer and the legacy simple-signing layer. Keep the signature
  // verifiable and project-scoped by packaging its detached Sigstore bundle in
  // a minimal, ordinary OCI image whose tag is derived from the signed digest.
  const context = await mkdtemp(join(tmpdir(), "blame-runner-signature-"));
  const bundle = join(context, "signature.sigstore.json");
  const manifest = join(context, "manifest.json");
  try {
    await command("cosign", [
      "sign",
      "--yes",
      "--upload=false",
      "--bundle",
      bundle,
      immutableImage,
    ]);
    const rawManifest = await output("docker", [
      "buildx",
      "imagetools",
      "inspect",
      "--raw",
      immutableImage,
    ]);
    await writeFile(manifest, rawManifest);
    await quietCommand("cosign", [
      "verify-blob",
      "--bundle",
      bundle,
      "--certificate-identity-regexp",
      ".+",
      "--certificate-oidc-issuer-regexp",
      ".+",
      manifest,
    ]);

    const signatureRepository = `${imageRepository(immutableImage)}-signatures`;
    const signatureTag = `${signatureRepository}:sha256-${digest.slice("sha256:".length)}`;
    await command("docker", [
      "buildx",
      "build",
      "--platform",
      "linux/amd64",
      "--file",
      "packages/sandbox-runner/Signature.Dockerfile",
      "--build-arg",
      `BLAME_SIGNED_IMAGE=${immutableImage}`,
      "--tag",
      signatureTag,
      "--push",
      context,
    ]);
    const signatureDigest = await output("docker", [
      "buildx",
      "imagetools",
      "inspect",
      signatureTag,
      "--format",
      "{{json .Manifest.Digest}}",
    ]);
    if (!/^"sha256:[a-f0-9]{64}"$/.test(signatureDigest.trim())) {
      throw new Error("Published Sigstore bundle digest is unavailable");
    }
    return `${signatureRepository}@${JSON.parse(signatureDigest)}`;
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

function imageRepository(value) {
  const withoutDigest = value.split("@", 1)[0];
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

function command(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${program} failed (${code})`)),
    );
  });
}

function quietCommand(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${program} failed (${code})`)),
    );
  });
}

function output(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let value = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (value += chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(value)
        : reject(new Error(`${program} failed (${code})`)),
    );
  });
}
