import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

// Agent screenshots live outside the worktree, one folder per preview
// scope, named by the SHA-256 of their content: the same capture is stored
// once. A JSON file next to each image keeps its metadata.

export type AgentScreenshotMetadata = {
  byteLength: number;
  colorScheme: "dark" | "light";
  createdAt: string;
  height: number;
  id: string;
  mimeType: string;
  pageUrl: string;
  runId?: string;
  scope: string;
  sessionId?: string;
  toolCallId?: string;
  viewport: { height: number; width: number };
  width: number;
};

export type AgentScreenshotInput = Omit<
  AgentScreenshotMetadata,
  "byteLength" | "createdAt" | "id"
> & { createdAt?: string; data: Buffer };

const idPattern = /^[0-9a-f]{64}$/u;
const extensions = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);
export const maximumAgentScreenshotBytes = 25 * 1024 * 1024;

export function isAgentScreenshotId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

export function agentScreenshotId(data: Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

export class AgentScreenshotStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async save(input: AgentScreenshotInput): Promise<AgentScreenshotMetadata> {
    const extension = extensions.get(input.mimeType);
    if (!extension)
      throw new Error(`Unsupported screenshot type: ${input.mimeType}`);
    if (!input.scope.trim()) throw new Error("A screenshot needs a scope.");
    if (input.data.byteLength > maximumAgentScreenshotBytes)
      throw new Error("The screenshot is too large to store.");
    const id = agentScreenshotId(input.data);
    const directory = this.scopeDirectory(input.scope);
    await mkdir(directory, { recursive: true });
    const image = join(directory, `${id}.${extension}`);
    if (!(await exists(image))) await atomicWrite(image, input.data);
    const { data: _data, ...rest } = input;
    const metadata: AgentScreenshotMetadata = {
      ...rest,
      byteLength: input.data.byteLength,
      createdAt: input.createdAt ?? new Date().toISOString(),
      id,
    };
    await atomicWrite(
      join(directory, `${id}.json`),
      Buffer.from(JSON.stringify(metadata)),
    );
    return metadata;
  }

  async read(id: string) {
    if (!isAgentScreenshotId(id)) throw new Error("Invalid screenshot id.");
    const found = await this.find(id);
    if (!found) return undefined;
    const extension = extensions.get(found.metadata.mimeType);
    if (!extension) return undefined;
    const data = await readFile(join(found.directory, `${id}.${extension}`));
    if (agentScreenshotId(data) !== id) return undefined;
    return { data, metadata: found.metadata };
  }

  async metadata(id: string) {
    if (!isAgentScreenshotId(id)) return undefined;
    return (await this.find(id))?.metadata;
  }

  async list(filter: { runId?: string; scope?: string; sessionId?: string }) {
    const result: AgentScreenshotMetadata[] = [];
    for (const directory of await this.directories(filter.scope)) {
      for (const name of await readdir(directory).catch(() => [])) {
        if (!name.endsWith(".json")) continue;
        const metadata = await readMetadata(join(directory, name));
        if (
          metadata &&
          (!filter.runId || metadata.runId === filter.runId) &&
          (!filter.sessionId || metadata.sessionId === filter.sessionId)
        )
          result.push(metadata);
      }
    }
    return result.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  async deleteScope(scope: string) {
    await rm(this.scopeDirectory(scope), { force: true, recursive: true });
  }

  async deleteSessions(sessionIds: string[]) {
    const sessions = new Set(sessionIds.filter(Boolean));
    if (!sessions.size) return 0;
    let removed = 0;
    for (const metadata of await this.list({})) {
      if (!metadata.sessionId || !sessions.has(metadata.sessionId)) continue;
      await this.remove(metadata);
      removed += 1;
    }
    return removed;
  }

  private async remove(metadata: AgentScreenshotMetadata) {
    const directory = this.scopeDirectory(metadata.scope);
    const extension = extensions.get(metadata.mimeType) ?? "png";
    await Promise.all([
      rm(join(directory, `${metadata.id}.${extension}`), { force: true }),
      rm(join(directory, `${metadata.id}.json`), { force: true }),
    ]);
  }

  private async find(id: string) {
    for (const directory of await this.directories()) {
      const metadata = await readMetadata(join(directory, `${id}.json`));
      if (metadata?.id === id) return { directory, metadata };
    }
    return undefined;
  }

  private async directories(scope?: string) {
    if (scope) return [this.scopeDirectory(scope)];
    const entries = await readdir(this.root, { withFileTypes: true }).catch(
      () => [],
    );
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(this.root, entry.name));
  }

  // Readable and collision-free: a sanitized prefix and a short hash.
  private scopeDirectory(scope: string) {
    const readable = scope.replace(/[^a-zA-Z0-9_.-]+/gu, "-").slice(0, 80);
    const digest = createHash("sha256")
      .update(scope)
      .digest("hex")
      .slice(0, 12);
    return join(this.root, `${readable}-${digest}`);
  }
}

async function readMetadata(path: string) {
  try {
    const value = JSON.parse(
      await readFile(path, "utf8"),
    ) as AgentScreenshotMetadata;
    return isAgentScreenshotId(value?.id) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(path: string, data: Buffer) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}
