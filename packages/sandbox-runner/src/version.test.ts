import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runnerVersion } from "./version.js";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the handshake version matches the released package and image", () => {
  assert.equal(runnerVersion, JSON.parse(read("package.json")).version);
  assert.match(
    read("Dockerfile"),
    new RegExp(
      `^ARG BLAME_RUNNER_VERSION=${runnerVersion.replaceAll(".", "\\.")}$`,
      "m",
    ),
  );
});
