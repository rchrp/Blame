// The client tools of a conversation (docs/engine-in-the-app.md, "Tools"):
// everything an agent has beyond the harness (which runs in the engine) and
// web research (shared by every session). A purpose builder asks for them
// once per conversation and puts their specs in its `client_tools`.

import type { ToolSpec } from "@blame/engine-client";
import type { LightWorkspaceExecutor } from "../../harness/light-executor.js";
import { projectStackProposalTool } from "../../new-project-planning.js";
import type { ApiConnection } from "../../types.js";
import type { DesktopServices } from "../desktop-services.js";
import type { ClientTool, ToolSet } from "../tool.js";
import { attachmentTool } from "./attachments.js";
import {
  componentPreviewTool,
  componentPreviewToolName,
} from "./component-preview.js";
import { githubClientTools } from "./github.js";
import type { McpConnections } from "./mcp.js";
import { previewClientTools, type PreviewToolServices } from "./preview.js";
import type { PreviewRuntimeContext } from "./preview-types.js";
import { conversationSkills } from "./skills.js";
import { sessionStoryHistoryTools } from "./story-history.js";
import { storyProposalTool } from "./story-proposal.js";

export { clientToolGuards } from "./guards.js";
export { clientToolPolicy } from "./policy.js";
export { McpConnections } from "./mcp.js";
export { previewRuntimeContext } from "./preview-types.js";
export type { PreviewRuntimeContext } from "./preview-types.js";

/**
 * - story: a development story (its own worktree or the project folder);
 * - plan: plan mode, which reads and proposes but never edits;
 * - new-project: the assistant that picks a new project's stack;
 * - quick-chat: a chat in the project folder.
 */
export type ConversationKind = "story" | "plan" | "new-project" | "quick-chat";

/** What the tools need from the app; a missing service leaves its tools out. */
export type ConversationToolServices = PreviewToolServices & {
  /** Git where the worktree is (story history lists a merged story's files). */
  git?: DesktopServices["git"];
  /** The user's API connection now (story history goes through it). */
  connection(): ApiConnection | undefined;
  /** The user's own MCP servers; none without it. */
  mcp?: McpConnections;
  /** Plugin folders whose `skills` folder adds skills (BLAME_AGENT_PLUGIN_PATHS). */
  pluginPaths?: readonly string[];
  /** Reads attachments where the workspace is, for a managed runtime. */
  attachmentExecutor?: LightWorkspaceExecutor;
};

export type ConversationToolSession = {
  /** The engine session id: tools address the desktop with it. */
  session: string;
  kind: ConversationKind;
  workspaceRoot: string;
  projectId?: string;
  /** The story worked on, left out of the story history search. */
  storyId?: string;
  /** The conversation's preview (`previewRuntimeContext`), when it has one. */
  preview?: PreviewRuntimeContext;
  /** Blame's own skills and the user's skill folders; on by default. */
  skills?: boolean;
};

export type ConversationClientTools = {
  tools: ClientTool<never>[];
  /** Prompt sections the tools need (the skills' scopes). */
  prompt: string;
};

// Plan mode reads code, history, the web and the computer; it never edits.
const planModeExcluded = new Set([
  componentPreviewToolName,
  "repair_preview_initialization",
]);

/** Every client tool this conversation gets, in a stable order. */
export async function conversationClientTools(
  services: ConversationToolServices,
  session: ConversationToolSession,
): Promise<ConversationClientTools> {
  if (session.kind === "new-project")
    // The project does not exist yet: no code, preview, backlog or servers.
    return {
      tools: [
        projectStackProposalTool(),
        attachmentTool(session.workspaceRoot, services.attachmentExecutor),
      ].filter(present),
      prompt: "",
    };
  const preview = session.preview ? { ...session.preview } : undefined;
  const [previewTools, github, mcp] = await Promise.all([
    previewClientTools(services, preview),
    githubClientTools(services, session.session),
    services.mcp?.clientTools() ?? [],
  ]);
  const api = services.connection();
  const tools = [
    attachmentTool(session.workspaceRoot, services.attachmentExecutor),
    ...previewTools,
    componentPreviewTool(services, preview),
    ...(api
      ? sessionStoryHistoryTools(
          {
            apiConnection: api,
            projectId: session.projectId,
            storyId: session.storyId,
            workspaceRoot: session.workspaceRoot,
          },
          services.git
            ? (cwd, args) => services.git!({ cwd, args })
            : undefined,
        )
      : []),
    session.projectId ? storyProposalTool() : undefined,
    ...github,
    ...mcp,
  ]
    .filter(present)
    .filter(
      (tool) => session.kind !== "plan" || !planModeExcluded.has(tool.name),
    );
  if (session.skills === false) return { tools, prompt: "" };
  const skills = await conversationSkills(
    {
      workspaceRoot: session.workspaceRoot,
      pluginPaths: services.pluginPaths,
      builtIn: true,
    },
    tools.map((tool) => tool.name),
  );
  return {
    tools: skills.tool ? [...tools, skills.tool] : tools,
    prompt: skills.prompt,
  };
}

/**
 * The client tools of each conversation of the host, worked out once per
 * conversation and bound to it in the host's tool set, so its config (and
 * the provider's prompt cache) stays the same from one message to the next.
 */
export class ConversationTools {
  private readonly toolSet: ToolSet;
  private readonly services: ConversationToolServices;
  private readonly sessions = new Map<
    string,
    Promise<{ specs: ToolSpec[]; prompt: string }>
  >();

  constructor(toolSet: ToolSet, services: ConversationToolServices) {
    this.toolSet = toolSet;
    this.services = services;
  }

  /** The conversation's tool specs and prompt; the first call lists them. */
  ensure(session: ConversationToolSession) {
    let known = this.sessions.get(session.session);
    if (!known) {
      known = conversationClientTools(this.services, session).then(
        ({ tools, prompt }) => {
          this.toolSet.setSessionTools(session.session, tools);
          return { specs: this.toolSet.sessionSpecs(session.session), prompt };
        },
      );
      this.sessions.set(session.session, known);
      known.catch(() => this.sessions.delete(session.session));
    }
    return known;
  }

  /** Forgets a conversation: the next `ensure` lists its tools again. */
  release(session: string) {
    this.sessions.delete(session);
    this.toolSet.releaseSession(session);
  }
}

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}
