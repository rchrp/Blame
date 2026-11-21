// An epic the kept file does not know (it was lost, or set aside) whose
// conversation this computer's engine has is run here: its entry is built
// again from the API and the conversation's records. The records are the
// host's own writing: the prompt names the branch this host made, the
// config the folder it reads and its model, the `message_story` results
// the messages and requests for changes, the boards' and reports' results
// the story turns they showed (heard: no wake repeats them) and what each
// story had spent then (kept for a story whose session is gone, a merged
// one). Wakes are in the records already. What cannot be found again is
// in docs/orchestrator.md ("What is kept"). Another computer's
// conversation is never read (`session/list` says what this engine keeps;
// reading it would pull it in).

import type { EngineClient } from "@blame/engine-client";
import type { EngineSessionStatus, Epic } from "../protocol.js";
import { storyDisplayId, type HostStory } from "../stories/story.js";
import { epicBranchProblem } from "./branch.js";
import { turnKey, type ConversationReader } from "./conversation.js";
import type { EpicEntry, OrchestratorState } from "./state.js";

/** The branch this host wrote into the conversation's prompt (`<epic>`). */
export function keptBranch(prompt: string) {
  return /^branch: (\S+) \(stories merge here/m.exec(prompt)?.[1];
}

/** Builds the epic's entry again; false when its conversation is not this computer's. */
export async function rebuildEntry(input: {
  epic: Epic;
  apiUrl: string;
  client: EngineClient;
  conversations: ConversationReader;
  state: OrchestratorState;
  stories: readonly HostStory[];
  /** A story's session as this computer's engine has it. */
  status(storyId: string): Promise<EngineSessionStatus | undefined>;
}): Promise<boolean> {
  const { epic, client, state } = input;
  const session = epic.engineSessionId;
  if (!session) return false;
  const { sessions } = await client.listSessions();
  if (!sessions.some((item) => item.session === session)) return false;
  const conversation = await input.conversations.read(client, session);
  const config = conversation.config;
  if (!config || config.purpose !== "orchestrator") return false;
  const branch = keptBranch(config.system_prompt);
  if (
    !branch ||
    branch !== epic.branch ||
    epicBranchProblem(branch, epic.targetBranch ?? "")
  )
    return false;
  await state.register(epic.id, {
    projectId: epic.projectId,
    session,
    apiUrl: input.apiUrl,
    branch,
  });
  // The calls name a story by id or by number: kept by id.
  const named = new Map(
    input.stories.map((story) => [storyDisplayId(story), story.id]),
  );
  const counted = (counts: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(counts).map(([id, count]) => [named.get(id) ?? id, count]),
    );
  const heard: Record<string, string> = {};
  const spend: EpicEntry["spend"] = {};
  for (const story of input.stories) {
    const seen = conversation.shown[story.id];
    if (!seen) continue;
    const status = await input.status(story.id);
    if (status?.exists) {
      const ended = new Set((status.endedTurns ?? []).map(({ turn }) => turn));
      for (const turn of seen.turns)
        if (ended.has(turn)) heard[turnKey(status.session, turn)] = story.id;
    } else if (seen.costMicroUsd)
      spend[story.id] = {
        [story.engineSessionId ?? "records"]: {
          microUsd: seen.costMicroUsd,
          unpriced: 0,
        },
      };
  }
  await state.change(epic.id, (entry) => {
    entry.settings = {
      workspace: { root: config.workspace_root, location: "host" },
      projectId: epic.projectId,
      epicId: epic.id,
      model: { providerId: config.model.provider, modelId: config.model.model },
    };
    entry.messages = counted(conversation.messages.all);
    entry.changes = counted(conversation.messages.changes);
    entry.heard = heard;
    entry.spend = spend;
    // Whether the person stopped its last turn is not in the records: a
    // cut turn is left to them rather than resumed against their stop.
    if (conversation.last?.outcome.status === "interrupted")
      entry.stopped = true;
  });
  return true;
}
