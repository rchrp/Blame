// The client tools of a conversation (docs/engine-in-the-app.md, "Tools"):
// everything an agent has beyond the harness (which runs in the engine) and
// web research (shared by every session). A purpose builder asks for them
// once per conversation and puts their specs in its `client_tools`.

import type { ToolSpec } from "@blame/engine-client";
import { projectStackProposalTool } from "../../new-project-planning.js";
import type { ApiConnection } from "../../types.js";
import type { DesktopServices } from "../desktop-services.js";
import type { ClientTool, ToolSet } from "../tool.js";
import { attachmentTool } from "./attachments.js";
import { blameClientTools } from "./blame.js";
import type { BlameToolServices } from "./blame-types.js";
import {
  componentPreviewTool,
  componentPreviewToolName,
} from "./component-preview.js";
import { githubClientTools } from "./github.js";
import type { McpConnections } from "./mcp.js";
import { previewClientTools, type PreviewToolServices } from "./preview.js";
import {
  storyPreviewRepair,
  type PreviewRepairServices,
  type StoryPreviewRepair,
} from "./preview-repair.js";
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
 * - new-project: the assistant that picks a new project's stack;
 * - quick-chat: a chat in the project folder;
 * - orchestrator: an epic's conversation, which reads and never edits.
 */
export type ConversationKind =
  "story" | "new-project" | "quick-chat" | "orchestrator";

/** What the tools need from the app; a missing service leaves its tools out. */
export type ConversationToolServices = PreviewToolServices &
  PreviewRepairServices &
  Pick<
    BlameToolServices,
    "blameHost" | "home" | "fetch" | "mcpSettingsPath"
  > & {
    /** Git where the worktree is (story history lists a merged story's files). */
    git?: DesktopServices["git"];
    /** The user's API connection now (story history goes through it). */
    connection(): ApiConnection | undefined;
    /** The user's own MCP servers; none without it. */
    mcp?: McpConnections;
    /** Plugin folders whose `skills` folder adds skills (BLAME_AGENT_PLUGIN_PATHS). */
    pluginPaths?: readonly string[];
    /** An epic's own tools (`engine/orchestrator/tools.ts`), bound to its conversation. */
    orchestratorTools?(session: string, epicId: string): ClientTool<never>[];
  };

export type ConversationToolSession = {
  /** The engine session id: tools address the desktop with it. */
  session: string;
  kind: ConversationKind;
  workspaceRoot: string;
  projectId?: string;
  /** The story worked on, left out of the story history search. */
  storyId?: string;
  /** An orchestrator's epic. */
  epicId?: string;
  /** The conversation's preview (`previewRuntimeContext`), when it has one. */
  preview?: PreviewRuntimeContext;
  /** A story's saved preview setup, which its repair tool starts from. */
  previewRepair?: StoryPreviewRepair;
  /** Blame's own skills and the user's skill folders; on by default. */
  skills?: boolean;
};

export type ConversationClientTools = {
  tools: ClientTool<never>[];
  /** Prompt sections the tools need (the skills' scopes). */
  prompt: string;
};

// The orchestrator reads code, history, the web and the computer; it never
// edits, has no preview, and creates stories itself: it proposes none.
const orchestratorExcluded = new Set([
  componentPreviewToolName,
  "repair_preview_initialization",
  "propose_user_stories",
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
        attachmentTool(session.workspaceRoot),
      ].filter(present),
      prompt: "",
    };
  const preview = session.preview ? { ...session.preview } : undefined;
  const repair = storyPreviewRepair(services, session.previewRepair);
  const [previewTools, github, mcp, components] = await Promise.all([
    previewClientTools(
      repair ? { ...services, repairPreviewInitialization: repair } : services,
      preview,
    ),
    githubClientTools(services, session.session),
    services.mcp?.clientTools() ?? [],
    componentPreviewTarget(services, session, preview),
  ]);
  const api = services.connection();
  const tools = [
    attachmentTool(session.workspaceRoot),
    ...previewTools,
    componentPreviewTool(services, components),
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
    // Blame's own state and settings: where a person talks to an agent that
    // works for them (the orchestrator coordinates and the new-project
    // assistant has nothing to repair yet).
    ...(session.kind === "story" || session.kind === "quick-chat"
      ? blameClientTools(services, {
          session: session.session,
          workspaceRoot: session.workspaceRoot,
          preview,
        })
      : []),
    ...(session.kind === "orchestrator" && session.epicId
      ? (services.orchestratorTools?.(session.session, session.epicId) ?? [])
      : []),
  ]
    .filter(present)
    .filter(
      (tool) =>
        session.kind !== "orchestrator" || !orchestratorExcluded.has(tool.name),
    );
  if (session.skills === false) return { tools, prompt: "" };
  const skills = await conversationSkills(
    {
      workspaceRoot: session.workspaceRoot,
      pluginPaths: services.pluginPaths,
      builtIn: true,
    },
    tools.map((tool) => tool.name),
    session.kind === "story" || session.kind === "quick-chat",
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

/**
 * Where the conversation's component previews render, when its workspace
 * holds a project they can render, whatever the workspace: a story's
 * managed preview (local or cloud), its project folder, or a quick chat's
 * folder. Asked once, with the conversation's other tools.
 */
async function componentPreviewTarget(
  services: ConversationToolServices,
  session: ConversationToolSession,
  preview: PreviewRuntimeContext | undefined,
): Promise<PreviewRuntimeContext | undefined> {
  const target =
    session.kind === "story"
      ? (preview ?? { worktree: session.workspaceRoot })
      : session.kind === "quick-chat"
        ? {
            worktree: session.workspaceRoot,
            workspaceMode: "direct" as const,
            ...(session.projectId ? { projectId: session.projectId } : {}),
          }
        : undefined;
  if (!target || !services.componentPreview) return undefined;
  const supported = await services
    .prepareComponentPreview?.({ worktree: target.worktree })
    .catch((error: unknown) => {
      services.log?.("Component preview unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    });
  return supported ? { ...target, componentPreview: true } : undefined;
}

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}
