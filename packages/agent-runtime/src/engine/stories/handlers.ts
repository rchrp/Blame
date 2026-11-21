// The windows' story calls (`EngineStoryMethods`), answered by the story
// service. A story comes back as the API's payload, as the windows read it.

import type { EngineStoryMethods } from "../story-protocol.js";
import type { StoryService } from "./service.js";

type StoryHandlers = {
  [M in keyof EngineStoryMethods]: (
    input: EngineStoryMethods[M]["input"],
  ) => Promise<EngineStoryMethods[M]["result"]>;
};

export function storyHandlers(service: () => StoryService): StoryHandlers {
  const payload = (story: { id: string }) => service().payload(story.id);
  return {
    storySync: async (input) => {
      await service().sync(input);
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
    storyEnqueue: async ({ storyId }) =>
      payload(await service().enqueue(storyId)),
    storySend: async ({ storyId, ...input }) =>
      payload(await service().send(storyId, input)),
    storyPause: async ({ storyId }) => payload(await service().pause(storyId)),
    storyResume: async ({ storyId, turn }) =>
      payload(await service().resume(storyId, turn)),
    storyRewind: ({ storyId, to, restoreWorkspace }) =>
      service().rewind(storyId, to, restoreWorkspace),
  };
}
