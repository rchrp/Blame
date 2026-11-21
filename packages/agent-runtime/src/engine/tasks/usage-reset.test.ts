import assert from "node:assert/strict";
import { test } from "node:test";
import { failureText } from "./runner.js";
import { statedReset, usageResetAt } from "@blame/engine-client/usage-reset";

// 2026-11-20 23:28 in Bucharest (UTC+2): the owner's failing runs.
const now = Date.parse("2026-11-20T21:28:00Z");

test("Claude Code's stated reset is the next such time in its zone", () => {
  const said = "You've hit your session limit · resets 1:10am (Europe/Bucharest)";
  assert.equal(statedReset(said, now)?.toISOString(), "2026-11-20T23:10:00.000Z");
  assert.equal(
    statedReset("Claude AI usage limit reached. Your limit will reset at 3pm (America/New_York).", now)?.toISOString(),
    "2026-11-21T20:00:00.000Z",
  );
  assert.equal(
    statedReset("You've hit your weekly limit · resets Nov 24, 9am (Europe/Bucharest)", now)?.toISOString(),
    "2026-11-24T07:00:00.000Z",
  );
  // 2026-11-20 is a Friday.
  assert.equal(
    statedReset("You've hit your weekly limit · resets Mon 9am (Europe/Bucharest)", now)?.toISOString(),
    "2026-11-23T07:00:00.000Z",
  );
  assert.equal(statedReset("You've hit your session limit", now), undefined, "no time stated");
  assert.equal(statedReset("resets 1am (Not/AZone)", now), undefined, "a zone this computer does not know");
});

test("a provider's delay wins over the words", () => {
  const reset = usageResetAt(
    { kind: "usage_limit", message: "The usage limit has been reached", retry_after_ms: 5_400_000 },
    now,
  );
  assert.equal(reset?.toISOString(), "2026-11-20T22:58:00.000Z");
});

test("a used-up plan says it could not run and when it resets; other failures keep their words", () => {
  const used = failureText(
    {
      status: "failed",
      failure: {
        kind: "provider_error",
        error: {
          kind: "usage_limit",
          message:
            "Your Claude Code usage for `claude-opus-5` is used up until it resets: \"You've hit your session limit · resets 1:10am (Europe/Bucharest)\". Choose another model, or wait for the reset.",
        },
      },
    },
    now,
  );
  assert.match(used, /^could not run: Your Claude Code usage for `claude-opus-5` is used up/);
  assert.match(used, /It resets at 2026-11-20T23:10:00.000Z\.$/);
  const credit = failureText({
    status: "failed",
    failure: { kind: "provider_error", error: { kind: "billing", message: "Anthropic has no credit or quota left." } },
  });
  assert.equal(credit, "could not run: Anthropic has no credit or quota left.");
  const limited = failureText({
    status: "failed",
    failure: { kind: "provider_error", error: { kind: "rate_limited", message: "Slow down." } },
  });
  assert.equal(limited, "failed: Slow down.");
  const unmet = failureText({
    status: "failed",
    failure: { kind: "contract_unmet", unmet: [{ kind: "result", tool: "submit_practices" }] },
  });
  assert.equal(unmet, "did not finish: the agent never gave its result with `submit_practices`.");
});
