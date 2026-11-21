import type {
  EnginePlatformClient,
  StoryPreferences,
  StoryProject,
} from "@blame/agent-runtime/engine-protocol"

import { storyContextLimits } from "@/components/backlog/data/story-context-limit"

// The window's side of the story service in the engine host
// (docs/engine-in-the-app.md, "Development stories"): what the host needs to
// know of this window (its projects and the person's settings), and the
// nudge that makes it read a project's stories again.

export type StorySync = {
  projects: StoryProject[]
  preferences: Omit<StoryPreferences, "contextLimits">
}

// This window, for the host: what every window knows counts together.
const windowId = crypto.randomUUID()
let latest: StorySync | undefined

/** Tells the host the projects and settings it runs stories with. */
export function syncStoryService(
  engine: EnginePlatformClient,
  input: StorySync
) {
  latest = input
  return send(engine, input)
}

/**
 * The host reads a project's stories again (one this window created or
 * changed) and looks at its queue. The settings go first, so a context cap
 * saved with a new story reaches the host before the story does.
 */
export async function refreshStoryService(
  engine: EnginePlatformClient | undefined,
  projectId?: string
) {
  if (!engine) return
  if (latest) await send(engine, latest)
  await engine.call("storyRefresh", { projectId })
}

function send(engine: EnginePlatformClient, input: StorySync) {
  return engine.call("storySync", {
    window: windowId,
    projects: input.projects,
    preferences: { ...input.preferences, contextLimits: storyContextLimits() },
  })
}
