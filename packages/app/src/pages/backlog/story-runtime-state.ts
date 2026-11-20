import type {
  UserStory,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"

export function inactiveStoryFields(): UserStoryUpdate {
  return {
    agentStatus: null,
    branch: null,
    previewUrl: null,
    worktree: null,
    workspaceMode: null,
  }
}

export function activeStory(story: UserStory, stories: UserStory[]) {
  return stories.find((currentStory) => currentStory.id === story.id) ?? story
}
