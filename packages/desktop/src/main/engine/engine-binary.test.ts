import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { engineBinaryPath } from "./engine-binary.ts";

const app = "/repo/packages/desktop";

it("prefers BLAME_ENGINE_BIN, then the release build, then the debug build", () => {
  assert.equal(
    engineBinaryPath({ applicationPath: app, env: { BLAME_ENGINE_BIN: "/opt/blame-engine" }, exists: () => false }),
    "/opt/blame-engine",
  );
  const built = new Set([join("/repo/target/debug", "blame-engine")]);
  assert.equal(
    engineBinaryPath({ applicationPath: app, env: {}, exists: (path) => built.has(path) }),
    join("/repo/target/debug", "blame-engine"),
  );
  built.add(join("/repo/target/release", "blame-engine"));
  assert.equal(
    engineBinaryPath({ applicationPath: app, env: {}, exists: (path) => built.has(path) }),
    join("/repo/target/release", "blame-engine"),
  );
  assert.equal(engineBinaryPath({ applicationPath: app, env: {}, exists: () => false }), undefined);
});
