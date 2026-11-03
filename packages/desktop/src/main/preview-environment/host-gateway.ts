import type { CommandResult } from "@blame/preview-runtime/compose";

// How preview containers reach the developer's computer. Inside a container,
// localhost is the container itself, so a database the developer runs on
// their computer needs another name: Blame maps `host.docker.internal` to the
// gateway of the Docker host in every preview's Compose file.
//
// - macOS: the Blame Runtime is a Lima VM with user-mode networking. Its
//   gateway, `host.lima.internal` (192.168.5.2), forwards to the Mac's own
//   127.0.0.1, so a database that only listens on localhost answers.
// - Windows: WSL's default gateway is the Windows host, but a database that
//   only listens on 127.0.0.1 there is out of reach from WSL's NAT network.
// - Linux: Docker's `host-gateway` is the computer's bridge address, which a
//   database bound to 127.0.0.1 does not listen on either.

export const previewHostAlias = "host.docker.internal";

export type PreviewHostGateway = {
  alias: string;
  /** What `extra_hosts` maps the alias to: an address or `host-gateway`. */
  address: string;
  /** Whether a service bound to 127.0.0.1 on the computer answers there. */
  reachesLoopback: boolean;
};

type HostRun = (command: string, args: string[]) => Promise<CommandResult>;

const limaGateway = "192.168.5.2";
const gateways = new Map<string, Promise<PreviewHostGateway>>();

export function localPreviewHostGateway(
  run: HostRun,
  platform: NodeJS.Platform = process.platform,
) {
  const cached = gateways.get(platform);
  if (cached) return cached;
  const next = detectHostGateway(run, platform).catch((error) => {
    gateways.delete(platform);
    throw error;
  });
  gateways.set(platform, next);
  return next;
}

async function detectHostGateway(
  run: HostRun,
  platform: NodeJS.Platform,
): Promise<PreviewHostGateway> {
  if (platform === "darwin") {
    const address = await firstAddress(
      run,
      "getent hosts host.lima.internal | awk '{print $1; exit}'",
    );
    return {
      alias: previewHostAlias,
      address: address ?? limaGateway,
      reachesLoopback: true,
    };
  }
  if (platform === "win32") {
    const address = await firstAddress(
      run,
      "ip route show default | awk '{print $3; exit}'",
    );
    return {
      alias: previewHostAlias,
      address: address ?? "host-gateway",
      reachesLoopback: false,
    };
  }
  return {
    alias: previewHostAlias,
    address: "host-gateway",
    reachesLoopback: false,
  };
}

async function firstAddress(run: HostRun, script: string) {
  try {
    const result = await run("sh", ["-c", script]);
    const address = result.stdout.trim().split(/\s+/)[0];
    return result.exitCode === 0 && address && /^[\d.:a-f]+$/i.test(address)
      ? address
      : undefined;
  } catch {
    return undefined;
  }
}

/** The `extra_hosts` entry every preview container gets. */
export function previewExtraHosts(gateway: PreviewHostGateway | undefined) {
  return gateway ? { [gateway.alias]: gateway.address } : {};
}

/** What a preview needs to know about a value that pointed at localhost. */
export function hostGatewayNote(gateway: PreviewHostGateway) {
  return gateway.reachesLoopback
    ? `localhost on your computer is reached at ${gateway.alias}`
    : `localhost on your computer is reached at ${gateway.alias}, which only answers when the database listens on all interfaces, not just 127.0.0.1`;
}
