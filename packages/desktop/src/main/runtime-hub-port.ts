import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeClineHubPort } from "./desktop-runtime-environment.ts";
import { unixListeningProcess } from "./local-port-owner.ts";

type Listener = { pid?: number; processName?: string };

type Dependencies = {
  listener(port: number): Promise<Listener | undefined>;
  // The process that forwards this build's runtime ports to the Mac.
  runtimeForwarder(): Promise<number | undefined>;
};

// On a Mac, Lima forwards the runtime's hub port to the same port here,
// unless another program already holds it. Blame then reaches that program
// instead of its runtime, and every agent start fails the same way: name
// the program rather than report a closed connection.
export async function runtimeHubPortConflict(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  dependencies: Dependencies = defaultDependencies(env),
): Promise<string | undefined> {
  if (platform !== "darwin") return undefined;
  const port = Number(runtimeClineHubPort(env));
  const listener = await dependencies.listener(port).catch(() => undefined);
  if (!listener?.pid) return undefined;
  const forwarder = await dependencies
    .runtimeForwarder()
    .catch(() => undefined);
  if (forwarder === undefined || forwarder === listener.pid) return undefined;
  const holder =
    listener.processName === "limactl"
      ? "Another Blame runtime, such as a Blame Dev build's,"
      : `${listener.processName || "Another program"} (process ${listener.pid})`;
  return `${holder} is using port ${port} on this Mac, so Blame can't reach its own runtime. Quit it, then restart Blame.`;
}

function defaultDependencies(env: NodeJS.ProcessEnv): Dependencies {
  return {
    listener: (port) => unixListeningProcess(port, "darwin"),
    runtimeForwarder: async () => {
      if (!env.LIMA_HOME) return undefined;
      const pid = Number(
        (
          await readFile(join(env.LIMA_HOME, "BlameRuntime", "ha.pid"), "utf8")
        ).trim(),
      );
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    },
  };
}
