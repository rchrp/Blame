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
import test from "node:test";
import {
  verifyAsarWorkspaceRuntime,
  verifyPackagedWorkspaceRuntime,
  verifyStagedWorkspaceRuntime,
} from "./package-integrity.mjs";

const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve("electron-builder"));
const asar = createRequire(builder.resolve("app-builder-lib"))(
  "@electron/asar",
);

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
    dependencies: { "@blame/harness-core": "1", "@blame/model-catalog": "1" },
  });
  await file("node_modules/@blame/agent-runtime/dist/index.js");
  for (const name of ["harness-core", "model-catalog"]) {
    await file(`node_modules/@blame/${name}/package.json`, {
      name: `@blame/${name}`,
      exports: { ".": { types: "./src/index.ts", default: "./dist/index.js" } },
    });
    await file(`node_modules/@blame/${name}/src/index.ts`);
  }
  async function pack() {
    await mkdir(dirname(archive), { recursive: true });
    await asar.createPackage(source, archive);
    asar.uncache(archive);
  }
  try {
    await action({ source, dist, archive, file, pack });
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

for (const archivePath of [
  "mac-arm64/Blame.app/Contents/Resources/app.asar",
  "win-unpacked/resources/app.asar",
  "linux-unpacked/resources/app.asar",
]) {
  test(`accepts compiled transitive packages without TypeScript sources in ${archivePath}`, async () => {
    await fixture(async ({ source, dist, file, pack }) => {
      for (const name of ["harness-core", "model-catalog"]) {
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
    for (const name of ["harness-core", "model-catalog"])
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

test("requires the default libraries of a packaged TypeScript compiler", async () => {
  await fixture(async ({ dist, file, pack }) => {
    for (const name of ["harness-core", "model-catalog"])
      await file(`node_modules/@blame/${name}/dist/index.js`);
    await file("node_modules/typescript/lib/typescript.js");
    await file("node_modules/typescript/lib/lib.d.ts");
    await pack();
    await assert.rejects(
      verifyPackagedWorkspaceRuntime(dist),
      /missing TypeScript default library: .*typescript\/lib\/lib\.es5\.d\.ts/,
    );

    await file("node_modules/typescript/lib/lib.es5.d.ts");
    await file("node_modules/typescript/lib/lib.dom.d.ts");
    await pack();
    await verifyPackagedWorkspaceRuntime(dist);
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
    for (const name of ["harness-core", "model-catalog"]) {
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
      join(source, "node_modules/@blame/model-catalog"),
      join(scope, "model-catalog"),
    );
    await symlink(join(scope, "agent-runtime"), runtime, "junction");
    assert.equal(await verifyStagedWorkspaceRuntime(source), 4);
  });
});
