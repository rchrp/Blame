import {
  lightReadToolNames,
  lightWriteToolNames,
} from "./harness/light-tools.js";
import { storyHistoryToolNames } from "./story-history-tools.js";
export { blockedCommandParts } from "./harness/command-policy.js";

export const readTools: string[] = [
  "finish_task",
  "consult_specialist",
  "fetch_web_content",
  "get_preview_devtools",
  "get_preview_container_logs",
  ...lightReadToolNames,
  ...storyHistoryToolNames,
];

export const writeTools: string[] = [...lightWriteToolNames];

// These Cline built-ins bypass source revisions, immutable proposals, and the
// execution overlay. Dedicated workflows opt in explicitly: initialization
// uses read-only fallbacks, while merge resolution edits the active Git merge.
export const legacyDirectWorkspaceTools = [
  "read_files",
  "search_codebase",
  "run_commands",
  "editor",
  "apply_patch",
];

export const initializationFallbackReadTools = new Set([
  "read_files",
  "search_codebase",
]);
