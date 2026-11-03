import assert from "node:assert/strict";
import test from "node:test";
import { collectProjectInitializationDiagnostics } from "../project-initialization-diagnostics.ts";
import { redactDeep, secretValues } from "./secret-redaction.ts";

const secrets = secretValues([
  {
    key: "DATABASE_URL",
    value: "mysql://root:Pr0d-pass@host.docker.internal:13307/blame",
  },
  { key: "STRIPE_SECRET_KEY", value: "sk_test_51Habcdefghijkl" },
  { key: "LOG_LEVEL", value: "debug" },
]);

test("replaces each secret value by the name of its variable", () => {
  assert.deepEqual(
    redactDeep(
      {
        logs: "connecting to mysql://root:Pr0d-pass@host.docker.internal:13307/blame\nusing sk_test_51Habcdefghijkl at debug level",
        lines: ["auth failed for password Pr0d-pass"],
        exitCode: 1,
      },
      secrets,
    ),
    {
      logs: "connecting to [DATABASE_URL hidden]\nusing [STRIPE_SECRET_KEY hidden] at debug level",
      lines: ["auth failed for password [DATABASE_URL hidden]"],
      exitCode: 1,
    },
  );
});

test("hides the preview's values from the diagnostics a repair agent reads", async () => {
  const diagnostics = await collectProjectInitializationDiagnostics(
    { worktree: "/tmp/blame-redaction-story", launchError: "start failed" },
    {},
    {
      secrets,
      compose: async (args) => ({
        exitCode: 0,
        stdout:
          args[0] === "config"
            ? args[1] === "--services"
              ? "api\n"
              : "services:\n  api:\n    environment:\n      STRIPE_HOOK: sk_test_51Habcdefghijkl\n"
            : "api-1 | Error: Access denied for user 'root' (using password: Pr0d-pass)\n",
        stderr: "",
      }),
    },
  );
  const text = JSON.stringify(diagnostics);
  assert.doesNotMatch(text, /sk_test_51H|Pr0d-pass/);
  assert.match(text, /\[STRIPE_SECRET_KEY hidden\]/);
});
