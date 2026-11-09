import { resolve } from "node:path";
import type { WorkspaceFiles } from "./workspace-files.js";

export class EnvironmentAdapter {
  private readonly files: WorkspaceFiles;
  private readonly platform: NodeJS.Platform;

  constructor(
    files: WorkspaceFiles,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.files = files;
    this.platform = platform;
  }

  /**
   * The login shell's profile may put its own directories before the PATH a
   * command inherits: path_helper (/etc/profile on macOS) and `brew shellenv`
   * do. A directory that must come first is put back first after the profile.
   */
  command(command: string, firstPathDirectory?: string) {
    if (this.platform === "win32")
      return { executable: "cmd.exe", args: ["/d", "/s", "/c", command] };
    // Same line as the command, so the shell's line numbers stay the command's.
    const script = firstPathDirectory
      ? `PATH=${shellQuoted(firstPathDirectory)}:"$PATH"; ${command}`
      : command;
    return {
      executable: "/bin/bash",
      args: ["-o", "pipefail", "-lc", script],
    };
  }

  async cwd(path = ".") {
    const normalized = this.files.normalizePath(path);
    const profile = await this.files.pathProfile(normalized);
    if (!profile.directory)
      throw new Error(`${normalized} is not a directory.`);
    return resolve(this.files.root, normalized);
  }

  target() {
    if (this.platform === "darwin") return "macos-native" as const;
    if (this.platform === "win32") return "windows-native" as const;
    return "linux-native" as const;
  }
}

function shellQuoted(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
