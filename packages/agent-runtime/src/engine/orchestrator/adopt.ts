// An epic the kept file does not know (it was lost, or set aside) whose
// conversation this computer's engine has is run here: its entry is built
// again from the API and the conversation's records. The records are the
// host's own writing: the prompt names the branch this host made, the
// config the folder it reads and its model, the `message_story` calls the
// counts. Another computer's conversation is never read (`session/list`
// says what this engine keeps; reading it would pull it in).

import type { EngineClient } from "@blame/engine-client";
import type { Epic } from "../protocol.js";
import { storyDisplayId, type HostStory } from "../stories/story.js";
import { epicBranchProblem } from "./branch.js";
import type { ConversationReader } from "./conversation.js";
import type { OrchestratorState } from "./state.js";

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
  await state.change(epic.id, (entry) => {
    entry.settings = {
      workspace: { root: config.workspace_root, location: "host" },
      projectId: epic.projectId,
      epicId: epic.id,
      model: { providerId: config.model.provider, modelId: config.model.model },
    };
    entry.messages = counted(conversation.messages.all);
    entry.changes = counted(conversation.messages.changes);
  });
  return true;
}
