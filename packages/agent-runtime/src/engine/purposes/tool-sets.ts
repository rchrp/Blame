// The tools each purpose gets: one place, so that wiring a new client tool
// (engine/tools/) into a kind of conversation is one line here.

import type { EnginePurpose } from "../protocol.js";

/** Client tools (served by the engine host) by purpose, by name. */
export const purposeClientTools: Record<EnginePurpose, readonly string[]> = {
  "quick-chat": ["search_web", "read_web_page"],
  "development-story": ["search_web", "read_web_page"],
  plan: ["search_web", "read_web_page"],
  "new-project": ["search_web", "read_web_page"],
};

/**
 * Harness tools (run by the engine) by purpose; undefined offers all of
 * them. Plan mode reads and runs but never edits; the new-project assistant
 * only tries commands in its scratch folder.
 */
export const purposeHarnessTools: Record<
  EnginePurpose,
  readonly string[] | undefined
> = {
  "quick-chat": undefined,
  "development-story": undefined,
  plan: ["search_code", "read_code", "run_task", "finish_task"],
  "new-project": ["run_task", "finish_task"],
};

/**
 * Engine tool sets by purpose: the harness, and the plan (`update_plan`,
 * served by the engine) for the agents that do the work, a story or a chat.
 * Plan mode reads the project and proposes stories, and the new-project
 * assistant only tries commands: neither has work to break into steps, and
 * a plan pinned in front of a discussion would only add noise.
 */
export const purposeEngineTools: Record<EnginePurpose, readonly string[]> = {
  "quick-chat": ["harness", "plan"],
  "development-story": ["harness", "plan"],
  plan: ["harness"],
  "new-project": ["harness"],
};

const planGuidance =
  "For work of three steps or more, keep a short plan with `update_plan`: one imperative line per step, one `in_progress` at a time, each marked `completed` as soon as it is done, the whole list sent every time. Revise it when the work changes; a step you will not do is `abandoned`, with a reason. Never plan a question or a small change. `finish_task` is refused while a step is open.";

/** What the system prompt says about the plan tool, for the purposes that offer it. */
export function planToolGuidance(purpose: EnginePurpose): string {
  return purposeEngineTools[purpose].includes("plan") ? planGuidance : "";
}
