import { join } from "node:path";

export function desktopResourcePaths(applicationPath: string) {
  const outputPath = join(applicationPath, "out");
  return {
    agentRuntime: join(outputPath, "main/agent-runtime-process.js"),
    // Packaged with the app (see `files` in electron-builder.config.ts).
    linuxWindowIcon: join(applicationPath, "icons/prod/icon.png"),
    preload: join(outputPath, "preload/index.js"),
    renderer: join(outputPath, "renderer/index.html"),
  };
}
