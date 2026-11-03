import assert from "node:assert/strict";
import test from "node:test";
import {
  previewEnvironmentTool,
  type PreviewEnvironmentToolInput,
} from "./preview-environment-tool.js";

const preview = { worktree: "/worktrees/story-1", storyId: "US-1" };

test("lists key statuses and forwards a request, never a value", async () => {
  const calls: PreviewEnvironmentToolInput[] = [];
  const tool = previewEnvironmentTool(
    {
      previewEnvironment: async (input) => {
        calls.push(input);
        return input.action === "list"
          ? {
              action: "list",
              variables: [
                {
                  key: "STRIPE_SECRET_KEY",
                  status: "missing",
                  services: ["api"],
                },
              ],
            }
          : { action: "request", requested: input.key };
      },
    },
    preview,
  )!;
  assert.equal(tool.name, "preview_environment");
  const listed = await tool.execute({ action: "list" }, {} as never);
  assert.deepEqual(listed, {
    action: "list",
    variables: [
      { key: "STRIPE_SECRET_KEY", status: "missing", services: ["api"] },
    ],
  });
  await tool.execute(
    {
      action: "request",
      key: "STRIPE_SECRET_KEY",
      reason: "Checkout calls Stripe.",
      serviceId: "api",
    },
    {} as never,
  );
  assert.deepEqual(calls[1], {
    ...preview,
    action: "request",
    key: "STRIPE_SECRET_KEY",
    reason: "Checkout calls Stripe.",
    serviceId: "api",
  });
  const refused = (await tool.execute(
    { action: "request", key: "BAD KEY", reason: "" },
    {} as never,
  )) as { isError?: boolean };
  assert.equal(refused.isError, true);
  assert.equal(calls.length, 2);
  assert.equal(previewEnvironmentTool({}, preview), undefined);
});
