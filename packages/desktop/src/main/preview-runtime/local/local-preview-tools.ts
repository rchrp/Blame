import { homedir } from "node:os";
import { join } from "node:path";

/** Docker on Linux uses the user's host paths; VM hosts use the baked tools. */
export function localPreviewToolsPath() {
  return process.platform === "linux"
    ? join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "blame",
        "preview-tools",
      )
    : "/opt/blame/tools";
}
