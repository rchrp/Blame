import { join } from "node:path";

const packagedClineHubPort = "25463";

// Select once, before any runtime client starts. Commands and the detached
// shutdown process must inherit the same instance, including in preview mode.
export function desktopRuntimeEnvironment(input: {
  env: NodeJS.ProcessEnv;
  home: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  // The host reaches the runtime's Cline hub on this port. Each build has
  // its own, like its own VM or distro, so the installed app and a dev
  // build can run at the same time.
  const clineHubPort =
    input.env.BLAME_CLINE_HUB_PORT ||
    (input.isPackaged ? packagedClineHubPort : "25464");
  if (input.platform === "darwin") {
    return {
      BLAME_CLINE_HUB_PORT: clineHubPort,
      LIMA_HOME:
        input.env.LIMA_HOME ||
        join(
          input.home,
          "Library/Application Support",
          input.isPackaged ? "Blame" : "Blame Dev",
          "runtime/lima",
        ),
    };
  }
  if (input.platform === "win32") {
    return {
      BLAME_CLINE_HUB_PORT: clineHubPort,
      BLAME_WSL_DISTRO:
        input.env.BLAME_WSL_DISTRO ||
        (input.isPackaged ? "BlameRuntime" : "BlameRuntimeDev"),
    };
  }
  return {};
}

export function runtimeDistroName(env: NodeJS.ProcessEnv = process.env) {
  return env.BLAME_WSL_DISTRO || "BlameRuntime";
}

export function runtimeClineHubPort(env: NodeJS.ProcessEnv = process.env) {
  return env.BLAME_CLINE_HUB_PORT || packagedClineHubPort;
}
