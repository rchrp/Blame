import assert from "node:assert/strict";
import test from "node:test";

import {
  claudeCodeEventWindows,
  codexUsage,
  parseClaudeCodeUsage,
  readCodexUsage,
} from "./subscription-usage.js";

test("reads the plan windows Claude Code prints for /usage", () => {
  const windows = parseClaudeCodeUsage(
    [
      "You are currently using your subscription to power your Claude Code usage",
      "",
      "Current session: 13% used · resets Oct 22 at 7:19pm (Europe/Bucharest)",
      "Current week (all models): 15% used · resets Oct 27 at 9:59pm (Europe/Bucharest)",
      "Current week (Sonnet only): 4% used",
    ].join("\n"),
  );
  assert.deepEqual(windows, [
    {
      id: "five_hour",
      label: "5 hours",
      usedPercent: 13,
      resetsLabel: "Oct 22 at 7:19pm (Europe/Bucharest)",
    },
    {
      id: "seven_day",
      label: "Week",
      usedPercent: 15,
      resetsLabel: "Oct 27 at 9:59pm (Europe/Bucharest)",
    },
    { id: "seven_day_sonnet_only", label: "Week · Sonnet", usedPercent: 4 },
  ]);
});

test("reads the exact windows of a Claude Code rate limit event", () => {
  assert.deepEqual(
    claudeCodeEventWindows({
      unifiedWindows: {
        five_hour: { utilization: 0.12, resetsAt: 1792686000 },
        seven_day: { utilization: 0.144, resetsAt: 1793131200 },
      },
    }),
    [
      { id: "five_hour", label: "5 hours", usedPercent: 12, resetsAt: 1792686000000 },
      { id: "seven_day", label: "Week", usedPercent: 14, resetsAt: 1793131200000 },
    ],
  );
});

test("reads ChatGPT plan windows and keeps a lone weekly window", () => {
  const usage = codexUsage({
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 27, limit_window_seconds: 18000, reset_at: 1782770922 },
      secondary_window: { used_percent: 4, limit_window_seconds: 604800, reset_at: 1783357722 },
    },
  });
  assert.equal(usage?.planType, "plus");
  assert.deepEqual(
    usage?.windows.map(({ label, usedPercent, windowMinutes }) => [label, usedPercent, windowMinutes]),
    [
      ["5 hours", 27, 300],
      ["Week", 4, 10080],
    ],
  );
  const weeklyOnly = codexUsage({
    rate_limit: { primary_window: { used_percent: 61, limit_window_seconds: 604800 } },
  });
  assert.deepEqual(weeklyOnly?.windows.map((window) => window.label), ["Week"]);
  assert.equal(codexUsage({ detail: "nope" }), null);
});

test("asks ChatGPT for usage with the account of the OAuth token", async () => {
  const claims = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } }),
  ).toString("base64url");
  let headers: Record<string, string> = {};
  const usage = await readCodexUsage(
    { access: `x.${claims}.y`, refresh: "r", expires: 0 },
    (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return Response.json({
        rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 18000 } },
      });
    }) as typeof fetch,
  );
  assert.equal(headers["ChatGPT-Account-Id"], "acct_1");
  assert.equal(headers.Authorization, `Bearer x.${claims}.y`);
  assert.equal(usage?.windows[0]?.usedPercent, 50);
});
