import assert from "node:assert/strict";
import test from "node:test";

import {
  redactSecuritySecrets,
  redactSecurityValue,
} from "./security-secret-redaction.js";

const tokenBody = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";

test("GitHub OAuth, personal and installation tokens are redacted wherever they appear", () => {
  for (const prefix of ["gho_", "ghp_", "ghs_"]) {
    const output = redactSecuritySecrets(`remote: https://x-access-token:${prefix}${tokenBody}@github.com/acme/app.git`);
    assert.doesNotMatch(output, new RegExp(tokenBody));
    assert.match(output, /<REDACTED_SECRET:GITHUB_TOKEN>/);
  }
});

test("fine-grained GitHub personal access tokens are redacted", () => {
  const token = `github_pat_11ABCDEFG0${tokenBody}_${tokenBody}`;
  assert.doesNotMatch(redactSecuritySecrets(`token ${token}`), /github_pat_11/);
});

test("GH_TOKEN and GITHUB_TOKEN values are redacted in env, shell, YAML and JSON forms", () => {
  const value = "opaque-value-without-prefix-0123";
  for (const line of [
    `GH_TOKEN=${value}`,
    `export GH_TOKEN="${value}"`,
    `GITHUB_TOKEN: ${value}`,
    `{"GH_TOKEN":"${value}","PATH":"/usr/bin"}`,
  ]) {
    const output = redactSecuritySecrets(line);
    assert.doesNotMatch(output, new RegExp(value), line);
    assert.match(output, /<REDACTED_SECRET:(?:GH|GITHUB)_TOKEN>/, line);
  }
  assert.equal(
    redactSecuritySecrets(`{"GH_TOKEN":"${value}","PATH":"/usr/bin"}`),
    '{"GH_TOKEN":"<REDACTED_SECRET:GH_TOKEN>","PATH":"/usr/bin"}',
  );
});

test("references to GH_TOKEN that carry no value stay readable", () => {
  for (const line of [
    "GH_TOKEN=$(gh auth token)",
    "GH_TOKEN=$GH_TOKEN",
    "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "const token = process.env.GH_TOKEN;",
    "Set GH_TOKEN before running gh.",
  ]) {
    assert.equal(redactSecuritySecrets(line), line);
  }
});

test("structured values under a GH_TOKEN key are redacted whatever their shape", () => {
  const redacted = redactSecurityValue({
    env: { GH_TOKEN: "short-value", GITHUB_TOKEN: "other-value", HOME: "/home/blame" },
  });
  assert.deepEqual(redacted, {
    env: {
      GH_TOKEN: "<REDACTED_SECRET:GH_TOKEN>",
      GITHUB_TOKEN: "<REDACTED_SECRET:GITHUB_TOKEN>",
      HOME: "/home/blame",
    },
  });
});
