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
