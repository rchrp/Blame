import assert from "node:assert/strict"
import test from "node:test"

import type { AgentEvent } from "@blame/agent-runtime"

import type { UserStory } from "./backlog-data.ts"
import {
  agentErrorText,
  agentFlowUpdate,
  completedAgentRun,
  terminalAgentRunEvent,
} from "./agent-flow.ts"

test("keeps recoverable diagnostics visible without ending the run or hiding its answer", () => {
  const running = updateStory(story(), toolEvent("tool_call", "run_task", 27))
  const notice: AgentEvent = {
    type: "notice",
    payload: {
      message: "The scoped preview page is no longer available in DevTools.",
      recoverable: true,
      iteration: 26,
    },
  }
  const update = agentFlowUpdate(running, notice)
  assert.equal(terminalAgentRunEvent(notice), false)
  assert.equal(update.agentFinalResponse, undefined)
  assert.equal(update.agentSessionSummary, undefined)
  assert.equal(update.agentActivities?.[0]?.status, "running")
  assert.equal(update.agentActivities?.at(-1)?.title, "Recoverable agent error")
  const completed = agentFlowUpdate(
    { ...running, ...update },
    {
      type: "done",
      payload: { text: "Final response after recovery" },
    }
  )
  assert.equal(completed.agentFinalResponse, "Final response after recovery")
})

test("completes a running tool when a fallback result has no tool call id", () => {
  const started = updateStory(
    story(),
    toolEvent("tool_call", "run_commands", 1)
  )
  const completed = updateStory(
    started,
    toolEvent("tool_result", "run_commands", 1)
  )

  assert.equal(completed.agentActivities?.length, 1)
  assert.equal(completed.agentActivities?.[0]?.status, "completed")
})

test("shows real harness outcomes without failing recoverable receipts or ghost applications", () => {
  const started = updateStory(
    story(),
    toolEvent("tool_call", "mutate_dependencies", 1, "call-outcome")
  )
  const unavailable = updateStory(started, {
    type: "tool",
    payload: {
      output: {
        isError: false,
        output: {
          data: { applied: false },
          fatal: false,
          outcome: "unavailable",
        },
      },
      phase: "finished",
      toolCall: { id: "call-outcome", name: "mutate_dependencies" },
    },
  })
  const activity = unavailable.agentActivities?.[0]

  assert.equal(activity?.status, "completed")
  assert.match(activity?.title ?? "", /unavailable$/u)
})

test("marks only fatal failed outcomes as failed activities", () => {
  const recoverable = updateStory(story(), {
    type: "tool",
    payload: {
      output: { fatal: false, outcome: "failed" },
      phase: "finished",
      toolCall: { id: "recoverable", name: "inspect_code" },
    },
  })
  const fatal = updateStory(story(), {
    type: "tool",
    payload: {
      output: { fatal: true, outcome: "failed" },
      phase: "finished",
      toolCall: { id: "fatal", name: "inspect_code" },
    },
  })

  assert.equal(recoverable.agentActivities?.[0]?.status, "completed")
  assert.equal(fatal.agentActivities?.[0]?.status, "failed")
})

test("preserves tool input when the completion event only contains output", () => {
  const patch =
    "*** Begin Patch\n*** Update File: example.ts\n+changed\n*** End Patch"
  const started = updateStory(story(), {
    type: "tool",
    payload: {
      phase: "started",
      toolCall: {
        id: "call-1",
        name: "apply_patch",
        input: { excerpt: patch },
      },
    },
  })
  const completed = updateStory(started, {
    type: "tool",
    payload: {
      output: {
        query: "apply_patch",
        result:
          "Successfully applied patch to the following files:\nexample.ts",
        success: true,
      },
      phase: "finished",
      toolCall: { id: "call-1", name: "apply_patch" },
    },
  })

  const detail = JSON.parse(completed.agentActivities?.[0]?.detail ?? "{}")
  assert.deepEqual(detail.input, { excerpt: patch })
  assert.equal(detail.output.query, "apply_patch")
  assert.equal(completed.agentActivities?.[0]?.status, "completed")
})

test("keeps large local tool details structured", () => {
  const started = updateStory(story(), {
    type: "tool",
    payload: {
      phase: "started",
      toolCall: {
        id: "call-1",
        input: { path: "package.json" },
        name: "read_file",
      },
    },
  })
  const completed = updateStory(started, {
    type: "tool",
    payload: {
      output: { content: "x".repeat(20_000) },
      phase: "finished",
      toolCall: { id: "call-1", name: "read_file" },
    },
  })

  const serialized = completed.agentActivities?.[0]?.detail ?? ""
  const detail = JSON.parse(serialized)
  assert.ok(serialized.length <= 4_096)
  assert.equal(detail.toolName, "read_file")
  assert.deepEqual(detail.input, { path: "package.json" })
  assert.equal(detail.output.content.truncated, true)
})

test("does not duplicate a completed tool when its fallback result arrives", () => {
  const started = updateStory(
    story(),
    toolEvent("tool_call", "run_commands", 1, "call-1")
  )
  const completed = updateStory(
    started,
    toolEvent("tool_result", "run_commands", 1, "call-1")
  )
  const fallback = updateStory(
    completed,
    toolEvent("tool_result", "run_commands", 1)
  )

  assert.equal(fallback.agentActivities?.length, 1)
  assert.equal(fallback.agentActivities?.[0]?.status, "completed")
})

test("keeps overlapping tools distinct by tool call id", () => {
  const firstStarted = updateStory(
    story(),
    toolEvent("tool_call", "run_commands", 1, "call-1")
  )
  const secondStarted = updateStory(
    firstStarted,
    toolEvent("tool_call", "fetch_web_content", 1, "call-2")
  )
  const activities = secondStarted.agentActivities ?? []

  assert.equal(activities.length, 2)
  assert.deepEqual(
    activities.map((activity) => activity.id),
    ["tool-call-1", "tool-call-2"]
  )
  assert.deepEqual(
    activities.map((activity) => activity.toolCallId),
    ["call-1", "call-2"]
  )
})

test("keeps sequential tools in the same iteration distinct", () => {
  const firstStarted = updateStory(
    story(),
    toolEvent("tool_call", "run_commands", 1, "call-1")
  )
  const firstCompleted = updateStory(
    firstStarted,
    toolEvent("tool_result", "run_commands", 1, "call-1")
  )
  const secondStarted = updateStory(
    firstCompleted,
    toolEvent("tool_call", "fetch_web_content", 1, "call-2")
  )

  assert.equal(secondStarted.agentActivities?.length, 2)
  assert.deepEqual(
    secondStarted.agentActivities?.map((activity) => activity.toolCallId),
    ["call-1", "call-2"]
  )
})

test("adds specialist response messages after spawn agent results", () => {
  const started = updateStory(
    story(),
    spawnAgentToolEvent("tool_call", "call-1")
  )
  const completed = updateStory(
    started,
    spawnAgentToolEvent("tool_result", "call-1", {
      text: "## Codebase Analysis\n\nLooks usable.",
    })
  )
  const activities = completed.agentActivities ?? []
  const message = activities[1]

  assert.equal(activities.length, 2)
  assert.equal(activities[0]?.kind, "tool")
  assert.equal(message?.kind, "message")
  assert.equal(message?.title, "Codebase Analyst")
  assert.equal(message?.agentName, "Codebase Analyst")
  assert.equal(message?.agentAvatar, "/agents/codebase-analyst.png")
  assert.equal(message?.detail, "## Codebase Analysis\n\nLooks usable.")
  assert.equal(message?.messageKind, "intermediate")
})

test("keeps string spawn agent results as specialist messages", () => {
  const started = updateStory(
    story(),
    spawnAgentToolEvent("tool_call", "call-1")
  )
  const completed = updateStory(
    started,
    spawnAgentToolEvent("tool_result", "call-1", "Looks usable.")
  )

  assert.equal(completed.agentActivities?.[1]?.kind, "message")
  assert.equal(completed.agentActivities?.[1]?.detail, "Looks usable.")
})

test("keeps specialist identity when spawn agent results omit the prompt", () => {
  const started = updateStory(
    story(),
    spawnAgentToolEvent("tool_call", "call-1")
  )
  const completed = updateStory(
    started,
    spawnAgentToolEvent(
      "tool_result",
      "call-1",
      { text: "Looks usable." },
      false
    )
  )
  const message = completed.agentActivities?.[1]

  assert.equal(message?.title, "Codebase Analyst")
  assert.equal(message?.agentAvatar, "/agents/codebase-analyst.png")
})

test("recognizes specialist identity from spawn agent response headings", () => {
  const completed = updateStory(
    story(),
    spawnAgentToolEvent(
      "tool_result",
      "call-1",
      { text: "## Codebase Analysis\n\nLooks usable." },
      false
    )
  )
  const message = completed.agentActivities?.[1]

  assert.equal(message?.title, "Codebase Analyst")
  assert.equal(message?.agentAvatar, "/agents/codebase-analyst.png")
})

test("adds specialist response messages after consult_specialist results", () => {
  const started = updateStory(
    story(),
    consultSpecialistToolEvent("tool_call", "call-1", "frontend_design")
  )
  const completed = updateStory(
    started,
    consultSpecialistToolEvent("tool_result", "call-1", undefined, {
      text: "## Frontend Design Review\n\nImprove the hierarchy.",
    })
  )
  const activities = completed.agentActivities ?? []

  assert.equal(activities.length, 2)
  assert.equal(activities[0]?.toolName, "consult_specialist")
  assert.equal(activities[0]?.agentName, "Frontend Design Specialist")
  assert.equal(activities[1]?.kind, "message")
  assert.equal(activities[1]?.title, "Frontend Design Specialist")
  assert.equal(
    activities[1]?.agentAvatar,
    "/agents/frontend-design-specialist.png"
  )
  assert.equal(
    activities[1]?.detail,
    "## Frontend Design Review\n\nImprove the hierarchy."
  )
})

test("keeps a specialist's own steps apart, tied to its consult call", () => {
  const started = updateStory(
    story(),
    consultSpecialistToolEvent("tool_call", "call-1", "frontend_design")
  )
  const step = (value: Record<string, unknown>): AgentEvent => ({
    type: "tool",
    payload: {
      phase: "progress",
      toolCall: { id: "call-1", name: "consult_specialist" },
      update: { type: "blame.specialist_step", step: value },
    },
  })
  const reading = updateStory(
    started,
    step({ id: "tool-r1", kind: "tool", phase: "started", toolCallId: "r1", toolName: "read_files", input: { paths: ["a.tsx"] } })
  )
  const read = updateStory(
    reading,
    step({ id: "tool-r1", kind: "tool", phase: "finished", toolCallId: "r1", toolName: "read_files", output: "ok" })
  )
  const answered = updateStory(read, step({ id: "message-1", kind: "message", text: "Spacing is uneven." }))
  const activities = answered.agentActivities ?? []

  assert.deepEqual(
    activities.map((activity) => [activity.id, activity.status, activity.parentToolCallId]),
    [
      ["tool-call-1", "running", undefined],
      ["subagent:call-1:tool-r1", "completed", "call-1"],
      ["subagent:call-1:message-1", "completed", "call-1"],
    ]
  )
  assert.equal(activities[2]?.agentName, "Frontend Design Specialist")
})

test("appends reasoning deltas while the agent is running", () => {
  const firstDelta = updateStory(story(), reasoningEvent({ text: "Now" }))
  const secondDelta = updateStory(firstDelta, reasoningEvent({ text: " I" }))
  const thirdDelta = updateStory(
    secondDelta,
    reasoningEvent({ text: " understand." })
  )

  assert.equal(thirdDelta.agentActivities?.length, 1)
  assert.equal(thirdDelta.agentActivities?.[0]?.detail, "Now I understand.")
})

test("records agent errors as dedicated failed activities", () => {
  const streaming = updateStory(story(), textEvent({ text: "Working." }))
  const failed = updateStory(streaming, {
    payload: {
      actionUrl: "https://app.cline.bot/dashboard/subscription?personal=true",
      code: "cline_not_subscribed",
      error: { message: "Cline: Provider unavailable" },
      iteration: 2,
    },
    type: "error",
  })
  const activities = failed.agentActivities ?? []

  assert.deepEqual(
    activities.map((activity) => activity.kind),
    ["message", "error"]
  )
  assert.equal(activities[0]?.status, "completed")
  assert.equal(activities[1]?.detail, "Provider unavailable")
  assert.equal(activities[1]?.status, "failed")
  assert.equal(activities[1]?.title, "Agent error")
  assert.equal(activities[1]?.errorCode, "cline_not_subscribed")
  assert.equal(
    activities[1]?.actionUrl,
    "https://app.cline.bot/dashboard/subscription?personal=true"
  )
})

test("removes provider labels from legacy agent errors", () => {
  assert.equal(
    agentErrorText("Cline: Provider unavailable"),
    "Provider unavailable"
  )
  assert.equal(
    agentErrorText(
      "Cline send ended with status failed: Cline: Provider unavailable"
    ),
    "Provider unavailable"
  )
  assert.equal(
    agentErrorText("Cline send ended with status failed."),
    "Agent session ended with status failed."
  )
})

test("replaces reasoning with accumulated text when it is available", () => {
  const firstDelta = updateStory(story(), reasoningEvent({ text: "Now" }))
  const accumulated = updateStory(
    firstDelta,
    reasoningEvent({ accumulatedText: "Now I understand." })
  )

  assert.equal(accumulated.agentActivities?.length, 1)
  assert.equal(accumulated.agentActivities?.[0]?.detail, "Now I understand.")
})

test("keeps assistant messages between tools", () => {
  const firstMessage = updateStory(story(), textEvent({ text: "Je vais" }))
  const completedMessage = updateStory(
    firstMessage,
    textEvent({ text: " inspecter." })
  )
  const toolStarted = updateStory(
    completedMessage,
    toolEvent("tool_call", "read_files", 1, "call-1")
  )
  const secondMessage = updateStory(
    toolStarted,
    textEvent({ text: "Je vais continuer." })
  )

  assert.deepEqual(
    secondMessage.agentActivities?.map((activity) => activity.kind),
    ["message", "tool", "message"]
  )
  assert.equal(secondMessage.agentActivities?.[0]?.detail, "Je vais inspecter.")
  assert.equal(secondMessage.agentActivities?.[2]?.detail, "Je vais continuer.")
})

test("starts a new assistant message after a text content block closes", () => {
  const firstMessage = updateStory(story(), textEvent({ text: "Plan rapide." }))
  const closedMessage = updateStory(
    firstMessage,
    textEvent({ phase: "finished", text: "Plan rapide." })
  )
  const secondMessage = updateStory(
    closedMessage,
    textEvent({ text: "Je continue." })
  )

  assert.deepEqual(
    secondMessage.agentActivities?.map((activity) => activity.kind),
    ["message", "message"]
  )
  assert.equal(secondMessage.agentActivities?.[0]?.detail, "Plan rapide.")
  assert.equal(secondMessage.agentActivities?.[0]?.status, "completed")
  assert.equal(secondMessage.agentActivities?.[1]?.detail, "Je continue.")
})

test("updates a closed streamed message with the complete assistant message", () => {
  const partialText =
    "Salut, oui ça va bien — et toi ?\n\n" +
    "Je n’ai pas de demande d’implémentation concrète ici, donc je n’ai pas modifié le code. Si tu veux, je peux :\n" +
    "- clarifier l’“Untitled user story” en critères d’acceptation,\n" +
    "- analyser le projet et proposer une "
  const completeText =
    `${partialText}approche,\n` +
    "- ou l’implémenter directement si tu me donnes le comportement attendu."
  const toolStarted = updateStory(
    story(),
    toolEvent("tool_call", "skills", 1, "call-1")
  )
  const toolCompleted = updateStory(
    toolStarted,
    toolEvent("tool_result", "skills", 1, "call-1")
  )
  const streamed = updateStory(toolCompleted, textEvent({ text: partialText }))
  const closed = updateStory(streamed, textEvent({ phase: "content_end" }))
  const completed = updateStory(
    closed,
    textEvent({ accumulatedText: completeText, finishReason: "stop" })
  )

  assert.deepEqual(
    completed.agentActivities?.map((activity) => activity.kind),
    ["tool", "message"]
  )
  assert.equal(completed.agentActivities?.[1]?.detail, completeText)
})

test("keeps cline assistant messages and tools in canonical order", () => {
  const plan = updateStory(story(), textEvent({ text: "Plan rapide." }))
  const firstTool = updateStory(
    plan,
    toolEvent("tool_call", "get_code_minimal_context", 1, "call-1")
  )
  const secondTool = updateStory(
    firstTool,
    toolEvent("tool_call", "run_commands", 1, "call-2")
  )
  const firstToolDone = updateStory(
    secondTool,
    toolEvent("tool_result", "get_code_minimal_context", 1, "call-1")
  )
  const secondToolDone = updateStory(
    firstToolDone,
    toolEvent("tool_result", "run_commands", 1, "call-2")
  )
  const bridgeMessage = updateStory(
    secondToolDone,
    textEvent({ text: "Je vais lire rapidement." })
  )
  const thirdTool = updateStory(
    bridgeMessage,
    toolEvent("tool_call", "read_files", 1, "call-3")
  )
  const fourthTool = updateStory(
    thirdTool,
    toolEvent("tool_call", "search_codebase", 1, "call-4")
  )
  const thirdToolDone = updateStory(
    fourthTool,
    toolEvent("tool_result", "read_files", 1, "call-3")
  )
  const fourthToolDone = updateStory(
    thirdToolDone,
    toolEvent("tool_result", "search_codebase", 1, "call-4")
  )
  const finalMessage = updateStory(
    fourthToolDone,
    textEvent({ text: "Franchement : base solide." })
  )
  const completed = updateStory(
    finalMessage,
    doneEvent("Franchement : base solide.")
  )

  assert.deepEqual(
    completed.agentActivities?.map((activity) => activity.kind),
    ["message", "tool", "tool", "message", "tool", "tool", "message"]
  )
  assert.equal(completed.agentActivities?.[0]?.detail, "Plan rapide.")
  assert.equal(
    completed.agentActivities?.[3]?.detail,
    "Je vais lire rapidement."
  )
  assert.equal(completed.agentActivities?.[6]?.title, "Agent response")
  assert.equal(
    completed.agentActivities?.[6]?.detail,
    "Franchement : base solide."
  )
})

test("does not move a done response into a middle message", () => {
  const message = updateStory(story(), textEvent({ text: "Plan rapide." }))
  const toolStarted = updateStory(
    message,
    toolEvent("tool_call", "run_commands", 1, "call-1")
  )
  const completed = updateStory(toolStarted, doneEvent("Réponse finale."))

  assert.deepEqual(
    completed.agentActivities?.map((activity) => activity.kind),
    ["message", "tool"]
  )
  assert.equal(completed.agentActivities?.[0]?.title, "Agent message")
  assert.equal(completed.agentActivities?.[0]?.detail, "Plan rapide.")
  assert.equal(completed.agentFinalResponse, "Réponse finale.")
})

test("starts a new assistant message from global accumulated text after a tool", () => {
  const firstMessage = updateStory(
    story(),
    textEvent({ accumulatedText: "Plan rapide." })
  )
  const toolStarted = updateStory(
    firstMessage,
    toolEvent("tool_call", "get_code_minimal_context", 1, "call-1")
  )
  const secondMessage = updateStory(
    toolStarted,
    textEvent({ accumulatedText: "Plan rapide.\n\nJe vois le diff." })
  )

  assert.deepEqual(
    secondMessage.agentActivities?.map((activity) => activity.kind),
    ["message", "tool", "message"]
  )
  assert.equal(secondMessage.agentActivities?.[0]?.detail, "Plan rapide.")
  assert.equal(secondMessage.agentActivities?.[2]?.detail, "Je vois le diff.")
})

test("keeps accumulated updates scoped to the current assistant message", () => {
  const firstMessage = updateStory(
    story(),
    textEvent({ accumulatedText: "Plan rapide." })
  )
  const toolStarted = updateStory(
    firstMessage,
    toolEvent("tool_call", "get_code_minimal_context", 1, "call-1")
  )
  const secondMessage = updateStory(
    toolStarted,
    textEvent({ accumulatedText: "Plan rapide.\n\nJe vois" })
  )
  const updatedSecondMessage = updateStory(
    secondMessage,
    textEvent({ accumulatedText: "Plan rapide.\n\nJe vois le diff." })
  )

  assert.deepEqual(
    updatedSecondMessage.agentActivities?.map((activity) => activity.kind),
    ["message", "tool", "message"]
  )
  assert.equal(
    updatedSecondMessage.agentActivities?.[0]?.detail,
    "Plan rapide."
  )
  assert.equal(
    updatedSecondMessage.agentActivities?.[2]?.detail,
    "Je vois le diff."
  )
})

test("does not cut current accumulated messages that share a previous prefix", () => {
  const firstMessage = updateStory(
    story(),
    textEvent({ accumulatedText: "Je vais lire rapidement." })
  )
  const toolStarted = updateStory(
    firstMessage,
    toolEvent("tool_call", "read_files", 1, "call-1")
  )
  const secondMessage = updateStory(
    toolStarted,
    textEvent({
      accumulatedText:
        "Je vais lire rapidement les points d'entree: README, package root.",
    })
  )

  assert.deepEqual(
    secondMessage.agentActivities?.map((activity) => activity.kind),
    ["message", "tool", "message"]
  )
  assert.equal(
    secondMessage.agentActivities?.[2]?.detail,
    "Je vais lire rapidement les points d'entree: README, package root."
  )
})

test("deduplicates a repeated assistant message after tools", () => {
  const firstMessage = updateStory(
    story(),
    textEvent({ accumulatedText: "Je vais inspecter." })
  )
  const toolStarted = updateStory(
    firstMessage,
    toolEvent("tool_call", "read_files", 1, "call-1")
  )
  const repeatedMessage = updateStory(
    toolStarted,
    textEvent({ accumulatedText: "Je vais inspecter." })
  )

  assert.deepEqual(
    repeatedMessage.agentActivities?.map((activity) => activity.kind),
    ["message", "tool"]
  )
})

test("keeps repeated assistant text chunks when they are separate messages", () => {
  const firstMessage = updateStory(story(), textEvent({ text: "Ok." }))
  const toolStarted = updateStory(
    firstMessage,
    toolEvent("tool_call", "run_commands", 1, "call-1")
  )
  const secondMessage = updateStory(toolStarted, textEvent({ text: "Ok." }))

  assert.deepEqual(
    secondMessage.agentActivities?.map((activity) => activity.kind),
    ["message", "tool", "message"]
  )
  assert.equal(secondMessage.agentActivities?.[0]?.detail, "Ok.")
  assert.equal(secondMessage.agentActivities?.[2]?.detail, "Ok.")
})

test("marks a started-only tool incomplete when the next message starts", () => {
  const toolStarted = updateStory(
    story(),
    toolEvent("tool_call", "read_files", 1, "call-1")
  )
  const message = updateStory(
    toolStarted,
    textEvent({ text: "Je continue après le tool." })
  )

  assert.deepEqual(
    message.agentActivities?.map((activity) => activity.status),
    ["failed", "running"]
  )
  assert.equal(message.agentActivities?.[0]?.kind, "tool")
  assert.match(message.agentActivities?.[0]?.title ?? "", /incomplete/i)
  assert.equal(message.agentActivities?.[1]?.kind, "message")
})

test("marks a started-only tool incomplete when the run finishes", () => {
  const toolStarted = updateStory(
    story(),
    toolEvent("tool_call", "read_files", 1, "call-1")
  )
  const completed = updateStory(toolStarted, doneEvent())

  assert.equal(completed.agentActivities?.length, 1)
  assert.equal(completed.agentActivities?.[0]?.kind, "tool")
  assert.equal(completed.agentActivities?.[0]?.status, "failed")
  assert.match(completed.agentActivities?.[0]?.title ?? "", /incomplete/i)
})

test("keeps stopped assistant messages intermediate until done", () => {
  const streaming = updateStory(story(), textEvent({ text: "Salut" }))
  const stopped = updateStory(
    streaming,
    textEvent({ accumulatedText: "Salut !", finishReason: "stop" })
  )
  const activity = stopped.agentActivities?.[0]

  assert.equal(stopped.agentActivities?.length, 1)
  assert.equal(activity?.kind, "message")
  assert.equal(activity?.messageKind, "intermediate")
  assert.equal(activity?.title, "Agent message")
  assert.equal(activity?.detail, "Salut !")
  assert.equal(stopped.agentFinalResponse, undefined)
})

test("does not complete runs from assistant message stop events", () => {
  const event = doneEvent(undefined, undefined, { finishReason: "stop" })
  const streaming = updateStory(
    story(),
    textEvent({ text: "Intermediate answer" })
  )
  const stopped = updateStory(streaming, event)

  assert.equal(completedAgentRun(event), false)
  assert.equal(stopped.agentFinalResponse, undefined)
  assert.equal(stopped.agentStatus, undefined)
  assert.equal(stopped.agentActivities?.[0]?.messageKind, "intermediate")
})

test("promotes a streamed message when the done response matches it", () => {
  const streaming = updateStory(story(), textEvent({ text: "Salut !" }))
  const completed = updateStory(streaming, doneEvent("Salut !"))
  const activity = completed.agentActivities?.[0]

  assert.equal(completed.agentFinalResponse, "Salut !")
  assert.equal(completed.agentActivities?.length, 1)
  assert.equal(activity?.kind, "message")
  assert.equal(activity?.messageKind, "final")
  assert.equal(activity?.title, "Agent response")
  assert.deepEqual(
    completed.agentActivityUpdates?.map((update) => update.id),
    ["message-session-1"]
  )
})

test("promotes a partial streamed message to the full final response", () => {
  const streaming = updateStory(story(), textEvent({ text: "Salut" }))
  const completed = updateStory(
    streaming,
    doneEvent("Salut !\n\nLa reponse complete.")
  )
  const activity = completed.agentActivities?.[0]

  assert.equal(completed.agentFinalResponse, "Salut !\n\nLa reponse complete.")
  assert.equal(completed.agentActivities?.length, 1)
  assert.equal(activity?.kind, "message")
  assert.equal(activity?.messageKind, "final")
  assert.equal(activity?.title, "Agent response")
  assert.equal(activity?.detail, "Salut !\n\nLa reponse complete.")
  assert.deepEqual(
    completed.agentActivityUpdates?.map((update) => update.id),
    ["message-session-1"]
  )
})

test("repairs a malformed streamed final response from the done text", () => {
  const streamedText =
    "Oui — globalement la codebase a l’air propre et assez bien structurée.\n\n" +
    "Monorepo clair : backend,/frontend etpackages/shared."
  const finalText =
    "Oui — globalement la codebase a l’air propre et assez bien structurée.\n\n" +
    "Monorepo clair : backend, frontend et packages/shared."
  const streaming = updateStory(story(), textEvent({ text: streamedText }))
  const completed = updateStory(streaming, doneEvent(finalText))
  const activity = completed.agentActivities?.[0]

  assert.equal(completed.agentFinalResponse, finalText)
  assert.equal(completed.agentActivities?.length, 1)
  assert.equal(activity?.kind, "message")
  assert.equal(activity?.messageKind, "final")
  assert.equal(activity?.title, "Agent response")
  assert.equal(activity?.detail, finalText)
  assert.deepEqual(
    completed.agentActivityUpdates?.map((update) => update.id),
    ["message-session-1"]
  )
})

test("uses the latest streamed message as the final response when done has no text", () => {
  const firstMessage = updateStory(
    story(),
    textEvent({ text: "Je vais inspecter." })
  )
  const toolStarted = updateStory(
    firstMessage,
    toolEvent("tool_call", "read_files", 1, "call-1")
  )
  const finalMessage = updateStory(
    toolStarted,
    textEvent({ text: "Review rapide de la codebase." })
  )
  const completed = updateStory(finalMessage, doneEvent())
  const activity = completed.agentActivities?.at(-1)

  assert.equal(completed.agentFinalResponse, "Review rapide de la codebase.")
  assert.equal(activity?.kind, "message")
  assert.equal(activity?.messageKind, "final")
  assert.equal(activity?.title, "Agent response")
})

test("keeps turn usage distinct from accumulated usage", () => {
  const updated = updateStory(
    story(),
    usageEvent({
      cacheReadTokens: 512,
      inputTokens: 1200,
      outputTokens: 80,
      totalCacheReadTokens: 2048,
      totalInputTokens: 4200,
      totalOutputTokens: 210,
    })
  )

  assert.equal(updated.agentUsage?.inputTokens, 1200)
  assert.equal(updated.agentUsage?.outputTokens, 80)
  assert.equal(updated.agentUsage?.totalInputTokens, 4200)
  assert.equal(updated.agentUsage?.totalOutputTokens, 210)
  assert.equal(updated.agentUsage?.cacheReadTokens, 512)
  assert.equal(updated.agentUsage?.totalCacheReadTokens, 2048)
})

test("keeps last turn usage when done sends aggregate usage", () => {
  const running = updateStory(
    story(),
    usageEvent({
      cacheReadTokens: 512,
      inputTokens: 1200,
      outputTokens: 80,
      totalCacheReadTokens: 2048,
      totalInputTokens: 4200,
      totalOutputTokens: 210,
    })
  )
  const completed = updateStory(
    running,
    doneEvent("Done", {
      cacheReadTokens: 4096,
      inputTokens: 6200,
      outputTokens: 320,
      totalCost: 0.15,
    })
  )

  assert.equal(completed.agentUsage?.inputTokens, 1200)
  assert.equal(completed.agentUsage?.outputTokens, 80)
  assert.equal(completed.agentUsage?.cacheReadTokens, 512)
  assert.equal(completed.agentUsage?.totalInputTokens, 6200)
  assert.equal(completed.agentUsage?.totalOutputTokens, 320)
  assert.equal(completed.agentUsage?.totalCacheReadTokens, 4096)
  assert.equal(completed.agentUsage?.totalCost, 0.15)
})

test("builds session file summaries only from structured path fields", () => {
  const current = story()
  current.agentActivities = [
    {
      id: "tool-inspect",
      kind: "tool",
      title: "Inspect code",
      detail: JSON.stringify({
        input: { target: { path: "apps/web/src/page.tsx" } },
        output: {
          changed_files: ["apps/web/package.json"],
          version: "v24.14.1",
          score: "0.42",
        },
      }),
      status: "completed",
      createdAt: "2026-08-31T10:00:00.000Z",
    },
  ]

  const completed = updateStory(current, doneEvent("Done"))

  assert.match(
    completed.agentSessionSummary ?? "",
    /apps\/web\/src\/page\.tsx, apps\/web\/package\.json/u
  )
  assert.doesNotMatch(completed.agentSessionSummary ?? "", /v24\.14\.1|0\.42/u)
})

function updateStory(story: UserStory, event: AgentEvent) {
  return { ...story, ...agentFlowUpdate(story, event) }
}

function reasoningEvent(payload: Record<string, unknown>): AgentEvent {
  return {
    payload,
    type: "reasoning",
  }
}

function textEvent(payload: Record<string, unknown>): AgentEvent {
  return {
    payload,
    type: "text",
  }
}

function doneEvent(
  text?: string,
  usage?: Record<string, unknown>,
  extra?: Record<string, unknown>
): AgentEvent {
  return {
    payload: {
      ...(text === undefined ? {} : { text }),
      ...(usage ? { usage } : {}),
      ...(extra ?? {}),
    },
    type: "done",
  }
}

function usageEvent(usage: Record<string, unknown>): AgentEvent {
  return {
    payload: { usage },
    type: "usage",
  }
}

function toolEvent(
  hookEventName: "tool_call" | "tool_result",
  toolName: string,
  iteration: number,
  toolCallId?: string
): AgentEvent {
  return {
    payload: {
      hookEventName,
      iteration,
      toolCallId,
      toolName,
    },
    type: "tool",
  }
}

function spawnAgentToolEvent(
  hookEventName: "tool_call" | "tool_result",
  toolCallId: string,
  output?: Record<string, unknown> | string,
  includePrompt = true
): AgentEvent {
  return {
    payload: {
      hookEventName,
      iteration: 1,
      output,
      toolCall: {
        input: includePrompt
          ? {
              systemPrompt:
                "You are Blame's Codebase Analyst specialist, an internal advisory sub-agent.",
            }
          : undefined,
        name: "spawn_agent",
      },
      toolCallId,
      toolName: "spawn_agent",
    },
    type: "tool",
  }
}

function consultSpecialistToolEvent(
  hookEventName: "tool_call" | "tool_result",
  toolCallId: string,
  specialist?: string,
  output?: Record<string, unknown> | string
): AgentEvent {
  return {
    payload: {
      hookEventName,
      iteration: 1,
      output,
      toolCall: {
        input: specialist ? { specialist, task: "Review the UI." } : undefined,
        name: "consult_specialist",
      },
      toolCallId,
      toolName: "consult_specialist",
    },
    type: "tool",
  }
}

function story(): UserStory {
  return {
    createdAt: "2026-06-11T10:00:00.000Z",
    id: 1,
    owner: "Product",
    priority: "Medium",
    projectId: "project",
    status: "in-progress",
    summary: "",
    title: "Story",
  }
}

const firstScreenshot = "a".repeat(64)
const secondScreenshot = "b".repeat(64)

test("the final reply keeps the screenshots the agent attached", () => {
  const streamed = updateStory(
    story(),
    textEvent({ text: "The providers page now groups subscriptions first." })
  )
  const update = agentFlowUpdate(
    streamed,
    doneEvent("The providers page now groups subscriptions first.", undefined, {
      images: [
        { id: firstScreenshot, caption: "Light mode" },
        { id: "not-an-id", caption: "Dropped" },
        { id: secondScreenshot, caption: "Dark mode" },
      ],
    })
  )
  const final = update.agentActivities?.at(-1)
  assert.equal(final?.messageKind, "final")
  assert.deepEqual(final?.images, [
    { caption: "Light mode", id: firstScreenshot },
    { caption: "Dark mode", id: secondScreenshot },
  ])
  assert.deepEqual(update.agentActivity?.images, final?.images)
})

test("screenshots get a final message even when none was streamed", () => {
  const update = agentFlowUpdate(
    story(),
    doneEvent("Checked in both themes.", undefined, {
      images: [{ id: firstScreenshot, caption: "Light mode" }],
    })
  )
  const final = update.agentActivities?.at(-1)
  assert.equal(final?.kind, "message")
  assert.equal(final?.messageKind, "final")
  assert.equal(final?.detail, "Checked in both themes.")
  assert.deepEqual(final?.images, [
    { caption: "Light mode", id: firstScreenshot },
  ])
})

test("a final reply without screenshots is unchanged", () => {
  const update = agentFlowUpdate(story(), doneEvent("Done."))
  assert.equal(update.agentActivities, undefined)
  assert.equal(update.agentFinalResponse, "Done.")
})
