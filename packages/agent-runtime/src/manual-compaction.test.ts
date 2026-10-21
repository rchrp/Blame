import assert from "node:assert/strict";
import test from "node:test";
import type { SessionCompactionState } from "@cline/sdk";

import { compactSessionContext } from "./manual-compaction.js";

const message = (role: "user" | "assistant", text: string) =>
  ({ role, content: [{ type: "text", text }] }) as never;

function fakeCline(messages: unknown[], state?: SessionCompactionState) {
  const saved: SessionCompactionState[] = [];
  return {
    saved,
    cline: {
      readMessages: async () => messages,
      readSessionCompactionState: async () => state,
      updateSessionCompactionState: async (
        _sessionId: string,
        next: SessionCompactionState,
      ) => {
        saved.push(next);
        return { updated: true } as never;
      },
    } as never,
  };
}

test("runs Cline's manual compaction and stores it for the next resume", async () => {
  const transcript = [
    message("user", "Build the offline banner. ".repeat(200)),
    message("assistant", "Reading the layout. ".repeat(200)),
    message("user", "Also keep the label."),
  ];
  const { cline, saved } = fakeCline(transcript);
  let options: unknown;
  let config: Record<string, unknown> = {};
  const result = await compactSessionContext({
    cline,
    compaction: { enabled: false, strategy: "agentic" },
    maxInputTokens: 128_000,
    modelId: "gpt-6.1-sol",
    providerId: "openai-codex",
    sessionId: "session-1",
    createPrepareTurn: ((
      nextConfig: Record<string, unknown>,
      nextOptions: unknown,
    ) => {
      config = nextConfig;
      options = nextOptions;
      return async () => ({
        messages: [
          message("user", "Summary: banner in progress, keep the label."),
        ],
      });
    }) as never,
  });

  assert.deepEqual(options, { mode: "manual" });
  assert.deepEqual(config.compaction, { enabled: true, strategy: "agentic" });
  assert.deepEqual(config.providerConfig, {
    providerId: "openai-codex",
    modelId: "gpt-6.1-sol",
    maxInputTokens: 128_000,
  });
  assert.equal(result.compacted, true);
  assert.ok((result.tokensAfter ?? 0) < (result.tokensBefore ?? 0));
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.source_message_count, 3);
  assert.equal(saved[0]?.messages.length, 1);
});

test("leaves the session alone when there is nothing to compact", async () => {
  const empty = fakeCline([]);
  assert.deepEqual(
    await compactSessionContext({
      cline: empty.cline,
      compaction: {},
      modelId: "m",
      providerId: "p",
      sessionId: "s",
    }),
    { compacted: false },
  );

  const unchanged = fakeCline([message("user", "hello")]);
  const result = await compactSessionContext({
    cline: unchanged.cline,
    compaction: {},
    modelId: "m",
    providerId: "p",
    sessionId: "s",
    createPrepareTurn: (() => async () => undefined) as never,
  });
  assert.equal(result.compacted, false);
  assert.equal(unchanged.saved.length, 0);
});

test("the next resume sees the summary followed by newer messages", async () => {
  const { projectSessionCompactionState } = await import("@cline/sdk");
  const transcript = [
    message("user", "Build the offline banner."),
    message("assistant", "Done with the layout."),
  ];
  const { cline, saved } = fakeCline(transcript);
  await compactSessionContext({
    cline,
    compaction: {},
    modelId: "m",
    providerId: "p",
    sessionId: "s",
    createPrepareTurn: (() => async () => ({
      messages: [message("user", "Summary of the banner work.")],
    })) as never,
  });
  const later = message("user", "Now add a retry button.");
  const resumed = projectSessionCompactionState(saved[0]!, [
    ...transcript,
    later,
  ]);
  assert.deepEqual(
    resumed?.map(
      (entry: unknown) =>
        (entry as { content: { text: string }[] }).content[0]?.text,
    ),
    ["Summary of the banner work.", "Now add a retry button."],
  );
});
