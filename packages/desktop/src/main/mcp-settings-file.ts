import { app } from "electron";
import { join } from "node:path";

/**
 * The user's MCP servers (Settings → MCP): `mcp-settings.json` in the app's
 * data folder, unless `BLAME_MCP_SETTINGS_PATH` names another file. The
 * engine host reads the same file (it gets the path in its environment).
 */
export function mcpSettingsFile() {
  return (
    process.env.BLAME_MCP_SETTINGS_PATH?.trim() ||
    join(app.getPath("userData"), "mcp-settings.json")
  );
}
