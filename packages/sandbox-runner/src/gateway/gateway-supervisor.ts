import { createPublicKey } from "node:crypto";
import { spawn } from "node:child_process";
import { chown, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import type { GatewayRoute } from "./http-forwarder.js";
import { runtimePaths } from "../runtime-paths.js";

// One gateway process per instance: the preview's, and the component
// preview's on its reserved port. Restarting one never drops the other's
// connections.
export type GatewayInstance = {
  configPath: string;
  logPath: string;
  pidPath: string;
};

export const previewGatewayInstance: GatewayInstance = {
  configPath: runtimePaths.gatewayConfig,
  logPath: "/var/log/blame/gateway.log",
  pidPath: "/run/blame/gateway.pid",
};

export class GatewaySupervisor {
  private readonly instance: GatewayInstance;

  constructor(instance: GatewayInstance = previewGatewayInstance) {
    this.instance = instance;
  }

  async start(input: { publicKeyPem: string; routes: GatewayRoute[] }) {
    createPublicKey(input.publicKeyPem);
    await this.stop();
    await mkdir("/run/blame", { recursive: true, mode: 0o750 });
    await writeFile(runtimePaths.capabilityPublicKey, input.publicKeyPem, { mode: 0o640, flush: true });
    await writeFile(
      this.instance.configPath,
      JSON.stringify({
        capabilityPublicKeyPath: runtimePaths.capabilityPublicKey,
        routes: input.routes,
        maxConnections: 128,
      }),
      { mode: 0o640, flush: true },
    );
    const identity = await systemIdentity("blame-control");
    await Promise.all([
      chown(runtimePaths.capabilityPublicKey, identity.uid, identity.gid),
      chown(this.instance.configPath, identity.uid, identity.gid),
    ]);
    const log = await open(this.instance.logPath, "a", 0o600);
    const executable = process.argv[1];
    if (!executable) throw new Error("Runner executable path is unavailable.");
    const child = spawn(
      process.execPath,
      [executable, "gateway", "--config", this.instance.configPath],
      {
        detached: true,
        uid: identity.uid,
        gid: identity.gid,
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    child.unref();
    if (!child.pid) throw new Error("Unable to start preview gateway.");
    await writeFile(this.instance.pidPath, String(child.pid), {
      mode: 0o600,
      flush: true,
    });
    for (const route of input.routes) await waitForListener(route.sandboxPort);
  }

  async stop() {
    try {
      const pid = Number(await readFile(this.instance.pidPath, "utf8"));
      if (Number.isSafeInteger(pid)) process.kill(-pid, "SIGTERM");
    } catch {}
    await rm(this.instance.pidPath, { force: true });
  }
}

function systemIdentity(user: string) {
  return Promise.all([idValue("-u", user), idValue("-g", user)]).then(([uid, gid]) => ({ uid, gid }));
}

function idValue(flag: "-u" | "-g", user: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("id", [flag, user], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      const value = Number(output.trim());
      code === 0 && Number.isSafeInteger(value) ? resolve(value) : reject(new Error(`${user} is unavailable.`));
    });
  });
}

async function waitForListener(port: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await listenerReady(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Preview gateway listener ${port} did not start.`);
}

function listenerReady(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setTimeout(100);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}
