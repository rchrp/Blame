// The orchestrator's client tools (docs/orchestrator.md, "Tools"), bound
// to one epic's conversation. Their logic and refusals are in
// `actions.ts`; here are what the model reads: names, descriptions and
// input schemas. `create_stories`, `update_story` and `approve_story`
// always ask the engine for approval: the host answers at once unless the
// epic asks before launching (`Orchestrator.approval`), so the tool list
// never changes with that setting and the prompt cache holds.

import { defineTool, type ClientTool } from "../tool.js";
import type { OrchestratorToolInputs } from "../protocol.js";
import {
  approveStory,
  createStories,
  endTurn,
  epicBoard,
  messageStory,
  rejectStory,
  storyReport,
  updateStory,
  type EpicDesk,
} from "./actions.js";

export type { EpicDesk } from "./actions.js";

type Inputs = OrchestratorToolInputs;

const reason = {
  type: "string",
  description: "One sentence for the person's decision log: why.",
};
const storyId = {
  type: "string",
  description: "The story's id (or its number, e.g. US-004).",
};
const intent = {
  type: "string",
  enum: ["cheaper", "balanced", "smarter"],
  description:
    "What the story's model should be: cheaper for routine work, balanced by default, smarter for hard or risky work.",
};

export function orchestratorTools(desk: EpicDesk): ClientTool<never>[] {
  const json = async (value: Promise<unknown>) => ({ json: await value });
  return [
    defineTool<Inputs["epic_board"]>({
      name: "epic_board",
      description:
        "The epic's stories as they are now: status, what each waits for, its model, turns, cost and last outcome, and what is left of the budget.",
      inputSchema: { type: "object", properties: {} },
      effect: "read_only",
      run: () => json(epicBoard(desk)),
    }),
    defineTool<Inputs["create_stories"]>({
      name: "create_stories",
      description:
        "Creates stories of the epic, each on the epic's branch with a model chosen by its intent, and queues them (their agents start at once) unless `hold`. Answers each story's id, number and model.",
      inputSchema: {
        type: "object",
        properties: {
          reason,
          stories: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                key: {
                  type: "string",
                  description:
                    "Your own short name for the story, for startsAfter in this call.",
                },
                title: { type: "string" },
                brief: {
                  type: "string",
                  description:
                    "What the agent reads: the goal, what exists, what done means and how it is checked, what is out of scope, when to stop and ask.",
                },
                startsAfter: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Keys of this call or ids of the epic's stories it needs done first.",
                },
                intent,
                hold: {
                  type: "boolean",
                  description:
                    "Keep it in the backlog; update_story with queue starts it later.",
                },
              },
              required: ["key", "title", "brief", "intent"],
            },
          },
        },
        required: ["reason", "stories"],
      },
      effect: "external",
      needsApproval: true,
      run: (input) => json(createStories(desk, input)),
    }),
    defineTool<Inputs["update_story"]>({
      name: "update_story",
      description:
        "Changes the title, brief, dependencies or intent of a story that has not started; `queue` starts one that was held.",
      inputSchema: {
        type: "object",
        properties: {
          reason,
          storyId,
          title: { type: "string" },
          brief: { type: "string" },
          startsAfter: {
            type: "array",
            items: { type: "string" },
            description:
              "Ids of the epic's stories it starts after (replaces the list).",
          },
          intent,
          queue: { type: "boolean", description: "Queue a held story." },
        },
        required: ["reason", "storyId"],
      },
      effect: "external",
      needsApproval: true,
      run: (input) => json(updateStory(desk, input)),
    }),
    defineTool<Inputs["story_report"]>({
      name: "story_report",
      description:
        "One story's end report: how its last turn ended, whether the harness verified it or which checks failed, the agent's reply, the files changed against its base, turns, cost and model.",
      inputSchema: {
        type: "object",
        properties: { storyId },
        required: ["storyId"],
      },
      effect: "read_only",
      run: (input) => json(storyReport(desk, input)),
    }),
    defineTool<Inputs["message_story"]>({
      name: "message_story",
      description:
        "Sends a story's agent a message: an answer to its question, or a request for changes. To an agent at work, it joins its running turn and is read at its next step (`afterTurn` keeps it for when the turn ends). A message to a story in review is a request for changes whatever its kind: at most 3 per story, 6 messages in all. `escalate` runs a new turn on the next model up, so it always waits for the running turn.",
      inputSchema: {
        type: "object",
        properties: {
          reason,
          storyId,
          kind: { type: "string", enum: ["answer", "changes"] },
          message: {
            type: "string",
            description:
              "What the agent reads: the answer, or exactly what to change and why.",
          },
          escalate: { type: "boolean" },
          afterTurn: {
            type: "boolean",
            description:
              "Wait for the agent's running turn to end instead of joining it now.",
          },
        },
        required: ["reason", "storyId", "kind", "message"],
      },
      effect: "external",
      run: (input) => json(messageStory(desk, input)),
    }),
    defineTool<Inputs["approve_story"]>({
      name: "approve_story",
      description:
        "Approve & Merge: merges a story in review whose last turn the harness verified into the epic's branch. Stories that start after it start at once: update their briefs before, not after.",
      inputSchema: {
        type: "object",
        properties: { reason, storyId },
        required: ["reason", "storyId"],
      },
      effect: "external",
      needsApproval: true,
      run: (input) => json(approveStory(desk, input)),
    }),
    defineTool<Inputs["reject_story"]>({
      name: "reject_story",
      description: "Discards a story and its worktree.",
      inputSchema: {
        type: "object",
        properties: { reason, storyId },
        required: ["reason", "storyId"],
      },
      effect: "external",
      run: (input) => json(rejectStory(desk, input)),
    }),
    defineTool<Inputs["end_turn"]>({
      name: "end_turn",
      description:
        "Ends your turn, whoever wrote last. Write what the person should read as ordinary text before calling it: this call only says how the turn ends, it carries no message. `wait`: sleep until the host wakes you; only while stories work or will start (also after answering the person mid-epic). `reply`: hand the turn back to the person after your message, when nothing works (chatting before any story, a plan to show, an answer, a report). `ask`: like reply, plus a card the person answers with a click, only when you need a decision or an action from them. `finish`: once every story is merged or rejected, with the epic's summary.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["wait", "reply", "ask", "finish"] },
          reason,
          question: {
            type: "string",
            description:
              "ask: the card's question, short, in the person's language. Your explanation belongs in your message, not here.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: "ask: the answers the card offers as buttons.",
          },
          summary: {
            type: "string",
            description:
              "finish: what the epic's branch now holds, for the person's review, in their language.",
          },
        },
        required: ["action", "reason"],
      },
      effect: "read_only",
      run: (input) => endTurn(desk, input),
    }),
  ];
}
