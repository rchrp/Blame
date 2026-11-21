// A turn the person (or the orchestrator) starts on a story that already
// has its agent: a message, a request for changes, a resume, and a pause.

import { helperAgentsAvailable } from "../protocol.js";
import type { StoryMessageInput, StoryTurnChoice } from "../story-protocol.js";
import {
  storyPersonalization,
  storySessionSettings,
  storyTurnModel,
} from "./settings.js";
import type { StoryContext } from "./start.js";
import {
  storyLocation,
  storyMessage,
  withAgentModel,
  type HostStory,
} from "./story.js";

/**
 * Sends a message to a story's agent. A paused or reviewed story works
 * again; while its agent works, the message waits for the turn to end (the
 * engine queues it) or, with `steer`, joins the running turn.
 */
export async function sendStoryMessage(
  context: StoryContext,
  story: HostStory,
  projectPath: string,
  input: {
    message: StoryMessageInput;
    steer?: boolean;
    turn?: StoryTurnChoice;
  },
): Promise<HostStory> {
  const session = story.engineSessionId;
  if (!story.worktree || !session)
    throw new Error("This user story has no agent to talk to yet.");
  const turn = storyTurnModel(story, context.preferences, input.turn, false);
  if (!turn)
    throw new Error("Select a model before writing to this user story.");
  const snapshot = await context.api.initialization(story.projectId);
  const settings = storySessionSettings({
    story,
    projectPath,
    snapshot,
    model: turn.model,
    maxContextTokens: turn.maxContextTokens,
    personalization: storyPersonalization(
      story,
      context.preferences,
      input.turn,
    ),
  });
  const message = await storyMessage(
    input.message.text,
    input.message.codeSelectionAttachments,
    input.message.fileAttachments,
    (file) => context.api.attachment(file.id, file.name),
  );
  // Ultra mode is whatever the composer showed when the message went.
  const ultra =
    input.turn?.ultra === true && helperAgentsAvailable(turn.model.providerId);
  const running = story.agentStatus === "Running";
  // Said before the turn starts, so that the end of the turn settles it.
  const working = running
    ? story
    : await context.patch(story, {
        agentLastError: null,
        agentModels: withAgentModel(story.agentModels, {
          modelId: turn.model.modelId,
          providerId: turn.model.providerId,
          reasoningEffort: turn.model.reasoning ?? null,
        }),
        agentStatus: "Running",
        status: "in-progress",
      });
  try {
    await context.desktop.prepareStoryTurn?.({
      session,
      projectId: story.projectId,
      root: story.worktree,
      workspaceMode: story.workspaceMode ?? "direct",
      created: false,
      apiConnection: context.connection,
    });
    await context.call("send", {
      session,
      message: { ...message, ...(ultra ? { ultra } : {}) },
      delivery: running && input.steer ? "steer" : "turn",
      settings,
    });
  } catch (error) {
    // Nothing reached the agent: the story stays as it was.
    if (!running)
      await context
        .patch(working, {
          agentStatus: story.agentStatus ?? null,
          agentLastError: story.agentLastError ?? null,
          status: story.status,
        })
        .catch(() => undefined);
    throw error;
  }
  return working;
}

/**
 * Stops the running turn: the engine ends it as interrupted, and its end
 * pauses the story where it was. A story with no turn running pauses now.
 */
export async function pauseStory(
  context: StoryContext,
  story: HostStory,
): Promise<HostStory> {
  if (story.engineSessionId && story.agentStatus === "Running") {
    await context.call("interrupt", {
      session: story.engineSessionId,
      location: storyLocation(story.workspaceMode),
    });
    return story;
  }
  return context.patch(story, { agentStatus: "Paused", status: "in-progress" });
}
