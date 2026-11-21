// The windows' story calls (`EngineStoryMethods`), answered by the story
// service. A story comes back as the API's payload, as the windows read it.

import type { EngineStoryMethods } from "../story-protocol.js";
import type { StoryService } from "./service.js";

type StoryHandlers = {
  [M in keyof EngineStoryMethods]: (
    input: EngineStoryMethods[M]["input"],
  ) => Promise<EngineStoryMethods[M]["result"]>;
};

/**
 * `touched` hears of each story a person acts on from a window (a message,
 * a pause, a resume, a discard…): the orchestrator leaves such a story to
 * the person through a pause and a resume.
 */
export function storyHandlers(
  service: () => StoryService,
  touched: (storyId: string) => void = () => undefined,
): StoryHandlers {
  const payload = (story: { id: string }) => service().payload(story.id);
  const person = <Input extends { storyId: string }, Result>(
    act: (input: Input) => Promise<Result>,
  ) => {
    return (input: Input) => {
      touched(input.storyId);
      return act(input);
    };
  };
  return {
    storySync: async (input) => {
      await service().sync(input);
      return null;
    },
    storyWindowClosed: async ({ window }) => {
      service().windowClosed(window);
      return null;
    },
    storyRefresh: async ({ projectId }) => {
      await service().refresh(projectId);
      return null;
    },
    storyRetry: async ({ storyId }) => {
      service().retry(storyId);
      return null;
    },
    storyQueueState: async () => service().queueState(),
    storyEnqueue: person(async ({ storyId }) =>
      payload(await service().enqueue(storyId)),
    ),
    storySend: person(async ({ storyId, ...input }) =>
      payload(await service().send(storyId, input)),
    ),
    storyPause: person(async ({ storyId }) =>
      payload(await service().pause(storyId)),
    ),
    storyResume: person(async ({ storyId, turn }) =>
      payload(await service().resume(storyId, turn)),
    ),
    storyApprove: person(({ storyId, ...input }) =>
      service().approve(storyId, input),
    ),
    storyComplete: person(async ({ storyId, ...merge }) =>
      payload(await service().complete(storyId, merge)),
    ),
    storyToBacklog: person(async ({ storyId }) =>
      payload(await service().toBacklog(storyId)),
    ),
    storyDiscard: person(async ({ storyId, reason }) =>
      payload(await service().discard(storyId, reason)),
    ),
    storyDelete: person(async ({ storyId }) => {
      await service().remove(storyId);
      return null;
    }),
    storyError: async ({ storyId, error }) =>
      payload(await service().noteError(storyId, error)),
    storyRewind: person(({ storyId, to, restoreWorkspace }) =>
      service().rewind(storyId, to, restoreWorkspace),
    ),
  };
}
