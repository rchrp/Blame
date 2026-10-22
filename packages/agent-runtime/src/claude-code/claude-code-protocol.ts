import { createHash } from "node:crypto";

/**
 * The subset of the Anthropic Messages API that Cline's Anthropic provider
 * sends. The bridge reads it and answers in the same wire format.
 */
export type AnthropicBlock = {
  type: string;
  [key: string]: unknown;
};

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
};

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

export type MessagesRequest = {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicBlock[];
  tools?: AnthropicTool[];
  stream?: boolean;
  thinking?: { type?: string; budget_tokens?: number };
  output_config?: { effort?: string };
  /** The effort picked in Blame, carried by the bridge URL. */
  effort?: ClaudeCodeEffort;
};

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type McpToolResult = { content: McpContent[]; isError?: boolean };

export type ClaudeCodeEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Claude Code prefixes the tools of an MCP server with `mcp__<server>__`. */
export const bridgeMcpServerName = "blame";
export const bridgeToolPrefix = `mcp__${bridgeMcpServerName}__`;

export const claudeCodeEfforts: readonly ClaudeCodeEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export class BridgeRequestError extends Error {
  readonly status: number;
  readonly type: string;

  constructor(message: string, status = 400, type = "invalid_request_error") {
    super(message);
    this.status = status;
    this.type = type;
  }
}

export function parseMessagesRequest(body: unknown): MessagesRequest {
  if (!isRecord(body)) throw new BridgeRequestError("Body must be an object.");
  if (typeof body.model !== "string" || !body.model.trim())
    throw new BridgeRequestError("model is required.");
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    throw new BridgeRequestError("messages must be a non-empty array.");
  const messages = body.messages.map(parseMessage);
  if (messages.at(-1)?.role !== "user")
    throw new BridgeRequestError("The last message must come from the user.");
  return {
    model: body.model.trim(),
    messages,
    system: parseSystem(body.system),
    tools: parseTools(body.tools),
    stream: body.stream === true,
    thinking: isRecord(body.thinking)
      ? (body.thinking as MessagesRequest["thinking"])
      : undefined,
    output_config: isRecord(body.output_config)
      ? (body.output_config as MessagesRequest["output_config"])
      : undefined,
  };
}

export function systemText(request: MessagesRequest) {
  if (!request.system) return "";
  if (typeof request.system === "string") return request.system;
  return request.system
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n\n");
}

/** The effort for Claude Code's `--effort`: Blame's pick, else what Cline sent. */
export function requestEffort(
  request: MessagesRequest,
): ClaudeCodeEffort | undefined {
  if (request.effort) return request.effort;
  const effort = request.output_config?.effort;
  if (claudeCodeEfforts.includes(effort as ClaudeCodeEffort))
    return effort as ClaudeCodeEffort;
  const thinking = request.thinking;
  if (!thinking || thinking.type === "disabled") return undefined;
  const budget = thinking.budget_tokens ?? 0;
  if (budget >= 32_000) return "xhigh";
  if (budget >= 16_000) return "high";
  if (budget > 0) return "medium";
  return undefined;
}

/** Everything that fixes a Claude Code process: changing any of it needs a new one. */
export function laneSignature(request: MessagesRequest) {
  return sha256(
    JSON.stringify({
      model: request.model,
      effort: requestEffort(request) ?? null,
      system: systemText(request),
      tools: (request.tools ?? []).map((tool) => [
        tool.name,
        tool.description ?? "",
        tool.input_schema,
      ]),
    }),
  );
}

export function conversationRoot(request: MessagesRequest) {
  return sha256(JSON.stringify(request.messages[0]));
}

export function messageBlocks(message: AnthropicMessage): AnthropicBlock[] {
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}

export function toolUseIds(message: AnthropicMessage | undefined) {
  if (!message) return [];
  return messageBlocks(message).flatMap((block) =>
    block.type === "tool_use" && typeof block.id === "string" ? [block.id] : [],
  );
}

export function toolResults(message: AnthropicMessage) {
  return messageBlocks(message).filter(
    (block) =>
      block.type === "tool_result" && typeof block.tool_use_id === "string",
  );
}

/**
 * Builds the first user turn of a new Claude Code process. A fresh
 * conversation is sent as is; a longer history (after a restart, a compaction
 * or a model change) is replayed as a transcript, since Claude Code cannot be
 * seeded with earlier assistant turns.
 */
export function initialUserContent(messages: AnthropicMessage[]) {
  if (messages.length === 1) return userContent(messages[0]);
  const last = messages.at(-1)!;
  const replayLast = toolResults(last).length > 0;
  const history = replayLast ? messages : messages.slice(0, -1);
  const transcript = [
    "<blame_conversation_history>",
    "The conversation so far, replayed because the model session was restarted.",
    "Earlier tool calls already ran; their results are shown below. Do not repeat them unless needed.",
    "",
    ...history.map(transcriptEntry),
    "</blame_conversation_history>",
  ].join("\n");
  if (replayLast)
    return [
      {
        type: "text",
        text: `${transcript}\n\nContinue the task from the last tool results.`,
      },
    ];
  return [{ type: "text", text: transcript }, ...userContent(last)];
}

/** User content Claude Code accepts on stdin: text and images only. */
export function userContent(message: AnthropicMessage): AnthropicBlock[] {
  const blocks = messageBlocks(message).flatMap((block): AnthropicBlock[] => {
    if (block.type === "text" && typeof block.text === "string")
      return block.text ? [{ type: "text", text: block.text }] : [];
    if (block.type === "image" && isRecord(block.source))
      return [{ type: "image", source: block.source }];
    if (block.type === "document" || block.type === "file")
      return [{ type: "text", text: "[Attached file omitted]" }];
    return [];
  });
  return blocks.length ? blocks : [{ type: "text", text: "Continue." }];
}

/** Text that sits next to tool results in a user turn, kept with the results. */
export function userTextBesideToolResults(message: AnthropicMessage) {
  return messageBlocks(message)
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" && block.text
        ? [block.text]
        : [],
    )
    .join("\n\n");
}

export function mcpToolResult(
  block: AnthropicBlock,
  extraText?: string,
): McpToolResult {
  const content: McpContent[] = [];
  const raw = block.content;
  if (typeof raw === "string") content.push({ type: "text", text: raw });
  else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) continue;
      if (item.type === "text" && typeof item.text === "string")
        content.push({ type: "text", text: item.text });
      else if (item.type === "image" && isRecord(item.source)) {
        const source = item.source;
        if (
          source.type === "base64" &&
          typeof source.data === "string" &&
          typeof source.media_type === "string"
        )
          content.push({
            type: "image",
            data: source.data,
            mimeType: source.media_type,
          });
      }
    }
  }
  if (extraText) content.push({ type: "text", text: extraText });
  if (!content.length) content.push({ type: "text", text: "(no output)" });
  return { content, ...(block.is_error === true ? { isError: true } : {}) };
}

export function systemPromptForClaudeCode(request: MessagesRequest) {
  return [
    systemText(request),
    "",
    "# Tool and environment notes",
    `- Your tools are served under the \`${bridgeToolPrefix}\` prefix. Tool names in these instructions refer to the same tools without that prefix.`,
    "- Any working directory, scratchpad or environment section added outside these instructions belongs to the process that relays your requests, not to the user's project. Work only on the workspace described above, through your tools.",
  ].join("\n");
}

export function bridgeToolName(name: string) {
  return name.startsWith(bridgeToolPrefix)
    ? name.slice(bridgeToolPrefix.length)
    : name;
}

/** Rewrites one raw stream event from Claude Code into what Cline expects. */
export function clientStreamEvent(event: AnthropicBlock): AnthropicBlock {
  if (
    event.type === "content_block_start" &&
    isRecord(event.content_block) &&
    event.content_block.type === "tool_use" &&
    typeof event.content_block.name === "string"
  ) {
    const block = { ...event.content_block };
    delete block.caller;
    return {
      ...event,
      content_block: { ...block, name: bridgeToolName(block.name as string) },
    };
  }
  return event;
}

export function sseFrame(event: AnthropicBlock) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Folds stream events into one Messages API response for non-streaming calls. */
export function collectMessage(events: AnthropicBlock[]) {
  let message: Record<string, unknown> = {};
  const content: Record<string, unknown>[] = [];
  const partialJson = new Map<number, string>();
  for (const event of events) {
    if (event.type === "message_start" && isRecord(event.message))
      message = { ...event.message };
    else if (event.type === "content_block_start" && isRecord(event.content_block))
      content[Number(event.index)] = { ...event.content_block };
    else if (event.type === "content_block_delta" && isRecord(event.delta)) {
      const index = Number(event.index);
      const block = content[index];
      const delta = event.delta;
      if (!block) continue;
      if (delta.type === "text_delta")
        block.text = `${block.text ?? ""}${String(delta.text ?? "")}`;
      else if (delta.type === "thinking_delta")
        block.thinking = `${block.thinking ?? ""}${String(delta.thinking ?? "")}`;
      else if (delta.type === "signature_delta")
        block.signature = String(delta.signature ?? "");
      else if (delta.type === "input_json_delta")
        partialJson.set(
          index,
          `${partialJson.get(index) ?? ""}${String(delta.partial_json ?? "")}`,
        );
    } else if (event.type === "message_delta") {
      if (isRecord(event.delta)) message = { ...message, ...event.delta };
      if (isRecord(event.usage))
        message.usage = {
          ...(isRecord(message.usage) ? message.usage : {}),
          ...event.usage,
        };
    }
  }
  for (const [index, json] of partialJson) {
    const block = content[index];
    if (block) block.input = json ? JSON.parse(json) : {};
  }
  return { ...message, content: content.filter(Boolean) };
}

export function anthropicError(type: string, message: string) {
  return { type: "error", error: { type, message } };
}

/** Classifies a Claude Code failure into an Anthropic error status and type. */
export function classifyClaudeCodeError(message: string) {
  const text = message.toLowerCase();
  if (
    text.includes("not logged in") ||
    text.includes("/login") ||
    text.includes("authentication") ||
    text.includes("oauth token")
  )
    return { status: 401, type: "authentication_error" };
  if (text.includes("limit") || text.includes("rate"))
    return { status: 429, type: "rate_limit_error" };
  if (text.includes("overloaded")) return { status: 529, type: "overloaded_error" };
  if (text.includes("prompt is too long") || text.includes("context"))
    return { status: 400, type: "invalid_request_error" };
  return { status: 500, type: "api_error" };
}

function transcriptEntry(message: AnthropicMessage) {
  const lines = [`[${message.role}]`];
  for (const block of messageBlocks(message)) {
    if (block.type === "text" && typeof block.text === "string")
      lines.push(block.text);
    else if (block.type === "tool_use")
      lines.push(
        `[tool call ${String(block.id)}: ${bridgeToolName(String(block.name))}] ${JSON.stringify(block.input ?? {})}`,
      );
    else if (block.type === "tool_result")
      lines.push(
        `[tool result ${String(block.tool_use_id)}${block.is_error === true ? " (error)" : ""}]`,
        ...mcpToolResult(block).content.map((item) =>
          item.type === "text" ? item.text : "[image]",
        ),
      );
    else if (block.type === "image") lines.push("[image]");
  }
  return `${lines.join("\n")}\n`;
}

function parseMessage(value: unknown): AnthropicMessage {
  if (
    !isRecord(value) ||
    (value.role !== "user" && value.role !== "assistant") ||
    (typeof value.content !== "string" && !Array.isArray(value.content))
  )
    throw new BridgeRequestError("Each message needs a role and content.");
  return {
    role: value.role,
    content:
      typeof value.content === "string"
        ? value.content
        : value.content.filter(isRecord).map((block) => block as AnthropicBlock),
  };
}

function parseSystem(value: unknown): MessagesRequest["system"] {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.filter(isRecord).map((block) => block as AnthropicBlock);
  return undefined;
}

function parseTools(value: unknown): AnthropicTool[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((tool) =>
    isRecord(tool) &&
    typeof tool.name === "string" &&
    isRecord(tool.input_schema) &&
    (tool.type === undefined || tool.type === "custom")
      ? [
          {
            name: tool.name,
            description:
              typeof tool.description === "string" ? tool.description : undefined,
            input_schema: tool.input_schema,
          },
        ]
      : [],
  );
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
