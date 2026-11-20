#!/usr/bin/env node
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { validateContent } from "./content-validation.js";
import { ImportIndex } from "./import-index.js";
import { semanticReferenceLimits } from "./semantic-reference-types.js";
import type { DependencyDeclarationRequest, SemanticReferenceRequest } from "./semantic-reference-types.js";
import { CompilerServices } from "./semantic-reference-client.js";
import { WorkspaceFiles, type WorkspaceSnapshot } from "./workspace-files.js";

// The compiler side process of the Rust harness (crates/blame-harness): what
// must stay on the TypeScript compiler, served over JSON lines. It lives next
// to the modules it reuses unchanged: compiler workers per workspace root
// (at most three, each stopped after 30 s idle, as in-process), the import
// index behind `links`, and content validation.
//
// Messages, each with an `id`, answered with `reply` or `error`:
// - `references`: a SemanticReferenceRequest (with `renameTo` for a rename);
// - `declaration`: a DependencyDeclarationRequest;
// - `links`: `{ key, root, path, content (base64), focus, snapshot }`, one
//   import index per `key` (one Rust workspace);
// - `validate`: `{ path, content (base64 or null), workspaceRoot, externalValidation? }`;
// - `cancel`: aborts the message with that id.
// The process exits once idle for BLAME_HARNESS_COMPILER_IDLE_MS (5 min).

type Message = {
  id?: string;
  cancel?: boolean;
  references?: SemanticReferenceRequest;
  declaration?: DependencyDeclarationRequest;
  links?: { key: string; root: string; path: string; content: string; focus: string[]; snapshot: WorkspaceSnapshot };
  validate?: { path: string; content: string | null; workspaceRoot: string; externalValidation?: "enabled" | "unsupported" };
};

const services = new CompilerServices();
const indexes = new Map<string, ImportIndex>();
const maximumIndexes = 8;
const inFlight = new Map<string, AbortController>();
const idleMs = Number(process.env.BLAME_HARNESS_COMPILER_IDLE_MS ?? 5 * 60_000);
let idleTimer: ReturnType<typeof setTimeout> | undefined;

const write = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);

function idle() {
  clearTimeout(idleTimer);
  if (inFlight.size) return;
  idleTimer = setTimeout(() => void stop(), idleMs);
}

async function stop() {
  await services.close();
  process.exit(0);
}

function importIndex(key: string, root: string) {
  let index = indexes.get(key);
  if (index) indexes.delete(key);
  else index = new ImportIndex(new WorkspaceFiles(root));
  indexes.set(key, index);
  // Least recently used first.
  while (indexes.size > maximumIndexes) indexes.delete(indexes.keys().next().value!);
  return index;
}

async function answer(message: Message, signal: AbortSignal): Promise<unknown> {
  if (message.references) {
    const timeout = message.references.renameTo ? semanticReferenceLimits.renameTimeoutMs : semanticReferenceLimits.timeoutMs;
    return services.query(message.references, signal, timeout);
  }
  if (message.declaration) return services.query(message.declaration, signal, semanticReferenceLimits.timeoutMs);
  if (message.links) {
    const { key, root, path, content, focus, snapshot } = message.links;
    const links = await importIndex(key, root).briefLinks(path, Buffer.from(content, "base64"), new Set(focus), signal, { snapshot });
    return links ?? null;
  }
  if (message.validate) {
    const { content, ...input } = message.validate;
    return validateContent({ ...input, content: content === null ? null : Buffer.from(content, "base64") });
  }
  throw new Error("A compiler request is required.");
}

process.once("SIGTERM", () => void stop());
write({ ready: true, protocol: 1 });
idle();
for await (const line of createInterface({ input: stdin, crlfDelay: Infinity })) {
  let message: Message;
  try { message = JSON.parse(line) as Message; } catch { continue; }
  const id = String(message.id ?? "");
  if (!id) continue;
  if (message.cancel) {
    inFlight.get(id)?.abort(new Error("Compiler request cancelled."));
    continue;
  }
  const controller = new AbortController();
  inFlight.set(id, controller);
  clearTimeout(idleTimer);
  answer(message, controller.signal)
    .then((reply) => write({ id, reply }))
    .catch((error: unknown) => write({ id, error: error instanceof Error ? error.message : String(error) }))
    .finally(() => { inFlight.delete(id); idle(); });
}
// The harness closed the pipe.
await stop();
