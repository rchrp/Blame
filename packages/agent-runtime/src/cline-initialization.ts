import type { CoreSessionConfig } from "@cline/sdk";

export type AgentTool = NonNullable<CoreSessionConfig["extraTools"]>[number];

export type RuntimeSessionSummary = {
  sessionId?: string;
};

export type RuntimeClineResult = {
  result?: Record<string, unknown> & { text?: string };
  sessionId: string;
};

export function combinedTaskBriefing(
  initialTaskBriefing?: string,
  projectMemoryBriefing?: string,
) {
  const briefing = [initialTaskBriefing, projectMemoryBriefing]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return briefing || undefined;
}
