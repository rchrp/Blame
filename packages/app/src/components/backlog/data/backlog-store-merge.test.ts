import assert from "node:assert/strict"
import test from "node:test"

import type {
  UserStory,
  UserStoryAgentActivity,
  UserStoryAgentRun,
} from "./backlog-data.ts"
import { agentRunOwnsStory } from "./agent-run-lifecycle.ts"
import {
  mergeLoadedStories,
  mergeStoryAgentRun,
  mergeUserStory,
  storyWithActiveAgentRun,
} from "./backlog-store-merge.ts"

test("keeps local activities when a server run is incomplete", () => {
  const localStory = story([run([activity("first"), activity("second")])])
  const serverRun = run([activity("first")])

  const merged = mergeStoryAgentRun(localStory, serverRun)

  assert.deepEqual(
    merged.agentRuns?.[0].activities?.map((item) => item.id),
    ["first", "second"]
  )
})

test("keeps local activities while refreshing stories", () => {
  const localStory = story([run([activity("first"), activity("second")])])
  const serverStory = story([run([activity("first")])])

  const merged = mergeLoadedStories([localStory], [serverStory])

  assert.deepEqual(
    merged[0].agentRuns?.[0].activities?.map((item) => item.id),
    ["first", "second"]
  )
})

test("never regresses a completed local run to running", () => {
  const localRun = {
    ...run([]),
    completedAt: "2026-06-11T10:00:03.000Z",
    finalResponse: "Final response",
    status: "completed" as const,
    updatedAt: "2026-06-11T10:00:03.000Z",
  }
  const staleServerRun = {
    ...run([]),
    status: "running" as const,
    updatedAt: "2026-06-11T10:00:04.000Z",
  }

  const merged = mergeStoryAgentRun(story([localRun]), staleServerRun)

  assert.equal(merged.agentRuns?.[0].status, "completed")
  assert.equal(merged.agentRuns?.[0].finalResponse, "Final response")
  assert.equal(merged.agentRuns?.[0].completedAt, "2026-06-11T10:00:03.000Z")
})

test("does not let an older run sequence overwrite live activity state", () => {
  const liveActivity = activity(
    "tool",
    "2026-06-11T10:00:02.000Z",
    "running",
    "live detail"
  )
  const staleActivity = activity(
    "tool",
    "2026-06-11T10:00:04.000Z",
    "completed",
    "stale detail"
  )
  const currentRun = { ...run([liveActivity]), lastSequenceNumber: 10 }
  const serverRun = { ...run([staleActivity]), lastSequenceNumber: 9 }

  const merged = mergeStoryAgentRun(story([currentRun]), serverRun)

  assert.equal(merged.agentRuns?.[0]?.lastSequenceNumber, 10)
  assert.equal(merged.agentRuns?.[0]?.activities?.[0]?.detail, "live detail")
  assert.equal(merged.agentRuns?.[0]?.activities?.[0]?.status, "running")
})

test("does not regress a running run to pending", () => {
  const currentRun = { ...run([]), status: "running" as const }
  const serverRun = {
    ...run([]),
    status: "pending" as const,
    updatedAt: "2026-06-11T10:00:04.000Z",
  }

  const merged = mergeStoryAgentRun(story([currentRun]), serverRun)

  assert.equal(merged.agentRuns?.[0]?.status, "running")
})

test("keeps a local attachment upload pending during a server refresh", () => {
  const localStory = {
    ...story([]),
    fileAttachments: [
      {
        content: "SGVsbG8=",
        id: "attachment",
        name: "attachment.txt",
        size: 5,
        type: "text/plain",
      },
    ],
    fileAttachmentUploadPending: true,
    fileAttachmentUploadStatus: "uploading" as const,
    status: "ready" as const,
  }
  const serverStory = {
    ...story([]),
    fileAttachments: [],
    fileAttachmentUploadPending: true,
    status: "ready" as const,
    updatedAt: "2026-06-11T10:00:04.000Z",
  }

  const [merged] = mergeLoadedStories([localStory], [serverStory])

  assert.equal(merged?.status, "ready")
  assert.equal(merged?.fileAttachmentUploadStatus, "uploading")
  assert.equal(merged?.fileAttachmentUploadPending, true)
  assert.equal(merged?.fileAttachments?.[0]?.content, "SGVsbG8=")
})

test("keeps persisted attachment content in memory after upload", () => {
  const localStory = {
    ...story([]),
    fileAttachments: [
      {
        content: "SGVsbG8=",
        id: "attachment",
        name: "attachment.txt",
        size: 5,
        type: "text/plain",
      },
    ],
  }
  const serverStory = {
    ...story([]),
    fileAttachments: [
      {
        downloadUrl: "https://storage.example/attachment",
        id: "attachment",
        name: "attachment.txt",
        size: 5,
        type: "text/plain",
      },
    ],
    updatedAt: "2026-06-11T10:00:04.000Z",
  }

  const [merged] = mergeLoadedStories([localStory], [serverStory])

  assert.equal(merged?.fileAttachments?.[0]?.content, "SGVsbG8=")
  assert.equal(
    merged?.fileAttachments?.[0]?.downloadUrl,
    "https://storage.example/attachment"
  )
})

test("keeps the newest activity state", () => {
  const current = story([
    run([activity("tool", "2026-06-11T10:00:02.000Z", "completed")]),
  ])
  const server = story([
    run([activity("tool", "2026-06-11T10:00:01.000Z", "running")]),
  ])

  const merged = mergeUserStory(current, server)

  assert.equal(merged.agentRuns?.[0].activities?.[0].status, "completed")
})

test("does not shorten a streamed message with a stale server response", () => {
  const currentActivity = activity(
    "message-session-1",
    "2026-06-11T10:00:02.000Z",
    "running",
    "La réponse continue de s'écrire."
  )
  const serverActivity = activity(
    "message-session-1",
    "2026-06-11T10:00:04.000Z",
    "running",
    "La réponse continue"
  )
  const current = {
    ...story([run([currentActivity])]),
    agentActivities: [currentActivity],
  }
  const server = {
    ...story([run([serverActivity])]),
    agentActivities: [serverActivity],
    updatedAt: "2026-06-11T10:00:04.000Z",
  }

  const merged = mergeUserStory(current, server)

  assert.equal(
    merged.agentActivities?.[0]?.detail,
    "La réponse continue de s'écrire."
  )
  assert.equal(
    merged.agentRuns?.[0].activities?.[0]?.detail,
    "La réponse continue de s'écrire."
  )
})

test("accepts a completed server message that corrects streamed text", () => {
  const currentActivity = activity(
    "message-session-1",
    "2026-06-11T10:00:02.000Z",
    "running",
    "Réponse provisoire trop longue"
  )
  const serverActivity = activity(
    "message-session-1",
    "2026-06-11T10:00:04.000Z",
    "completed",
    "Réponse finale"
  )

  const merged = mergeUserStory(
    story([run([currentActivity])]),
    story([run([serverActivity])])
  )

  assert.equal(merged.agentRuns?.[0].activities?.[0]?.detail, "Réponse finale")
  assert.equal(merged.agentRuns?.[0].activities?.[0]?.status, "completed")
})

test("keeps a tool call identity when a server response omits it", () => {
  const currentActivity = {
    ...activity("tool-1", "2026-06-11T10:00:02.000Z", "running"),
    toolCallId: "call-1",
  }
  const serverActivity = activity(
    "tool-1",
    "2026-06-11T10:00:04.000Z",
    "completed"
  )

  const merged = mergeUserStory(
    story([run([currentActivity])]),
    story([run([serverActivity])])
  )

  assert.equal(merged.agentRuns?.[0].activities?.[0]?.toolCallId, "call-1")
  assert.equal(merged.agentRuns?.[0].activities?.[0]?.status, "completed")
})

test("keeps structured tool detail when the server returns an artifact excerpt", () => {
  const currentActivity = {
    ...activity("tool-1", "2026-06-11T10:00:02.000Z", "running"),
    detail: JSON.stringify({ input: { path: "package.json" } }),
    toolCallId: "call-1",
    toolName: "read_file",
  }
  const serverActivity = {
    ...activity("tool-1", "2026-06-11T10:00:04.000Z", "completed"),
    detail: '{"input":{"path":"package.json"}\n...\n"output":"done"}',
    detailArtifact: "agent-activity://tool-1",
    detailTruncated: true,
  }

  const merged = mergeUserStory(
    story([run([currentActivity])]),
    story([run([serverActivity])])
  )
  const activityResult = merged.agentRuns?.[0].activities?.[0]

  assert.equal(activityResult?.detail, currentActivity.detail)
  assert.equal(activityResult?.detailArtifact, serverActivity.detailArtifact)
  assert.equal(activityResult?.toolCallId, "call-1")
  assert.equal(activityResult?.toolName, "read_file")
  assert.equal(activityResult?.status, "completed")
})

test("clears previous run activities when a new run explicitly resets them", () => {
  const previousActivity = activity(
    "message-session-1",
    "2026-06-11T10:00:02.000Z",
    "completed",
    "Ancienne réponse."
  )
  const current = {
    ...story([run([previousActivity])]),
    agentActivities: [previousActivity],
  }
  const server = {
    ...current,
    agentActivities: [],
    updatedAt: "2026-06-11T10:00:04.000Z",
  }

  const merged = mergeUserStory(current, server, {
    replaceAgentActivities: true,
  })

  assert.deepEqual(merged.agentActivities, [])
})

function story(agentRuns: UserStoryAgentRun[]): UserStory {
  return {
    agentRuns,
    createdAt: "2026-06-11T10:00:00.000Z",
    id: 1,
    owner: "Product",
    priority: "Medium",
    projectId: "project",
    status: "in-progress",
    summary: "",
    title: "Story",
    updatedAt: "2026-06-11T10:00:03.000Z",
  }
}

function run(activities: UserStoryAgentActivity[]): UserStoryAgentRun {
  return {
    activities,
    createdAt: "2026-06-11T10:00:00.000Z",
    id: 1,
    kind: "initial",
    status: "running",
    updatedAt: "2026-06-11T10:00:03.000Z",
    userStoryId: 1,
  }
}

function activity(
  id: string,
  updatedAt = "2026-06-11T10:00:03.000Z",
  status: UserStoryAgentActivity["status"] = "completed",
  detail = ""
): UserStoryAgentActivity {
  return {
    createdAt: "2026-06-11T10:00:00.000Z",
    detail,
    id,
    kind: id.startsWith("message-") ? "message" : "tool",
    status,
    title: id,
    updatedAt,
  }
}

test("a story starting a run is owned by it, worktree and all", () => {
  const previous = {
    createdAt: "2026-11-01T10:00:00.000Z",
    id: "run-1",
    status: "completed",
  } as UserStoryAgentRun
  const story = {
    activeAgentRunId: "run-1",
    agentActivities: [{ id: "old" }],
    agentFinalResponse: "Earlier answer",
    agentRuns: [previous],
    agentStatus: null,
    id: "story-1",
    status: "in-review",
    worktree: "/tmp/story-1",
  } as unknown as UserStory
  const run = {
    clineSessionId: "session-2",
    createdAt: "2026-11-02T10:00:00.000Z",
    id: "run-2",
    status: "running",
  } as UserStoryAgentRun

  const started = storyWithActiveAgentRun(story, run)

  assert.equal(agentRunOwnsStory(story, run), false)
  assert.equal(agentRunOwnsStory(started, run), true)
  assert.equal(started.worktree, "/tmp/story-1")
  assert.equal(started.status, "in-progress")
  assert.equal(started.agentStatus, "Running")
  assert.equal(started.clineSessionId, "session-2")
  assert.deepEqual(started.agentActivities, [])
  assert.equal(started.agentFinalResponse, null)
  assert.deepEqual(
    started.agentRuns?.map((item) => item.id),
    ["run-1", "run-2"]
  )
})

test("a finished run joins its story without taking it over", () => {
  const story = {
    activeAgentRunId: "run-1",
    agentRuns: [],
    id: "story-1",
    status: "in-review",
  } as unknown as UserStory
  const run = {
    createdAt: "2026-11-02T10:00:00.000Z",
    id: "run-2",
    status: "completed",
  } as UserStoryAgentRun

  const merged = storyWithActiveAgentRun(story, run)

  assert.equal(merged.activeAgentRunId, "run-1")
  assert.equal(merged.status, "in-review")
  assert.deepEqual(
    merged.agentRuns?.map((item) => item.id),
    ["run-2"]
  )
})
