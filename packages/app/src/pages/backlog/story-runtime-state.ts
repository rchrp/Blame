import type { UserStory } from "@/components/backlog/data/backlog-data"

export function activeStory(story: UserStory, stories: UserStory[]) {
  return stories.find((currentStory) => currentStory.id === story.id) ?? story
}
