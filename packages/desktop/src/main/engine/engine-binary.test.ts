import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  engineBinary,
  harnessBinary,
  vmEngineBinaries,
} from "./engine-binary.ts";

const development = {
  applicationPath: "/repo/packages/desktop",
  resourcesPath: "/electron/Resources",
  packaged: false,
  platform: "darwin",
  arch: "arm64",
} as const;
const packaged = {
  applicationPath: "/Applications/Blame.app/Contents/Resources/app.asar",
  resourcesPath: "/Applications/Blame.app/Contents/Resources",
  packaged: true,
  platform: "darwin",
  arch: "arm64",
} as const;
// The files that exist, oldest first.
const existing =
  (...paths: string[]) =>
  (path: string) => {
    const index = paths.indexOf(path);
    return index === -1 ? undefined : index;
  };

describe("engineBinary", () => {
  it("takes BLAME_ENGINE_BIN first, and says when it points at nothing", () => {
    const env = { BLAME_ENGINE_BIN: "/opt/blame-engine" };
    const resources = join(
      packaged.resourcesPath,
      "engine/darwin-arm64/blame-engine",
    );
    assert.deepEqual(
      engineBinary({
        ...packaged,
        env,
        modified: existing("/opt/blame-engine", resources),
      }),
      { path: "/opt/blame-engine" },
    );
    assert.deepEqual(
      engineBinary({ ...packaged, env, modified: existing(resources) }),
      {
        missing:
          "BLAME_ENGINE_BIN points at /opt/blame-engine, which does not exist.",
      },
    );
  });

  it("finds a packaged app's binary in resources/engine/<platform>-<arch>", () => {
    const path = join(
      packaged.resourcesPath,
      "engine/darwin-arm64/blame-engine",
    );
    assert.deepEqual(
      engineBinary({ ...packaged, env: {}, modified: existing(path) }),
      { path },
    );
    const windows = join(
      "C:/Blame/resources",
      "engine/win32-x64/blame-engine.exe",
    );
    assert.deepEqual(
      engineBinary({
        ...packaged,
        resourcesPath: "C:/Blame/resources",
        platform: "win32",
        arch: "x64",
        env: {},
        modified: existing(windows),
      }),
      { path: windows },
    );
  });

  it("says a packaged app's engine is missing instead of using a checkout", () => {
    const lookup = engineBinary({
      ...packaged,
      env: {},
      modified: existing(join("/repo/target/release/blame-engine")),
    });
    assert.ok("missing" in lookup);
    assert.match(
      lookup.missing,
      /agent engine is missing from this installation/,
    );
    assert.match(lookup.missing, /engine\/darwin-arm64\/blame-engine/);
  });

  it("uses the checkout's newest Cargo build, release or debug, in development", () => {
    const release = join("/repo/target/release/blame-engine");
    const debug = join("/repo/target/debug/blame-engine");
    assert.deepEqual(
      engineBinary({ ...development, env: {}, modified: existing(debug) }),
      { path: debug },
    );
    assert.deepEqual(
      engineBinary({
        ...development,
        env: {},
        modified: existing(debug, release),
      }),
      { path: release },
    );
    assert.deepEqual(
      engineBinary({
        ...development,
        env: {},
        modified: existing(release, debug),
      }),
      { path: debug },
    );
    assert.deepEqual(
      engineBinary({ ...development, env: {}, modified: existing() }),
      {
        missing:
          "Blame's agent engine is not built: run `cargo build -p blame-engine`, or set BLAME_ENGINE_BIN.",
      },
    );
  });
});

describe("harnessBinary", () => {
  it("resolves like the engine, with BLAME_HARNESS_BIN", () => {
    assert.deepEqual(
      harnessBinary({
        ...development,
        env: {
          BLAME_HARNESS_BIN: "/opt/blame-harness",
          BLAME_ENGINE_BIN: "/opt/blame-engine",
        },
        modified: existing("/opt/blame-harness"),
      }),
      { path: "/opt/blame-harness" },
    );
    const path = join(
      packaged.resourcesPath,
      "engine/darwin-arm64/blame-harness",
    );
    assert.deepEqual(
      harnessBinary({ ...packaged, env: {}, modified: existing(path) }),
      { path },
    );
    assert.deepEqual(
      harnessBinary({ ...development, env: {}, modified: existing() }),
      {
        missing:
          "Blame's code harness is not built: run `cargo build -p blame-harness`, or set BLAME_HARNESS_BIN.",
      },
    );
  });
});

describe("vmEngineBinaries", () => {
  it("returns a packaged app's Linux binaries for the VM's architecture", () => {
    const directory = join(packaged.resourcesPath, "engine/linux-x64");
    const engine = join(directory, "blame-engine");
    const harness = join(directory, "blame-harness");
    assert.deepEqual(
      vmEngineBinaries({
        ...packaged,
        arch: "x64",
        modified: existing(engine, harness),
      }),
      { engine, harness },
    );
    const lookup = vmEngineBinaries({
      ...packaged,
      arch: "x64",
      modified: existing(engine),
    });
    assert.ok("missing" in lookup);
    assert.match(
      lookup.missing,
      /linux-x64 engine binaries are missing from this installation/,
    );
  });

  it("uses the build script's output in development", () => {
    const directory = join("/repo/target/engine-binaries/linux-arm64");
    const engine = join(directory, "blame-engine");
    const harness = join(directory, "blame-harness");
    assert.deepEqual(
      vmEngineBinaries({
        ...development,
        arch: "arm64",
        modified: existing(engine, harness),
      }),
      { engine, harness },
    );
    assert.deepEqual(
      vmEngineBinaries({ ...development, arch: "arm64", modified: existing() }),
      {
        missing: `No linux-arm64 engine binaries in ${directory}: build them with \`node scripts/build-engine-binaries.mjs linux-arm64\`.`,
      },
    );
  });
});
