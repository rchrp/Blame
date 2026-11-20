// Which effect each client tool has and which ones the user approves, in one
// table. The engine runs read-only calls in parallel and keeps a message's
// files undoable only across read-only calls; it lists command and external
// calls as not undone when a message is rewound. No tool of a conversation
// asks for approval today: stories approve their own writes (their harness
// runs in the engine), and these tools only read or act on Blame's preview.

import type { ToolEffect } from "@blame/engine-client";
import type { ClientTool, ToolPolicy } from "../tool.js";

type Rule = { effect: ToolEffect; needsApproval?: boolean };

const rules: Record<string, Rule> = {
  // Web research.
  search_web: { effect: "read_only" },
  read_web_page: { effect: "read_only" },
  // Preview: reading its state, logs and variables changes nothing.
  get_preview_devtools: { effect: "read_only" },
  get_preview_container_logs: { effect: "read_only" },
  // Lists names, or asks the person for a value in the Variables tab.
  preview_environment: { effect: "external" },
  // Start the project's app, restart or repair the preview, drive its screen.
  project_app: { effect: "command" },
  repair_preview_initialization: { effect: "command" },
  preview_terminal: { effect: "command" },
  preview_display: { effect: "command" },
  preview_device: { effect: "command" },
  open_component_preview: { effect: "command" },
  // Stories: cards the person reviews, and the project's history.
  propose_user_stories: { effect: "read_only" },
  propose_project_stack: { effect: "read_only" },
  search_user_stories: { effect: "read_only" },
  read_user_story: { effect: "read_only" },
  // Documents and skills.
  read_attachment: { effect: "read_only" },
  skills: { effect: "read_only" },
};

// MCP servers Blame itself connects a session to.
const blameServers: Record<string, Rule> = {
  // GitHub's server is connected with a read-only token.
  github: { effect: "read_only" },
  // Clicks and navigation change the page the next call sees.
  preview_devtools: { effect: "command" },
};

export const clientToolPolicy: ToolPolicy = (tool: ClientTool<never>) => {
  const rule = ruleOf(tool);
  return {
    effect: rule.effect,
    needsApproval: rule.needsApproval ?? false,
  };
};

function ruleOf(tool: ClientTool<never>): Rule {
  const source = tool.source;
  if (source?.kind === "mcp") {
    const server = blameServers[source.server];
    if (server) return server;
    // The user's own servers: what they say of their tools, or the worst.
    return { effect: source.readOnly ? "read_only" : "external" };
  }
  return (
    rules[tool.name] ?? {
      effect: tool.effect,
      needsApproval: tool.needsApproval,
    }
  );
}
