import { createHash } from "node:crypto";
import { projectReadOverlap } from "./read-overlap-projection.js";
import { presentToolResults } from "./tool-result-presentation.js";
import { unwrapFeedbackEnvelope } from "./tool-result-envelope.js";
import type {
  AgentPlugin,
  ContentBlock,
  Message,
  ToolResultContent,
  ToolUseContent,
} from "@cline/sdk";

type ContextExtensionApi = Parameters<NonNullable<AgentPlugin["setup"]>>[0];

export type ContextProjectionMetrics = {
  categories: Record<string, number>;
  composedBytes: number;
  duplicateBytes: number;
  messageBytes: number;
  originalMessageBytes: number;
  projectedBytesSaved: number;
  requestIndex: number;
  staleReadsReplaced: number;
  successfulEditsReplaced: number;
  validatedEditsReplaced: number;
  systemPromptBytes: number;
  toolDefinitionBytes: number;
  transcriptHash: string;
};

type ContextProjectionOptions = {
  emit(metrics: ContextProjectionMetrics): void;
  systemPrompt: string;
  tools: unknown[];
};

type ProjectionStats = {
  staleReadsReplaced: number;
  successfulEditsReplaced: number;
  validatedEditsReplaced: number;
};

type ProjectionEntry = {
  source: Message;
  messages: Message[];
  stats: ProjectionStats;
};

type ProjectionPrefix = { entries: ProjectionEntry[]; tail?: ProjectionEntry };

type IndexedTool = {
  input: Record<string, unknown>;
  name: string;
  result?: Record<string, unknown>;
  resultIndex?: number;
};

type LatestEdit = {
  id: string;
  index: number;
  revision?: string;
};

type IndexedRead = {
  data: Record<string, unknown>;
  fragments: string[];
  projectedData?: Record<string, unknown>;
  superseded?: boolean;
  path: string;
  receipt?: string;
};

type HistoryIndex = {
  latestSourceRevision?: string;
  latestEditByPath: Map<string, LatestEdit>;
  latestReadIndexByPath: Map<string, number>;
  readById: Map<string, IndexedRead>;
  successfulEditIds: Set<string>;
  tools: Map<string, IndexedTool>;
  validations: ValidationProof[];
  preservedToolUseIds: Set<string>;
};

type ValidationProof = {
  index: number;
  paths: Set<string>;
  revision: string;
};

const minimumValidatedEditBytes = 4_096;

export function createContextProjectionExtension(
  options: ContextProjectionOptions,
): AgentPlugin {
  return {
    name: "blame-context-projection",
    manifest: { capabilities: ["messageBuilders"] },
    setup(api: ContextExtensionApi) {
      api.registerMessageBuilder(stableContextMessageBuilder(options));
    },
  };
}

function stableContextMessageBuilder(options: ContextProjectionOptions) {
  let requestIndex = 0;
  let committed: ProjectionEntry[] = [];
  return {
    name: "blame-provider-context-projection",
    build(messages: Message[]) {
      const ready = providerReadyMessages(messages);
      const canonical = providerMessageView(messages);
      const entries = stableProjectionEntries(canonical, committed);
      const projected = presentToolResults(entries.flatMap((entry) => entry.messages));
      if (!ready) return structuredClone(projected);
      committed = entries;
      requestIndex += 1;
      options.emit(contextMetrics(canonical, projected, options, projectionStats(entries), requestIndex));
      return structuredClone(projected);
    },
  };
}

function stableProjectionEntries(messages: Message[], committed: ProjectionEntry[]) {
  const prefix = extendingProjectionPrefix(messages, committed);
  if (prefix.entries.length === messages.length) return prefix.entries;
  const history = indexHistory(messages);
  for (const entry of [...prefix.entries, ...(prefix.tail ? [prefix.tail] : [])])
    for (const id of toolNamesById(entry.messages).keys()) history.preservedToolUseIds.add(id);
  return messages.map((message, index) => prefix.entries[index] ??
    projectNewEntry(message, index, history, index === prefix.entries.length ? prefix.tail : undefined));
}

function extendingProjectionPrefix(messages: Message[], entries: ProjectionEntry[]): ProjectionPrefix {
  if (messages.length < entries.length) return { entries: [] };
  for (let index = 0; index < entries.length; index += 1) {
    const previous = entries[index]!;
    const current = messages[index]!;
    if (JSON.stringify(current) === JSON.stringify(previous.source)) continue;
    if (index === entries.length - 1 && appendedContent(previous.source, current))
      return { entries: entries.slice(0, index), tail: previous };
    return { entries: [] };
  }
  return { entries };
}

function appendedContent(previous: Message, current: Message) {
  return previous.role === current.role && Array.isArray(previous.content) &&
    Array.isArray(current.content) && current.content.length > previous.content.length &&
    JSON.stringify(current.content.slice(0, previous.content.length)) === JSON.stringify(previous.content);
}

function projectNewEntry(message: Message, index: number, history: HistoryIndex, tail?: ProjectionEntry): ProjectionEntry {
  const stats = tail ? { ...tail.stats } : emptyProjectionStats();
  const suffix = tail ? { ...message, content: (message.content as ContentBlock[]).slice(tail.source.content.length) } : message;
  const projected = projectMessage(suffix, index, history, stats);
  const messages = tail ? appendProjectedContent(tail.messages, projected) : projected;
  return { source: structuredClone(message), messages: structuredClone(messages), stats };
}

function appendProjectedContent(previous: Message[], current: Message[]) {
  if (!previous.length) return current;
  if (!current.length) return previous;
  return [{ ...previous[0]!, content: [
    ...(previous[0]!.content as ContentBlock[]), ...(current[0]!.content as ContentBlock[]),
  ] }];
}

function projectionStats(entries: ProjectionEntry[]) {
  const total = emptyProjectionStats();
  for (const { stats } of entries)
    for (const key of Object.keys(total) as Array<keyof ProjectionStats>) total[key] += stats[key];
  return total;
}

function providerMessageView(messages: Message[]) {
  const projected: Message[] = [];
  for (const { role, content } of messages) {
    const previous = projected.at(-1);
    if (role === "user" && previous?.role === "user" && toolResultContent(content) && content.length > 0 && toolResultContent(previous.content))
      previous.content = [...previous.content, ...content];
    else projected.push({ role, content });
  }
  return projected;
}

function toolResultContent(content: Message["content"]): content is ToolResultContent[] {
  return Array.isArray(content) && content.every((block) => block.type === "tool_result");
}

export function projectProviderContext(
  messages: Message[],
  options: Pick<ContextProjectionOptions, "systemPrompt" | "tools">,
  requestIndex = 1,
) {
  const history = indexHistory(messages);
  const stats = emptyProjectionStats();
  const projected = messages.flatMap((message, index) =>
    projectMessage(message, index, history, stats),
  );
  return {
    messages: projected,
    metrics: contextMetrics(messages, projected, options, stats, requestIndex),
  };
}

function indexHistory(messages: Message[]): HistoryIndex {
  const history = emptyHistoryIndex();
  messages.forEach((message, index) => indexMessage(message, index, history));
  finalizeHistoryIndex(history);
  return history;
}

function indexMessage(message: Message, index: number, history: HistoryIndex) {
  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (block.type === "tool_use") indexToolUse(block, history);
    if (block.type === "tool_result") indexToolResult(block, index, history);
  }
}

function indexToolUse(block: ToolUseContent, history: HistoryIndex) {
  history.tools.set(block.id, { input: block.input, name: block.name });
}

function indexToolResult(
  block: ToolResultContent,
  index: number,
  history: HistoryIndex,
) {
  const tool = history.tools.get(block.tool_use_id);
  if (!tool) return;
  tool.result = block.is_error ? undefined : parseToolResult(block);
  tool.resultIndex = index;
}

function finalizeHistoryIndex(history: HistoryIndex) {
  const ordered = [...history.tools].sort(
    (left, right) => (left[1].resultIndex ?? -1) - (right[1].resultIndex ?? -1),
  );
  for (const [id, tool] of ordered) {
    if (tool.name === "read_code") indexRead(id, tool, history);
    if (tool.name === "edit_code" && successfulResult(tool.result)) {
      history.successfulEditIds.add(id);
      indexEdit(id, tool, history);
    }
    indexSourceRevision(tool, history);
    if (tool.name === "run_task") indexValidation(tool, history);
  }
  projectOverlappingReads(history);
}

function projectOverlappingReads(history: HistoryIndex) {
  const retainedByPath = new Map<string, string[]>();
  for (const read of [...history.readById.values()].reverse()) {
    if (read.superseded) continue;
    const references = retainedByPath.get(read.path) ?? [];
    if (!references.length) {
      retainedByPath.set(read.path, read.fragments);
      continue;
    }
    const projection = projectReadOverlap(read.data, references);
    if (projection.changed) read.projectedData = projection.data;
    retainedByPath.set(read.path, [...references, ...projection.retained]);
  }
}

function indexRead(id: string, tool: IndexedTool, history: HistoryIndex) {
  const resultIndex = tool.resultIndex ?? -1;
  const read = indexedRead(tool);
  if (!read) return;
  for (const previous of history.readById.values()) {
    if (previous.path === read.path && readSupersedes(previous, read, tool))
      previous.superseded = true;
  }
  history.readById.set(id, read);
  if (completeRead(tool))
    history.latestReadIndexByPath.set(read.path, resultIndex);
}

function completeRead(tool: IndexedTool) {
  const data = recordValue(tool.result?.data);
  if (typeof data?.complete === "boolean") return data.complete;
  return (
    typeof data?.content === "string" &&
    data.truncated !== true &&
    !tool.input.range &&
    !["range", "outline", "symbol"].includes(
      String(data.view ?? tool.input.view),
    )
  );
}

function indexEdit(id: string, tool: IndexedTool, history: HistoryIndex) {
  const data = recordValue(tool.result?.data);
  const revision = stringValue(data?.sourceRevisionId);
  const index = tool.resultIndex ?? -1;
  for (const change of arrayValue(data?.changes).map(recordValue)) {
    const path = stringValue(change?.path);
    if (path) history.latestEditByPath.set(path, { id, index, revision });
  }
}

function indexSourceRevision(tool: IndexedTool, history: HistoryIndex) {
  if (!successfulResult(tool.result)) return;
  const data = recordValue(tool.result?.data);
  const validation = recordValue(data?.validation);
  const revision =
    stringValue(data?.sourceRevisionId) ??
    stringValue(validation?.sourceRevisionId);
  if (revision) history.latestSourceRevision = revision;
}

function indexValidation(tool: IndexedTool, history: HistoryIndex) {
  const validation = recordValue(recordValue(tool.result?.data)?.validation);
  const revision = stringValue(validation?.sourceRevisionId);
  const paths = stringArray(validation?.paths);
  if (
    validation?.status !== "passed" ||
    !trustedValidationKind(validation?.taskKind) ||
    !revision ||
    !paths.length
  )
    return;
  history.validations.push({
    index: tool.resultIndex ?? -1,
    paths: new Set(paths),
    revision,
  });
}

function trustedValidationKind(value: unknown) {
  return ["build", "dependencies", "lint", "test", "typecheck"].includes(
    String(value),
  );
}

function projectMessage(
  message: Message,
  index: number,
  history: HistoryIndex,
  stats: ProjectionStats,
): Message[] {
  if (!Array.isArray(message.content)) return [message];
  const source = message.content as ContentBlock[];
  const content = source.flatMap((block: ContentBlock) =>
    projectBlock(block, index, history, stats),
  );
  if (!content.length) return [];
  const unchanged =
    content.length === source.length &&
    content.every((block, blockIndex) => block === source[blockIndex]);
  return [unchanged ? message : { ...message, content }];
}

function projectBlock(
  block: ContentBlock,
  index: number,
  history: HistoryIndex,
  stats: ProjectionStats,
): ContentBlock[] {
  if (block.type === "tool_use") return [projectToolUse(block, history, stats)];
  if (block.type !== "tool_result") return [block];
  if (compactableEdit(block.tool_use_id, history)) return [];
  const tool = history.tools.get(block.tool_use_id);
  if (tool?.name === "run_task") return [projectCommandResult(block, tool)];
  const read = history.readById.get(block.tool_use_id);
  if (read?.projectedData) return [partiallySupersededReadResult(block, read)];
  if (!read || !supersededRead(index, read, history)) return [block];
  stats.staleReadsReplaced += 1;
  return [supersededReadResult(block, read)];
}

function projectCommandResult(block: ToolResultContent, tool: IndexedTool): ToolResultContent {
  if (typeof block.content !== "string" || block.is_error) return block;
  const result = parseToolResult(block);
  const data = recordValue(result?.data);
  if (typeof tool.input.command !== "string" || data?.command !== tool.input.command)
    return block;
  const projectedData = { ...data };
  delete projectedData.command;
  return {
    ...block,
    content: JSON.stringify({ ...result, data: projectedData }),
  };
}

function supersededRead(
  readIndex: number,
  read: IndexedRead,
  history: HistoryIndex,
) {
  return (
    read.superseded ||
    (history.latestReadIndexByPath.get(read.path) ?? -1) > readIndex
  );
}

function readSupersedes(
  previous: IndexedRead,
  current: IndexedRead,
  tool: IndexedTool,
) {
  if (completeRead(tool)) return true;
  return (
    previous.fragments.length > 0 &&
    previous.fragments.every((fragment) =>
      current.fragments.some((replacement) => replacement.includes(fragment)),
    )
  );
}

function readFragments(data: Record<string, unknown>) {
  return [
    data.content,
    data.signature,
    data.body,
    data.imports,
    ...arrayValue(data.segments).map(
      (segment) => recordValue(segment)?.content,
    ),
  ].flatMap((value) =>
    typeof value === "string" && value.length ? [value] : [],
  );
}

function projectToolUse(
  block: ToolUseContent,
  history: HistoryIndex,
  stats: ProjectionStats,
): ContentBlock {
  if (!compactableEdit(block.id, history)) return block;
  const validated = validatedCurrentEdit(block.id, history);
  stats.successfulEditsReplaced += 1;
  if (validated) stats.validatedEditsReplaced += 1;
  const tool = history.tools.get(block.id);
  return {
    type: "text",
    text: `Historical completed edit (not an executable tool call): ${JSON.stringify(tool?.result)}`,
  };
}

function compactableEdit(id: string, history: HistoryIndex) {
  return (
    !history.preservedToolUseIds.has(id) &&
    history.successfulEditIds.has(id) &&
    (!unobservedCurrentEdit(id, history) || validatedCurrentEdit(id, history))
  );
}

function validatedCurrentEdit(id: string, history: HistoryIndex) {
  const tool = history.tools.get(id);
  const paths = changedPaths(tool);
  if (
    !paths.length ||
    !history.latestSourceRevision ||
    serializedBytes(tool?.input) < minimumValidatedEditBytes
  )
    return false;
  return history.validations.some(
    (validation) =>
      validation.index > (tool?.resultIndex ?? -1) &&
      validation.revision === history.latestSourceRevision &&
      paths.every((path) => validation.paths.has(path)),
  );
}

function unobservedCurrentEdit(id: string, history: HistoryIndex) {
  const tool = history.tools.get(id);
  const paths = changedPaths(tool);
  return paths.some((path) => {
    const edit = history.latestEditByPath.get(path);
    const readIndex = history.latestReadIndexByPath.get(path);
    return (
      edit?.id === id && (readIndex === undefined || readIndex <= edit.index)
    );
  });
}

function changedPaths(tool: IndexedTool | undefined) {
  const data = recordValue(tool?.result?.data);
  return arrayValue(data?.changes)
    .map(recordValue)
    .flatMap((change) => {
      const path = stringValue(change?.path);
      return path ? [path] : [];
    });
}

function supersededReadResult(
  block: ToolResultContent,
  read: IndexedRead,
): ToolResultContent {
  return {
    ...block,
    content: JSON.stringify({
      data: {
        ...readMetadata(read.data),
        path: read.path,
        receipt: read.receipt,
      },
      status: "superseded_by_later_read",
    }),
  };
}

function partiallySupersededReadResult(block: ToolResultContent, read: IndexedRead): ToolResultContent {
  return {
    ...block,
    content: JSON.stringify({
      data: read.projectedData,
      receipt: read.receipt,
      status: "partially_superseded_by_later_read",
    }),
  };
}

function readMetadata(data: Record<string, unknown>) {
  const contentKeys = new Set([
    "content",
    "signature",
    "body",
    "imports",
    "segments",
  ]);
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !contentKeys.has(key)),
  );
}

function contextMetrics(
  original: Message[],
  projected: Message[],
  options: Pick<ContextProjectionOptions, "systemPrompt" | "tools">,
  stats: ProjectionStats,
  requestIndex: number,
): ContextProjectionMetrics {
  const originalMessageBytes = serializedBytes(original);
  const messageBytes = serializedBytes(projected);
  const systemPromptBytes = utf8Bytes(options.systemPrompt);
  const toolDefinitionBytes = serializedBytes(
    options.tools.map(measurableToolDefinition),
  );
  return {
    categories: contextCategories(projected),
    composedBytes: messageBytes + systemPromptBytes + toolDefinitionBytes,
    duplicateBytes: duplicateContentBytes(projected),
    messageBytes,
    originalMessageBytes,
    projectedBytesSaved: originalMessageBytes - messageBytes,
    requestIndex,
    staleReadsReplaced: stats.staleReadsReplaced,
    successfulEditsReplaced: stats.successfulEditsReplaced,
    validatedEditsReplaced: stats.validatedEditsReplaced,
    systemPromptBytes,
    toolDefinitionBytes,
    transcriptHash: hashValue(projected),
  };
}

function contextCategories(messages: Message[]) {
  const categories: Record<string, number> = {};
  const toolNames = toolNamesById(messages);
  for (const message of messages) {
    if (typeof message.content === "string")
      addCategory(
        categories,
        `${message.role}_text`,
        utf8Bytes(message.content),
      );
    else
      for (const block of message.content)
        addCategory(
          categories,
          blockCategory(block, toolNames, message.role),
          serializedBytes(block),
        );
  }
  return categories;
}

function blockCategory(
  block: ContentBlock,
  toolNames: Map<string, string>,
  role: Message["role"],
) {
  if (block.type === "tool_use") return `tool_input.${block.name}`;
  if (block.type === "tool_result")
    return `tool_result.${toolNames.get(block.tool_use_id) ?? block.name}`;
  if (block.type === "thinking" || block.type === "redacted_thinking")
    return "assistant_reasoning";
  if (block.type === "text") return `${role}_text`;
  return "attachment";
}

function toolNamesById(messages: Message[]) {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content)
      if (block.type === "tool_use") names.set(block.id, block.name);
  }
  return names;
}

function duplicateContentBytes(messages: Message[]) {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const value of contentValues(messages)) {
    const bytes = serializedBytes(value);
    if (bytes < 32) continue;
    const hash = hashValue(value);
    if (seen.has(hash)) duplicates += bytes;
    else seen.add(hash);
  }
  return duplicates;
}

function contentValues(messages: Message[]): unknown[] {
  return messages.flatMap<unknown>((message) =>
    typeof message.content === "string"
      ? [message.content]
      : [...message.content],
  );
}

function parseToolResult(block: ToolResultContent) {
  try {
    return recordValue(unwrapFeedbackEnvelope(typeof block.content === "string" ? JSON.parse(block.content) : block.content));
  } catch {
    return undefined;
  }
}

function successfulResult(result: Record<string, unknown> | undefined) {
  return result?.status === "ok";
}

function emptyHistoryIndex(): HistoryIndex {
  return {
    latestEditByPath: new Map(),
    latestReadIndexByPath: new Map(),
    readById: new Map(),
    successfulEditIds: new Set(),
    tools: new Map(),
    validations: [],
    preservedToolUseIds: new Set(),
  };
}

function emptyProjectionStats(): ProjectionStats {
  return {
    staleReadsReplaced: 0,
    successfulEditsReplaced: 0,
    validatedEditsReplaced: 0,
  };
}

function addCategory(
  categories: Record<string, number>,
  category: string,
  bytes: number,
) {
  categories[category] = (categories[category] ?? 0) + bytes;
}

function hashValue(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function serializedBytes(value: unknown) {
  const serialized = JSON.stringify(value);
  return serialized ? utf8Bytes(serialized) : 0;
}

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown) {
  return arrayValue(value).flatMap((item) =>
    typeof item === "string" ? [item] : [],
  );
}

function indexedRead(tool: IndexedTool) {
  if (!successfulResult(tool.result)) return undefined;
  const data = recordValue(tool.result?.data);
  const directPath = stringValue(data?.path) ?? stringValue(tool.input.target);
  if (!directPath || !data) return undefined;
  return {
    data,
    fragments: readFragments(data),
    path: directPath,
    receipt: stringValue(tool.result?.receipt),
  };
}

function measurableToolDefinition(value: unknown) {
  const tool = recordValue(value);
  return {
    description: stringValue(tool?.description),
    inputSchema: tool?.inputSchema,
    name: stringValue(tool?.name),
  };
}

function providerReadyMessages(messages: Message[]) {
  return messages.every((message) =>
    Object.keys(message).every((key) => key === "content" || key === "role"),
  );
}
