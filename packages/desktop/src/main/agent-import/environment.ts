import path from "node:path";

/**
 * Where the other tools keep their files, per system. Every path comes from
 * here so tests can lay out a fake home for any platform, and so an isolated
 * app profile can read one: `BLAME_AGENT_IMPORT_HOME` replaces the home folder
 * and hides the variables (`CODEX_HOME`, `APPDATA`…) of the real session.
 * `HOME` itself is never changed.
 */
export type ScanEnvironment = {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
};

export const importHomeVariable = "BLAME_AGENT_IMPORT_HOME";

export function scanEnvironment(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ScanEnvironment {
  const override = env[importHomeVariable]?.trim();
  return override
    ? { home: override, platform, env: {} }
    : { home, platform, env: { ...env } };
}

export function pathsFor(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Where desktop apps keep their data: `~/Library/Application Support`, `%APPDATA%`, `~/.config`. */
export function appDataFolder(scan: ScanEnvironment) {
  const p = pathsFor(scan.platform);
  if (scan.platform === "darwin")
    return p.join(scan.home, "Library", "Application Support");
  if (scan.platform === "win32")
    return scan.env.APPDATA || p.join(scan.home, "AppData", "Roaming");
  return scan.env.XDG_CONFIG_HOME || p.join(scan.home, ".config");
}

export function claudeDesktopFolders(scan: ScanEnvironment) {
  const p = pathsFor(scan.platform);
  const folders = [p.join(appDataFolder(scan), "Claude")];
  if (scan.platform === "win32") {
    // The Microsoft Store build writes to a redirected AppData.
    const local =
      scan.env.LOCALAPPDATA || p.join(scan.home, "AppData", "Local");
    folders.push(
      p.join(
        local,
        "Packages",
        "Claude_pzs8sxrjxfjjc",
        "LocalCache",
        "Roaming",
        "Claude",
      ),
    );
  }
  return folders;
}

/** `CLAUDE_CONFIG_DIR` moves both `.claude` and `.claude.json`. */
export function claudeCodePaths(scan: ScanEnvironment) {
  const p = pathsFor(scan.platform);
  const custom = scan.env.CLAUDE_CONFIG_DIR?.trim();
  return custom
    ? { folder: custom, json: p.join(custom, ".claude.json") }
    : {
        folder: p.join(scan.home, ".claude"),
        json: p.join(scan.home, ".claude.json"),
      };
}

export function codexFolder(scan: ScanEnvironment) {
  return (
    scan.env.CODEX_HOME?.trim() ||
    pathsFor(scan.platform).join(scan.home, ".codex")
  );
}

export function cursorMcpFile(scan: ScanEnvironment) {
  return pathsFor(scan.platform).join(scan.home, ".cursor", "mcp.json");
}

export function vscodeMcpFile(scan: ScanEnvironment) {
  return pathsFor(scan.platform).join(
    appDataFolder(scan),
    "Code",
    "User",
    "mcp.json",
  );
}

/** Folders Blame reads skills from in the home folder. */
export function blameSkillsFolder(scan: ScanEnvironment) {
  return pathsFor(scan.platform).join(scan.home, ".agents", "skills");
}

/** `/Users/me/.codex` shown as `~/.codex`. */
export function displayPath(scan: ScanEnvironment, value: string) {
  const p = pathsFor(scan.platform);
  const relative = p.relative(scan.home, value);
  if (relative === "") return "~";
  if (relative.startsWith("..") || p.isAbsolute(relative)) return value;
  return `~${p.sep}${relative}`;
}

/**
 * Cline keeps its servers in `cline_mcp_settings.json`: the CLI under
 * `~/.cline/data/settings` (`CLINE_DATA_DIR` moves it), the VS Code extension
 * in its global storage. Roo Code and Kilo Code are forks with their own
 * extension ids and `mcp_settings.json`.
 */
export function vscodeExtensionSettings(
  scan: ScanEnvironment,
  extensionId: string,
  file: string,
) {
  const p = pathsFor(scan.platform);
  const folder = p.join(
    appDataFolder(scan),
    "Code",
    "User",
    "globalStorage",
    extensionId,
    "settings",
  );
  return { folder, file: p.join(folder, file) };
}

export function clineFolder(scan: ScanEnvironment) {
  return (
    scan.env.CLINE_DIR?.trim() ||
    pathsFor(scan.platform).join(scan.home, ".cline")
  );
}

export function clineCliSettings(scan: ScanEnvironment) {
  const p = pathsFor(scan.platform);
  const data =
    scan.env.CLINE_DATA_DIR?.trim() || p.join(clineFolder(scan), "data");
  const folder = p.join(data, "settings");
  return {
    folder,
    file:
      scan.env.CLINE_MCP_SETTINGS_PATH?.trim() ||
      p.join(folder, "cline_mcp_settings.json"),
  };
}

/** `~/.config` (or `XDG_CONFIG_HOME`) on every system: OpenCode, Kilo, Goose. */
export function xdgConfigFolder(scan: ScanEnvironment) {
  return (
    scan.env.XDG_CONFIG_HOME?.trim() ||
    pathsFor(scan.platform).join(scan.home, ".config")
  );
}

export function openCodeFolder(scan: ScanEnvironment) {
  return pathsFor(scan.platform).join(xdgConfigFolder(scan), "opencode");
}

export function kiloFolder(scan: ScanEnvironment) {
  return pathsFor(scan.platform).join(xdgConfigFolder(scan), "kilo");
}

export function gooseConfigFile(scan: ScanEnvironment) {
  const p = pathsFor(scan.platform);
  return scan.platform === "win32"
    ? p.join(appDataFolder(scan), "Block", "goose", "config", "config.yaml")
    : p.join(xdgConfigFolder(scan), "goose", "config.yaml");
}

export function zedSettingsFile(scan: ScanEnvironment) {
  const p = pathsFor(scan.platform);
  return scan.platform === "win32"
    ? p.join(appDataFolder(scan), "Zed", "settings.json")
    : p.join(xdgConfigFolder(scan), "zed", "settings.json");
}

/** `GEMINI_CLI_HOME` relocates the folder; Qwen Code is a fork of the same. */
export function geminiFolder(scan: ScanEnvironment) {
  return pathsFor(scan.platform).join(
    scan.env.GEMINI_CLI_HOME?.trim() || scan.home,
    ".gemini",
  );
}

export function qwenFolder(scan: ScanEnvironment) {
  return pathsFor(scan.platform).join(scan.home, ".qwen");
}

export function continueFolder(scan: ScanEnvironment) {
  return (
    scan.env.CONTINUE_GLOBAL_DIR?.trim() ||
    pathsFor(scan.platform).join(scan.home, ".continue")
  );
}
