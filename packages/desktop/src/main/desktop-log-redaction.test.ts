import assert from "node:assert/strict";
import test from "node:test";
import { redactLogData } from "./desktop-log-redaction.ts";

const granted = "0123456789abcdef0123456789abcdef01234567";
const shaped = "ghp_LoggedToken0123456789abcdefABCDEFGH";

test("desktop logs never carry a GitHub token", () => {
  const error = new Error(`request failed with ${shaped}`);
  const circular: Record<string, unknown> = { env: { GH_TOKEN: "plain-value", PATH: "/bin" } };
  circular.self = circular;
  const [message, object, logged, buffer] = redactLogData(
    [`token ${granted} and GITHUB_TOKEN=${shaped}`, circular, error, Buffer.from("x")],
    [granted],
  ) as [string, Record<string, unknown>, Error, Buffer];

  assert.doesNotMatch(message, new RegExp(`${granted}|${shaped}`, "u"));
  assert.deepEqual(object.env, { GH_TOKEN: "<REDACTED_SECRET:GH_TOKEN>", PATH: "/bin" });
  assert.equal(object.self, "[Circular]");
  assert.ok(logged instanceof Error);
  assert.doesNotMatch(`${logged.message}\n${logged.stack}`, new RegExp(shaped, "u"));
  assert.ok(Buffer.isBuffer(buffer));
});
