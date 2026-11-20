// The engine host (docs/engine-in-the-app.md). Nothing here may import the
// Cline runtime: `no-cline.test.ts` walks this module's imports.
export { EngineHost, attachmentKind } from "./host.js";
export type { EngineHostOptions } from "./host.js";
export { ToolSet, defineTool, toolSpec } from "./tool.js";
export type {
  ClientTool,
  ToolCallContext,
  ToolContentBlock,
  ToolGuard,
  ToolOutput,
  ToolPolicy,
} from "./tool.js";
export { desktopServices, desktopServiceNames } from "./desktop-services.js";
export type { DesktopServices, DesktopServiceName } from "./desktop-services.js";
export * from "./tools/index.js";
export * from "./protocol.js";
export type { ReasoningSelection, RequiredProjectCheck } from "../types.js";
export type {
  ProjectMemoryCandidate,
  ProjectMemoryPersistence,
  ProjectMemoryRecord,
} from "../harness/project-memory.js";
/** The harness runner the engine starts (`--harness-command`). */
export {
  harnessCompilerPath,
  harnessEnvironment,
  harnessServeArgs,
  unpackedPath,
} from "../harness/runner-path.js";
