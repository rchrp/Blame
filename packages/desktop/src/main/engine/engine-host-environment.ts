import { app } from "electron";
import { join } from "node:path";
import { setupPath } from "../host-tool-path.ts";
import { mcpSettingsFile } from "../mcp-settings-file.ts";

/**
 * What the engine host, its engine and the agents' commands run with. An app
 * opened from the Finder inherits launchd's minimal PATH: agent commands
 * need the same Node, package manager and tool directories as the other
 * runtimes Blame starts.
 */
export function engineHostEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: setupPath(),
    // Where cloud commands' gh is downloaded once (see github-cli.ts).
    BLAME_GITHUB_CLI_DIR: join(app.getPath("userData"), "github-cli"),
    // The user's MCP servers, the file Settings → MCP writes.
    BLAME_MCP_SETTINGS_PATH: mcpSettingsFile(),
  };
}
