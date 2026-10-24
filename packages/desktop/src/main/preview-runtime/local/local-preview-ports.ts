import { createServer } from "node:net";
import type { PreviewExecutionPlan } from "@blame/preview-runtime";
import { publishedEndpointKeys } from "@blame/preview-runtime/compose";
import {
  dirnameWorkspacePath,
  joinWorkspacePath,
  mkdir,
  readFile,
  writeFile,
} from "../../workspace-runtime.ts";

// Each endpoint of a local preview is published on a port of this computer;
// the Blame Runtime forwards it from the VM. A start reuses the ports of the
// previous one while they are free, so the preview origin stays stable and
// its URL, cookies and login sessions survive a restart.

// `ownPorts` are published by this preview's running containers: they are
// busy, but still ours to keep.
export async function allocatePreviewHostPorts(
  worktree: string,
  plan: PreviewExecutionPlan,
  ownPorts: ReadonlySet<number> = new Set(),
) {
  const remembered = await rememberedHostPorts(worktree);
  const taken = new Set<number>();
  const ports: Record<string, number> = {};
  for (const key of publishedEndpointKeys(plan)) {
    const preferred = remembered[key] ?? remembered[legacyPortKey(plan, key)];
    const port =
      preferred &&
      !taken.has(preferred) &&
      (ownPorts.has(preferred) || (await localPortFree(preferred)))
        ? preferred
        : await freeLocalPort(taken);
    taken.add(port);
    ports[key] = port;
  }
  const path = previewPortsPath(worktree);
  await mkdir(dirnameWorkspacePath(path))
    .then(() => writeFile(path, `${JSON.stringify(ports)}\n`))
    .catch(() => undefined);
  return ports;
}

/** The ports of the last start, keyed `service:endpoint`. */
export async function rememberedHostPorts(worktree: string) {
  try {
    const value = JSON.parse(
      await readFile(previewPortsPath(worktree)),
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] =>
          Number.isInteger(entry[1]) && entry[1] > 1023 && entry[1] < 65536,
      ),
    );
  } catch {
    return {};
  }
}

// Earlier releases keyed ports by `service:containerPort`.
function legacyPortKey(plan: PreviewExecutionPlan, key: string) {
  const [serviceId, endpointId] = key.split(":");
  const port = plan.services
    .find(({ id }) => id === serviceId)
    ?.endpoints.find(({ id }) => id === endpointId)?.port;
  return `${serviceId}:${port}`;
}

function previewPortsPath(worktree: string) {
  return joinWorkspacePath(
    worktree,
    ".blame",
    "initialization",
    "preview-ports.json",
  );
}

function localPortFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function freeLocalPort(taken: Set<number>) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() =>
          address && typeof address !== "string"
            ? resolve(address.port)
            : reject(new Error("Unable to allocate a local port")),
        );
      });
    });
    if (!taken.has(port)) return port;
  }
  throw new Error("Unable to allocate a local port");
}
