import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import test from "node:test";
import {
  verifyAsarWorkspaceRuntime,
  verifyAsarGeneratedJavaScript,
  verifyPackagedEngineBinaries,
  verifyPackagedWorkspaceRuntime,
  verifyStagedWorkspaceRuntime,
} from "./package-integrity.mjs";
import { engineExecutables } from "../../../scripts/build-engine-binaries.mjs";

const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve("electron-builder"));
const asar = createRequire(builder.resolve("app-builder-lib"))(
  "@electron/asar",
);

// The first bytes of an executable, as verifyPackagedEngineBinaries reads them.
const executables = {
  "darwin-arm64": () => header(32, (buffer) => buffer.writeUInt32LE(0xfeedfacf, 0) + buffer.writeUInt32LE(0x0100000c, 4)),
  "darwin-x64": () => header(32, (buffer) => buffer.writeUInt32LE(0xfeedfacf, 0) + buffer.writeUInt32LE(0x01000007, 4)),
  "linux-arm64": (programType = 1) => elf(183, programType),
  "linux-x64": (programType = 1) => elf(62, programType),
  "win32-x64": () => header(0x46, (buffer) => {
    buffer.write("MZ", 0, "latin1");
    buffer.writeUInt32LE(0x40, 0x3c);
    buffer.write("PE\0\0", 0x40, "latin1");
    buffer.writeUInt16LE(0x8664, 0x44);
  }),
};

function header(length, write) {
  const buffer = Buffer.alloc(length);
  write(buffer);
  return buffer;
}

// One program header; type 3 (PT_INTERP) is a dynamically linked binary.
function elf(machine, programType) {
  return header(120, (buffer) => {
    buffer.writeUInt32BE(0x7f454c46, 0);
    buffer.writeUInt16LE(machine, 18);
    buffer.writeBigUInt64LE(64n, 32);
    buffer.writeUInt16LE(56, 54);
    buffer.writeUInt16LE(1, 56);
    buffer.writeUInt32LE(programType, 64);
  });
}

async function writeEngineBinaries(resources, targets) {
  for (const [target, bytes] of Object.entries(targets)) {
    for (const executable of engineExecutables(target)) {
      const path = join(resources, "engine", target, executable);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { mode: 0o755 });
    }
  }
}

const packagedTargets = { darwin: ["darwin-arm64", "linux-arm64"], win32: ["win32-x64", "linux-x64"], linux: ["linux-x64"] };

async function fixture(
  action,
  archivePath = "mac-arm64/Blame.app/Contents/Resources/app.asar",
) {
  const root = await mkdtemp(join(tmpdir(), "blame-package-integrity-"));
  const source = join(root, "stage");
  const dist = join(root, "dist");
  const archive = join(dist, archivePath);
  async function file(path, value = "export {};") {
    const target = join(source, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  await file("package.json", {
    name: "@blame/desktop",
    main: "out/main/index.js",
    dependencies: { "@blame/agent-runtime": "1" },
  });
  await file("out/main/index.js");
  await file("node_modules/@blame/agent-runtime/package.json", {
    name: "@blame/agent-runtime",
    exports: { ".": { types: "./src/index.ts", default: "./dist/index.js" } },
    dependencies: { "@blame/harness-core": "1", "@blame/preview-contract": "1" },
  });
  await file("node_modules/@blame/agent-runtime/dist/index.js");
  for (const name of ["harness-core", "preview-contract"]) {
    await file(`node_modules/@blame/${name}/package.json`, {
      name: `@blame/${name}`,
      exports: { ".": { types: "./src/index.ts", default: "./dist/index.js" } },
    });
    await file(`node_modules/@blame/${name}/src/index.ts`);
  }
  // agent-browser's binary, for a platform no test host runs.
  const agentBrowser = "node_modules/@agent-browser/cli-fixture";
  await file(`${agentBrowser}/package.json`, {
    name: "@agent-browser/cli-fixture",
    version: "1.0.0",
    os: ["fixture"],
    cpu: ["fixture"],
  });
  async function pack() {
    await mkdir(dirname(archive), { recursive: true });
    const output = await asar.createPackage(source, archive);
    // ASAR returns its write stream before the final buffered bytes are flushed.
    await finished(output);
    asar.uncache(archive);
    const binary = join(`${archive}.unpacked`, agentBrowser, "bin/agent-browser");
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, "");
    const platform = archivePath.includes(".app/") ? "darwin" : archivePath.startsWith("win-") ? "win32" : "linux";
    await writeEngineBinaries(
      dirname(archive),
      Object.fromEntries(packagedTargets[platform].map((target) => [target, executables[target]()])),
    );
  }
  try {
    await action({ source, dist, archive, file, pack, agentBrowser });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("rejects source-only transitive workspace packages in staging and the final ASAR", async () => {
  await fixture(async ({ source, archive, pack }) => {
    await assert.rejects(
      verifyStagedWorkspaceRuntime(source),
      /missing runtime entrypoint.*dist\/index.js/,
    );
    await pack();
    await assert.rejects(
      verifyAsarWorkspaceRuntime(archive),
      /missing runtime entrypoint.*dist\/index.js/,
    );
  });
});

test("rejects a duplicate require declaration inside the final ASAR", async () => {
  await fixture(async ({ archive, file, pack }) => {
    await file("out/main/chunks/devtools.js", "const require = () => {}; var require = () => {};");
    await pack();
    assert.throws(() => verifyAsarGeneratedJavaScript(archive),
      /devtools\.js:[\s\S]*Identifier 'require' has already been declared/);
  });
});

for (const archivePath of [
  "mac-arm64/Blame.app/Contents/Resources/app.asar",
  "win-unpacked/resources/app.asar",
  "linux-unpacked/resources/app.asar",
]) {
  test(`accepts compiled transitive packages without TypeScript sources in ${archivePath}`, async () => {
    await fixture(async ({ source, dist, file, pack }) => {
      for (const name of ["harness-core", "preview-contract"]) {
        await file(`node_modules/@blame/${name}/dist/index.js`);
        await rm(join(source, `node_modules/@blame/${name}/src`), {
          recursive: true,
        });
      }
      assert.equal(await verifyStagedWorkspaceRuntime(source), 4);
      await pack();
      await verifyPackagedWorkspaceRuntime(dist);
    }, archivePath);
  });
}

test("detects a dependency lost between deployment and packaging", async () => {
  await fixture(async ({ source, archive, file, pack }) => {
    for (const name of ["harness-core", "preview-contract"])
      await file(`node_modules/@blame/${name}/dist/index.js`);
    await verifyStagedWorkspaceRuntime(source);
    await rm(join(source, "node_modules/@blame/harness-core"), {
      recursive: true,
    });
    await pack();
    await assert.rejects(
      verifyAsarWorkspaceRuntime(archive),
      /missing workspace dependency: @blame\/harness-core/,
    );
  });
});

for (const compilerPackage of ["typescript", "@typescript/typescript6", "@typescript/old"]) {
test(`requires the default libraries of packaged ${compilerPackage}`, async () => {
  await fixture(async ({ dist, file, pack }) => {
    for (const name of ["harness-core", "preview-contract"])
      await file(`node_modules/@blame/${name}/dist/index.js`);
    await file(`node_modules/${compilerPackage}/lib/typescript.js`);
    await file(`node_modules/${compilerPackage}/lib/lib.d.ts`);
    await pack();
    await assert.rejects(
      verifyPackagedWorkspaceRuntime(dist),
      /missing TypeScript default library: .*\/lib\/lib\.es5\.d\.ts/,
    );

    await file(`node_modules/${compilerPackage}/lib/lib.es5.d.ts`);
    await file(`node_modules/${compilerPackage}/lib/lib.dom.d.ts`);
    await pack();
    await verifyPackagedWorkspaceRuntime(dist);
  });
});
}

test("resolves the TypeScript compatibility wrapper and checks its implementation libraries", async () => {
  await fixture(async ({ dist, file, pack }) => {
    for (const name of ["harness-core", "preview-contract"])
      await file(`node_modules/@blame/${name}/dist/index.js`);
    await file("node_modules/typescript/lib/typescript.js", 'module.exports = require("@typescript/old");\n');
    await pack();
    await assert.rejects(verifyPackagedWorkspaceRuntime(dist), /missing the TypeScript compatibility implementation/);
    await file("node_modules/@typescript/old/lib/typescript.js");
    await pack();
    await assert.rejects(verifyPackagedWorkspaceRuntime(dist), /missing TypeScript default library/);
    for (const library of ["lib.d.ts", "lib.es5.d.ts", "lib.dom.d.ts"])
      await file(`node_modules/@typescript/old/lib/${library}`);
    await pack();
    await verifyPackagedWorkspaceRuntime(dist);
  });
});

test("requires agent-browser's binary outside the archive", async () => {
  await fixture(async ({ archive, dist, file, pack, agentBrowser }) => {
    for (const name of ["harness-core", "preview-contract"]) {
      await file(`node_modules/@blame/${name}/dist/index.js`);
    }
    await pack();
    await rm(join(`${archive}.unpacked`, agentBrowser, "bin"), {
      recursive: true,
    });
    await assert.rejects(verifyPackagedWorkspaceRuntime(dist), /agent-browser/);
  });
});

test("refuses success when no packaged application was produced", async () => {
  await fixture(async ({ dist }) => {
    await mkdir(dist);
    await assert.rejects(
      verifyPackagedWorkspaceRuntime(dist),
      /No packaged app.asar/,
    );
  });
});

test("resolves pnpm transitive dependencies from the package's real location", async () => {
  await fixture(async ({ source, file }) => {
    for (const name of ["harness-core", "preview-contract"]) {
      await file(`node_modules/@blame/${name}/dist/index.js`);
    }
    const scope = join(
      source,
      "node_modules/.pnpm/runtime/node_modules/@blame",
    );
    await mkdir(scope, { recursive: true });
    const runtime = join(source, "node_modules/@blame/agent-runtime");
    await rename(runtime, join(scope, "agent-runtime"));
    await rename(
      join(source, "node_modules/@blame/preview-contract"),
      join(scope, "preview-contract"),
    );
    await symlink(join(scope, "agent-runtime"), runtime, "junction");
    assert.equal(await verifyStagedWorkspaceRuntime(source), 4);
  });
});

test("requires the engine binaries for the app and its VM, of the right platform and architecture", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-package-engine-"));
  try {
    const resources = join(root, "Resources");
    await assert.rejects(verifyPackagedEngineBinaries(resources, "darwin"), /found: none/);
    await writeEngineBinaries(resources, { "darwin-arm64": executables["darwin-arm64"]() });
    await assert.rejects(verifyPackagedEngineBinaries(resources, "darwin"), /found: darwin-arm64$/);
    await writeEngineBinaries(resources, { "linux-arm64": executables["linux-x64"]() });
    await assert.rejects(verifyPackagedEngineBinaries(resources, "darwin"), /ELF for arm64 at .*linux-arm64[\\/]blame-engine, found ELF/);
    await writeEngineBinaries(resources, { "linux-arm64": executables["linux-arm64"](3) });
    await assert.rejects(verifyPackagedEngineBinaries(resources, "darwin"), /dynamically linked/);
    await writeEngineBinaries(resources, { "linux-arm64": executables["linux-arm64"]() });
    assert.deepEqual(await verifyPackagedEngineBinaries(resources, "darwin"), ["darwin-arm64", "linux-arm64"]);
    await writeEngineBinaries(resources, { "linux-x64": executables["linux-x64"]() });
    await assert.rejects(verifyPackagedEngineBinaries(resources, "darwin"), /found: darwin-arm64, linux-arm64, linux-x64/);
    await rm(join(resources, "engine/linux-x64"), { recursive: true });
    await rm(join(resources, "engine/darwin-arm64/blame-harness"));
    await assert.rejects(verifyPackagedEngineBinaries(resources, "darwin"), /missing .*darwin-arm64[\\/]blame-harness/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts a Windows package's executables and a Linux package's single directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-package-engine-"));
  try {
    await writeEngineBinaries(join(root, "win"), { "win32-x64": executables["win32-x64"](), "linux-x64": executables["linux-x64"]() });
    assert.deepEqual(await verifyPackagedEngineBinaries(join(root, "win"), "win32"), ["linux-x64", "win32-x64"]);
    await writeEngineBinaries(join(root, "linux"), { "linux-x64": executables["linux-x64"]() });
    assert.deepEqual(await verifyPackagedEngineBinaries(join(root, "linux"), "linux"), ["linux-x64"]);
    await writeEngineBinaries(join(root, "linux"), { "linux-x64": executables["darwin-x64"]() });
    await assert.rejects(verifyPackagedEngineBinaries(join(root, "linux"), "linux"), /ELF for x64 at .*, found Mach-O/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
