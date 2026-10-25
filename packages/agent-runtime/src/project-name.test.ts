import assert from "node:assert/strict";
import test from "node:test";
import { projectNameError } from "./project-name.js";

test("accepts existing mixed-case folder names and trims outer whitespace", () => {
  for (const name of ["BlameTest", "my-app", "app_v2.1", "  my-app  "]) {
    assert.equal(projectNameError(name), undefined);
  }
});

test("rejects invalid names before any project generation", () => {
  for (const name of [
    "",
    "   ",
    "my app",
    "../app",
    "app/child",
    "app\\child",
    ".hidden",
    "app.",
    "CON",
    "nul.txt",
    "a".repeat(215),
  ]) {
    assert.equal(typeof projectNameError(name), "string", name);
  }
});
