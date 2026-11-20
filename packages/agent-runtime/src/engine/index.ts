// The engine host (docs/engine-in-the-app.md). Nothing here may import the
// Cline runtime: `no-cline.test.ts` walks this module's imports.
export { EngineHost, attachmentKind } from "./host.js";
export type { EngineHostOptions } from "./host.js";
export { ToolSet, defineTool, toolSpec } from "./tool.js";
export type { ClientTool, ToolCallContext, ToolOutput } from "./tool.js";
export * from "./protocol.js";

import { fileURLToPath } from "node:url";

/** The harness runner the engine starts (`--harness-command`), next to this module. */
export function harnessRunnerPath() {
  return fileURLToPath(
    new URL("../harness/semantic-harness-runner.js", import.meta.url),
  );
}
