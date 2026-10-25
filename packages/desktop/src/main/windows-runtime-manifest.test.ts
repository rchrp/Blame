import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import {
  prepareMacosRuntimeManifest,
  prepareWindowsRuntimeManifest,
} from "../../../../scripts/runtime-manifest.mjs";

const execFileAsync = promisify(execFile);

type RootfsSpec = {
  kind?: string;
  sha256?: string;
  url?: string;
};

type WindowsRuntimeManifest = {
  clineSdkVersion?: string;
  rootfs?: Record<string, RootfsSpec>;
  runtimeAgentVersion?: string;
};

type MacosRuntimeManifest = WindowsRuntimeManifest & {
  baseImages?: Record<string, RootfsSpec>;
  lima?: {
    archives?: Record<string, Record<string, RootfsSpec>>;
    bin?: string;
    version?: string;
  };
  images?: Record<string, RootfsSpec>;
};

const manifestPath = path.resolve("resources/runtime/windows/manifest.json");
const managedManifestPaths = [
  path.resolve("resources/runtime/macos/manifest.json"),
  manifestPath,
];
const agentRuntimePackagePath = path.resolve("../agent-runtime/package.json");
const cloudRunnerDockerfilePath = path.resolve("../sandbox-runner/Dockerfile");

test("accepts Windows runtime rootfs specs with optional prebaked metadata", async () => {
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as WindowsRuntimeManifest;

  assertRootfsSpec(manifest.rootfs?.amd64);
  assertRootfsSpec(manifest.rootfs?.arm64);
});

test("pipes multiline Windows runtime probes through WSL standard input", async () => {
  const source = await readFile(
    path.resolve("resources/runtime/windows/scripts/blame-wsl2-runtime.ps1"),
    "utf8",
  );

  assert.match(source, /function Invoke-DistroScript/);
  assert.match(source, /function ConvertTo-UnixLineEndings/);
  assert.match(source, /RedirectStandardInput = \$true/);
  assert.match(source, /Write-Host "BLAME_RUNTIME_PROGRESS /);
  assert.doesNotMatch(source, /\$result = Invoke-Distro \$command/);
});

test("keeps managed runtime Cline SDK versions aligned with agent runtime", async () => {
  const packageJson = JSON.parse(
    await readFile(agentRuntimePackagePath, "utf8"),
  );
  const expectedVersion = normalizePackageVersion(
    packageJson.dependencies?.["@cline/sdk"],
  );

  assert.ok(expectedVersion);
  for (const path of managedManifestPaths) {
    const manifest = JSON.parse(
      await readFile(path, "utf8"),
    ) as WindowsRuntimeManifest;
    assert.equal(manifest.clineSdkVersion, expectedVersion);
  }
});

test("keeps the cloud runner Cline SDK version aligned with agent runtime", async () => {
  const packageJson = JSON.parse(
    await readFile(agentRuntimePackagePath, "utf8"),
  );
  const expectedVersion = normalizePackageVersion(
    packageJson.dependencies?.["@cline/sdk"],
  );
  const dockerfile = await readFile(cloudRunnerDockerfilePath, "utf8");

  assert.ok(expectedVersion);
  assert.match(
    dockerfile,
    new RegExp(`ARG BLAME_CLINE_SDK_VERSION=${expectedVersion}`),
  );
  assert.match(dockerfile, /"@cline\/sdk@\$\{BLAME_CLINE_SDK_VERSION\}"/);
  assert.match(dockerfile, /"@cline\/core@\$\{BLAME_CLINE_SDK_VERSION\}"/);
  assert.match(
    dockerfile,
    /BLAME_CLINE_SDK_VERSION=\$\{BLAME_CLINE_SDK_VERSION\}/,
  );
});

test("keeps managed runtime agent revisions aligned", async () => {
  for (const path of managedManifestPaths) {
    const manifest = JSON.parse(
      await readFile(path, "utf8"),
    ) as WindowsRuntimeManifest;
    assert.equal(manifest.runtimeAgentVersion, "10");
  }
});

test("pins every macOS runtime build input with a SHA-256", async () => {
  const manifest = JSON.parse(
    await readFile(managedManifestPaths[0], "utf8"),
  ) as MacosRuntimeManifest;

  assert.equal(manifest.lima?.version, "2.1.2");
  assert.equal(manifest.lima?.bin, "lima/bundle/bin");
  assertVerifiedSpecs(manifest.baseImages, ["aarch64", "x86_64"]);
  assertVerifiedSpecs(manifest.lima?.archives?.darwin, ["arm64", "x86_64"]);
  assertVerifiedSpecs(manifest.lima?.archives?.linux, ["aarch64", "x86_64"]);
});

test("keeps the Lima template while embedding its verified bundle", async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "blame-runtime-test-"));
  const runtimeRoot = path.join(testRoot, "runtime");
  const bundleRoot = path.join(testRoot, "bundle");
  const previousBundle = process.env.BLAME_LIMA_BUNDLE_DIR;

  try {
    await cp(path.resolve("resources/runtime"), runtimeRoot, {
      recursive: true,
    });
    await createFakeLimaBundle(bundleRoot);
    process.env.BLAME_LIMA_BUNDLE_DIR = bundleRoot;
    await prepareMacosRuntimeManifest(runtimeRoot, {
      macosBundleArchitecture: "x86_64",
    });
    const templatePath = path.join(
      runtimeRoot,
      "macos/lima/blame-runtime.yaml",
    );
    await access(templatePath);
    assert.match(await readFile(templatePath, "utf8"), /location: "~"/);
    await access(path.join(runtimeRoot, "macos/lima/bundle/bin/limactl"));
    await access(
      path.join(runtimeRoot, "macos/lima/bundle/share/lima/templates"),
    );
    await access(
      path.join(runtimeRoot, "macos/lima/bundle/share/doc/lima/LICENSE"),
    );
    await assert.rejects(
      access(
        path.join(runtimeRoot, "macos/lima/bundle/share/doc/lima/templates"),
      ),
    );
  } finally {
    if (previousBundle) process.env.BLAME_LIMA_BUNDLE_DIR = previousBundle;
    else delete process.env.BLAME_LIMA_BUNDLE_DIR;
    await rm(testRoot, { force: true, recursive: true });
  }
});

test("reports Lima setup progress while creating the runtime", async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "blame-lima-progress-"));
  const toolsRoot = path.join(testRoot, "tools");
  const stateRoot = path.join(testRoot, "state");
  const cacheKey = "a".repeat(64);

  try {
    const stdout = await runFakeMacosRuntimeSetup(
      testRoot,
      toolsRoot,
      stateRoot,
      cacheKey,
    );
    const progress = runtimeProgressFromOutput(stdout);
    assert.deepEqual(uniquePhases(progress), [
      "downloading",
      "verifying",
      "installing",
      "starting",
      "configuring",
      "checking",
    ]);
    assert.ok(
      progress.some((event) => Number(event.percent) > 0),
      stdout,
    );
  } finally {
    await rm(testRoot, { force: true, recursive: true });
  }
});

test("rejects Lima setup when the packaged semantic harness payload is missing", async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "blame-lima-no-payload-"));
  try {
    await assert.rejects(
      runFakeMacosRuntimeSetup(
        testRoot,
        path.join(testRoot, "tools"),
        path.join(testRoot, "state"),
        "a".repeat(64),
        { includePayload: false },
      ),
      (error: unknown) => {
        const failure = error as {
          code?: number;
          stderr?: string;
          stdout?: string;
        };
        assert.equal(failure.code, 1);
        assert.match(
          failure.stderr ?? "",
          /semantic harness runtime payload is missing/,
        );
        assert.ok(
          !runtimeProgressFromOutput(failure.stdout ?? "").some(
            (event) =>
              event.phase === "configuring" || event.phase === "checking",
          ),
        );
        return true;
      },
    );
  } finally {
    await rm(testRoot, { force: true, recursive: true });
  }
});

test("uses published immutable artifacts for release packaging", async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "blame-runtime-test-"));
  const runtimeRoot = path.join(testRoot, "runtime");
  const sha256 = "a".repeat(64);
  const publishedRuntime = {
    artifacts: {
      macos: { x86_64: { sha256, url: "https://cdn.test/macos.qcow2" } },
      windows: { amd64: { sha256, url: "https://cdn.test/windows.tar.gz" } },
    },
  };

  try {
    await cp(path.resolve("resources/runtime"), runtimeRoot, {
      recursive: true,
    });
    await prepareWindowsRuntimeManifest(runtimeRoot, {
      publishedRuntime,
      requireWindowsPrebuiltArchitecture: "amd64",
    });
    await prepareMacosRuntimeManifest(runtimeRoot, {
      publishedRuntime,
      requireMacosPrebuiltArchitecture: "x86_64",
    });
    const windows = await readRuntimeManifest(runtimeRoot, "windows");
    const macos = await readRuntimeManifest(runtimeRoot, "macos");
    assert.equal(windows.rootfs?.amd64.url, "https://cdn.test/windows.tar.gz");
    assert.equal(macos.images?.x86_64.url, "https://cdn.test/macos.qcow2");
  } finally {
    await rm(testRoot, { force: true, recursive: true });
  }
});

function assertRootfsSpec(spec: RootfsSpec | undefined) {
  assert.ok(spec?.url);
  assert.ok(!spec.kind || ["ubuntu", "blame-prebaked"].includes(spec.kind));
  assert.ok(!spec.sha256 || /^[a-f0-9]{64}$/i.test(spec.sha256));
}

function assertVerifiedSpecs(
  specs: Record<string, RootfsSpec> | undefined,
  architectures: string[],
) {
  for (const architecture of architectures) {
    const spec = specs?.[architecture];
    assert.ok(spec?.url);
    assert.match(spec.sha256 ?? "", /^[a-f0-9]{64}$/i);
  }
}

async function createFakeLimaBundle(bundleRoot: string) {
  const binRoot = path.join(bundleRoot, "bin");
  const documentationRoot = path.join(bundleRoot, "share/doc/lima");
  await mkdir(binRoot, { recursive: true });
  await mkdir(documentationRoot, { recursive: true });
  await mkdir(path.join(bundleRoot, "share/lima/templates"), {
    recursive: true,
  });
  await writeFile(path.join(binRoot, "limactl"), "", { mode: 0o755 });
  await writeFile(path.join(binRoot, "lima"), "", { mode: 0o755 });
  await writeFile(path.join(documentationRoot, "LICENSE"), "Apache-2.0\n");
  await symlink(
    "../../lima/templates",
    path.join(documentationRoot, "templates"),
  );
}

async function createFakeMacosRuntimeTools(toolsRoot: string) {
  await mkdir(toolsRoot, { recursive: true });
  await writeFile(path.join(toolsRoot, "limactl"), fakeLimactlSource, {
    mode: 0o755,
  });
  await writeFile(
    path.join(toolsRoot, "curl"),
    "#!/bin/sh\nprintf 'HTTP/2 200\\r\\ncontent-length: 100\\r\\n\\r\\n'\n",
    { mode: 0o755 },
  );
  await writeFile(
    path.join(toolsRoot, "shasum"),
    "#!/bin/sh\nprintf '%s  -\\n' \"$BLAME_TEST_CACHE_KEY\"\n",
    { mode: 0o755 },
  );
}

async function runFakeMacosRuntimeSetup(
  testRoot: string,
  toolsRoot: string,
  stateRoot: string,
  cacheKey: string,
  options: { includePayload?: boolean } = {},
) {
  await createFakeMacosRuntimeTools(toolsRoot);
  const runtimeRoot = path.join(testRoot, "runtime");
  for (const file of [
    "manifest.json",
    "lima/blame-runtime.yaml",
    "scripts/blame-lima-runtime.sh",
    "scripts/provision-blame-runtime.sh",
  ]) {
    const destination = path.join(runtimeRoot, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.resolve("resources/runtime/macos", file), destination);
  }
  if (options.includePayload !== false) {
    const payloads = path.join(runtimeRoot, "payloads");
    await mkdir(payloads, { recursive: true });
    // An empty tar.gz suffices: guest provisioning is mocked by fake limactl.
    await writeFile(
      path.join(payloads, "blame-semantic-harness.tgz"),
      gzipSync(Buffer.alloc(1024)),
    );
  }
  const { stdout } = await execFileAsync(
    path.join(runtimeRoot, "scripts/blame-lima-runtime.sh"),
    ["ensure"],
    {
      env: {
        ...process.env,
        BLAME_LIMA_BIN: path.join(toolsRoot, "limactl"),
        BLAME_TEST_CACHE_KEY: cacheKey,
        BLAME_TEST_LIMA_STATE: stateRoot,
        HOME: testRoot,
        PATH: `${toolsRoot}:${process.env.PATH}`,
      },
      timeout: 10_000,
    },
  );
  return stdout;
}

const fakeLimactlSource = `#!/bin/sh
set -eu
state="$BLAME_TEST_LIMA_STATE"
case "$1" in
  --version) printf 'limactl version 2.1.2\\n' ;;
  list)
    if [ -f "$state/running" ]; then
      printf '{"status":"Running"}\\n'
    elif [ -f "$state/present" ]; then
      printf '{"status":"Stopped"}\\n'
    fi
    ;;
  create)
    cache="$HOME/Library/Caches/lima/download/by-url-sha256/$BLAME_TEST_CACHE_KEY"
    mkdir -p "$state" "$cache"
    head -c 50 /dev/zero >"$cache/data.tmp.1.1"
    sleep 1
    head -c 100 /dev/zero >"$cache/data.tmp.1.1"
    sleep 2
    mv "$cache/data.tmp.1.1" "$cache/data"
    touch "$state/present"
    ;;
  start) touch "$state/running" ;;
  shell)
    cat >/dev/null
    for name in host-home agent agent-version runtime-version docker docker-compose git cline-sdk semantic-harness package-managers; do
      printf '%s\\tavailable\\n' "$name"
    done
    ;;
esac
`;

function runtimeProgressFromOutput(output: string) {
  const prefix = "BLAME_RUNTIME_PROGRESS ";
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map(
      (line) =>
        JSON.parse(line.slice(prefix.length)) as Record<string, unknown>,
    );
}

function uniquePhases(progress: Record<string, unknown>[]) {
  return [...new Set(progress.map((event) => event.phase))];
}

async function readRuntimeManifest(runtimeRoot: string, platform: string) {
  return JSON.parse(
    await readFile(path.join(runtimeRoot, platform, "manifest.json"), "utf8"),
  ) as MacosRuntimeManifest;
}

function normalizePackageVersion(value: unknown) {
  return typeof value === "string"
    ? value.trim().match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0]
    : undefined;
}
