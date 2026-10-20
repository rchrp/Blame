import * as React from "react"
import { toast } from "sonner"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import { useLatestCallback } from "@/lib/use-latest-callback"
import {
  maxConcurrentDevelopmentStories,
  runningStories,
} from "./backlog-rotation-helpers"

// Resuming a paused story takes an agent slot like a queue start. When all
// slots are busy, the story waits and resumes as soon as one frees up.
export function useResumeSlots({
  resume,
  stories,
}: {
  resume(story: UserStory): Promise<UserStory>
  stories: readonly UserStory[]
}) {
  const waiting = React.useRef<string[]>([])
  const resuming = React.useRef(false)

  const resumeNow = useLatestCallback(async (story: UserStory) => {
    resuming.current = true
    try {
      return await resume(story)
    } finally {
      resuming.current = false
    }
  })

  const requestResume = useLatestCallback(async (story: UserStory) => {
    const freeSlots =
      maxConcurrentDevelopmentStories - runningStories([...stories])
    if (freeSlots > 0 && !waiting.current.length) return resumeNow(story)
    if (!waiting.current.includes(story.id)) waiting.current.push(story.id)
    toast.info(`${maxConcurrentDevelopmentStories} agents are already working`, {
      action: {
        label: "Cancel",
        onClick: () => {
          waiting.current = waiting.current.filter((id) => id !== story.id)
        },
      },
      description: `"${story.title}" resumes as soon as one finishes.`,
      id: `resume-waiting-${story.id}`,
      position: "bottom-right",
    })
    return story
  })

  // A slot freed up: resume the story that has waited longest. Stories that
  // are no longer paused leave the line.
  React.useEffect(() => {
    waiting.current = waiting.current.filter((id) =>
      stories.some(
        (story) =>
          story.id === id &&
          story.status === "in-progress" &&
          story.agentStatus === "Paused"
      )
    )
    if (resuming.current || !waiting.current.length) return
    if (runningStories([...stories]) >= maxConcurrentDevelopmentStories) return
    const story = stories.find((item) => item.id === waiting.current[0])
    waiting.current = waiting.current.slice(1)
    if (!story) return
    toast.dismiss(`resume-waiting-${story.id}`)
    void resumeNow(story)
  }, [resumeNow, stories])

  return requestResume
}
