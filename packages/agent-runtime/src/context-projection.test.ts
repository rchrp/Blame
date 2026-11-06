import assert from "node:assert/strict";
import test from "node:test";
import {
  createContextCompactionPrepareTurn,
  createProviderConfig,
  type Message,
  type ContentBlock,
} from "@cline/sdk";
import {
  createContextProjectionExtension,
  projectProviderContext,
  type ContextProjectionMetrics,
} from "./context-projection.js";
import { presentToolResults } from "./tool-result-presentation.js";
import { encodeToolResult, unwrapFeedbackEnvelope } from "./tool-result-envelope.js";

test("projects acknowledged edits and reads superseded after edits", () => {
  const original = projectionMessages();
  const projection = projectProviderContext(
    original,
    { systemPrompt: "system", tools: [{ name: "edit_code" }] },
    3,
  );
  const serialized = JSON.stringify(projection.messages);
  assert.doesNotMatch(serialized, /FIRST_PATCH|ORIGINAL_SOURCE/u);
  assert.match(serialized, /FRESH_SOURCE|LATEST_PATCH/u);
  assert.match(serialized, /FAILED_PATCH/u);
  assert.match(serialized, /superseded_by_later_read/u);
  assert.match(JSON.stringify(original), /FIRST_PATCH|ORIGINAL_SOURCE/u);
  assert.equal(projection.metrics.requestIndex, 3);
  assert.equal(projection.metrics.staleReadsReplaced, 1);
  assert.equal(projection.metrics.successfulEditsReplaced, 1);
  assert.ok(projection.metrics.projectedBytesSaved > 0);
  assert.equal(projection.metrics.transcriptHash.length, 64);
});

test("preserves an edited path read until a fresh read replaces it", () => {
  const original = projectionMessages().slice(0, 4);
  const projection = projectProviderContext(original, {
    systemPrompt: "system",
    tools: [{ name: "edit_code" }],
  });
  assert.match(JSON.stringify(projection.messages), /ORIGINAL_SOURCE/u);
  assert.equal(projection.metrics.staleReadsReplaced, 0);
});

test("partial reads preserve the earlier source and edit needed for reconstruction", () => {
  for (const view of ["range", "symbol", "outline"]) {
    const history = projectionMessages().slice(0, 4);
    history.push(toolUse("partial", "read_code", { target: "src/a.ts", view }));
    history.push(
      toolResult("partial", "read_code", {
        status: "ok",
        data: { complete: false, path: "src/a.ts", content: "ONE_LINE" },
      }),
    );
    const projection = projectProviderContext(history, {
      systemPrompt: "",
      tools: [],
    });
    assert.match(JSON.stringify(projection.messages), /ORIGINAL_SOURCE/u);
    assert.match(JSON.stringify(projection.messages), /FIRST_PATCH/u);
    assert.equal(projection.metrics.staleReadsReplaced, 0);
  }
});

test("a complete later read replaces source changed by an external command", () => {
  const history = projectionMessages().slice(0, 2);
  history.push(
    toolUse("new", "read_code", { target: "src/a.ts", view: "raw" }),
  );
  history.push(
    toolResult("new", "read_code", {
      status: "ok",
      data: { path: "src/a.ts", complete: true, content: "CURRENT_SOURCE" },
    }),
  );
  const result = projectProviderContext(history, {
    systemPrompt: "",
    tools: [],
  });
  assert.doesNotMatch(JSON.stringify(result.messages), /ORIGINAL_SOURCE/u);
  assert.match(JSON.stringify(result.messages), /CURRENT_SOURCE/u);
});

test("partial reads remove only text fully present in a later read", () => {
  const fragment = "shared declaration\n".repeat(100);
  const history: Message[] = [];
  for (const [id, content] of [
    ["old", fragment],
    ["unique", "UNIQUE_REMAINDER"],
    ["new", fragment + "ADDED_LINE"],
  ]) {
    history.push(
      toolUse(id, "read_code", { target: "src/a.ts", view: "range" }),
    );
    history.push(
      toolResult(id, "read_code", {
        status: "ok",
        data: {
          path: "src/a.ts",
          complete: false,
          content,
          editTargets: [{ alias: id }],
        },
      }),
    );
  }
  const original = JSON.stringify(history);
  const result = projectProviderContext(history, {
    systemPrompt: "",
    tools: [],
  });
  assert.equal(result.metrics.staleReadsReplaced, 1);
  assert.ok(result.metrics.projectedBytesSaved > fragment.length - 200);
  assert.match(JSON.stringify(result.messages), /UNIQUE_REMAINDER|ADDED_LINE/u);
  assert.equal(JSON.stringify(history), original);
  assert.deepEqual(
    projectProviderContext(result.messages, { systemPrompt: "", tools: [] })
      .messages,
    result.messages,
  );
});

test("identical range requests cannot erase different observed source", () => {
  const history: Message[] = [];
  for (const [id, content] of [
    ["old", "ORIGINAL_LINES"],
    ["new", "DIFFERENT_LINES"],
  ]) {
    history.push(
      toolUse(id, "read_code", {
        target: "src/a.ts",
        view: "range",
        range: { startLine: 1, endLine: 3 },
      }),
    );
    history.push(
      toolResult(id, "read_code", {
        status: "ok",
        data: { path: "src/a.ts", complete: false, content },
      }),
    );
  }
  const result = projectProviderContext(history, {
    systemPrompt: "",
    tools: [],
  });
  assert.equal(result.metrics.staleReadsReplaced, 0);
  assert.match(JSON.stringify(result.messages), /ORIGINAL_LINES/u);
});

test("summarizes completed edits without teaching invalid tool arguments", () => {
  const original = projectionMessages();
  const before = JSON.stringify(original);
  const { messages } = projectProviderContext(original, {
    systemPrompt: "",
    tools: [],
  });
  const blocks = messages.flatMap((message) =>
    typeof message.content === "string" ? [] : message.content,
  );
  const calls = blocks.filter((block) => block.type === "tool_use");
  const results = blocks.filter((block) => block.type === "tool_result");
  for (const call of calls.filter((call) => call.name === "edit_code")) {
    assert.ok(Array.isArray(call.input.operations));
    assert.equal(call.input.acknowledged, undefined);
  }
  assert.deepEqual(
    results.map((result) => result.tool_use_id),
    calls.map((call) => call.id),
  );
  assert.match(JSON.stringify(messages), /Historical completed edit.*c1/u);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(
    projectProviderContext(messages, { systemPrompt: "", tools: [] }).messages,
    messages,
  );
});

test("preserves sibling calls, results and user instructions in a mixed batch", () => {
  const original = projectionMessages();
  const content = (index: number) =>
    original[index].content as Exclude<Message["content"], string>;
  const mixed: Message[] = [
    { role: "assistant", content: [...content(2), ...content(6)] },
    {
      role: "user",
      content: [
        ...content(3),
        ...content(7),
        { type: "text", text: "Keep keyboard navigation" },
      ],
    },
    original[4],
    original[5],
  ];
  const { messages } = projectProviderContext(mixed, {
    systemPrompt: "",
    tools: [],
  });
  const serialized = JSON.stringify(messages);
  assert.doesNotMatch(serialized, /FIRST_PATCH|"tool_use_id":"edit-1"/u);
  assert.match(serialized, /LATEST_PATCH/u);
  assert.match(serialized, /Keep keyboard navigation/u);
  assert.match(serialized, /"tool_use_id":"edit-2"/u);
});

test("never summarizes an errored tool result even if its payload says ok", () => {
  const original = projectionMessages();
  const result = original[3].content as Exclude<Message["content"], string>;
  assert.equal(result[0].type, "tool_result");
  if (result[0].type === "tool_result") result[0].is_error = true;
  const { messages } = projectProviderContext(original, {
    systemPrompt: "",
    tools: [],
  });
  assert.match(JSON.stringify(messages), /FIRST_PATCH/u);
});

test("preserves current edits independently until their paths are observed", () => {
  const messages = [
    toolUse("edit-a", "edit_code", editInput("src/a.ts", "CURRENT_A")),
    successfulEditResult("edit-a", "c1", "src/a.ts", "src_1"),
    toolUse("edit-b", "edit_code", editInput("src/b.ts", "CURRENT_B")),
    successfulEditResult("edit-b", "c2", "src/b.ts", "src_2"),
  ];
  const projection = projectProviderContext(messages, {
    systemPrompt: "system",
    tools: [{ name: "edit_code" }],
  });
  const serialized = JSON.stringify(projection.messages);
  assert.match(serialized, /CURRENT_A/u);
  assert.match(serialized, /CURRENT_B/u);
  assert.equal(projection.metrics.successfulEditsReplaced, 0);
});

test("compacts an edit after a fresh read while retaining another path", () => {
  const messages = [
    toolUse("edit-a", "edit_code", editInput("src/a.ts", "OBSERVED_A")),
    successfulEditResult("edit-a", "c1", "src/a.ts", "src_1"),
    toolUse("read-a", "read_code", { target: "src/a.ts" }),
    toolResult("read-a", "read_code", {
      data: { content: "CURRENT_A", path: "src/a.ts" },
      status: "ok",
    }),
    toolUse("edit-b", "edit_code", editInput("src/b.ts", "CURRENT_B")),
    successfulEditResult("edit-b", "c2", "src/b.ts", "src_2"),
  ];
  const projection = projectProviderContext(messages, {
    systemPrompt: "system",
    tools: [{ name: "edit_code" }],
  });
  const serialized = JSON.stringify(projection.messages);
  assert.doesNotMatch(serialized, /OBSERVED_A/u);
  assert.match(serialized, /CURRENT_A/u);
  assert.match(serialized, /CURRENT_B/u);
  assert.equal(projection.metrics.successfulEditsReplaced, 1);
});

test("compacts a large edit after validation of the current revision", () => {
  const largeContent = "LARGE_VALIDATED_EDIT".repeat(400);
  const messages = [
    toolUse("edit-a", "edit_code", editInput("src/a.ts", largeContent)),
    successfulEditResult("edit-a", "c1", "src/a.ts", "src_1"),
    toolUse("build", "run_task", { kind: "project", task: "build" }),
    validationResult("build", ["src/a.ts"], "src_1"),
  ];
  const projection = projectProviderContext(messages, {
    systemPrompt: "system",
    tools: [{ name: "edit_code" }],
  });
  assert.doesNotMatch(
    JSON.stringify(projection.messages),
    /LARGE_VALIDATED_EDIT/u,
  );
  assert.equal(projection.metrics.successfulEditsReplaced, 1);
  assert.equal(projection.metrics.validatedEditsReplaced, 1);
  assert.ok(projection.metrics.projectedBytesSaved > 4_096);
});

test("preserves edits when validation is stale or partial", () => {
  const large = "UNPROVEN_EDIT".repeat(400);
  const messages = [
    toolUse("edit-a", "edit_code", editInput("src/a.ts", large)),
    successfulEditResult("edit-a", "c1", "src/a.ts", "src_1"),
    toolUse("build", "run_task", { kind: "project", task: "build" }),
    validationResult("build", ["src/other.ts"], "src_1"),
    toolUse("edit-b", "edit_code", editInput("src/b.ts", "CURRENT_B")),
    successfulEditResult("edit-b", "c2", "src/b.ts", "src_2"),
  ];
  const projection = projectProviderContext(messages, {
    systemPrompt: "system",
    tools: [{ name: "edit_code" }],
  });
  const serialized = JSON.stringify(projection.messages);
  assert.match(serialized, /UNPROVEN_EDIT/u);
  assert.match(serialized, /CURRENT_B/u);
  assert.equal(projection.metrics.validatedEditsReplaced, 0);
});

test("preserves a small edit after validation", () => {
  const messages = [
    toolUse("edit-a", "edit_code", editInput("src/a.ts", "SMALL_EDIT")),
    successfulEditResult("edit-a", "c1", "src/a.ts", "src_1"),
    toolUse("build", "run_task", { kind: "project", task: "build" }),
    validationResult("build", ["src/a.ts"], "src_1"),
  ];
  const projection = projectProviderContext(messages, {
    systemPrompt: "system",
    tools: [{ name: "edit_code" }],
  });
  assert.match(JSON.stringify(projection.messages), /SMALL_EDIT/u);
  assert.equal(projection.metrics.validatedEditsReplaced, 0);
});

test("validated edits compact without source revisions, until a later change to the source", () => {
  const large = "REVISIONLESS_EDIT".repeat(400);
  const edit = toolResult("edit-a", "edit_code", { data: { changed: true, changes: [{ path: "src/a.ts" }] }, status: "ok" });
  const build = toolResult("build", "run_task", { data: { validation: { paths: ["src/a.ts"], status: "passed", taskKind: "build" } }, status: "ok" });
  const base = [toolUse("edit-a", "edit_code", editInput("src/a.ts", large)), edit,
    toolUse("build", "run_task", { kind: "project", task: "build" }), build];
  const validated = projectProviderContext(base, { systemPrompt: "", tools: [] });
  assert.doesNotMatch(JSON.stringify(validated.messages), /REVISIONLESS_EDIT/u);
  assert.equal(validated.metrics.validatedEditsReplaced, 1);
  for (const later of [
    { data: { command: "pnpm format", changed: true, paths: ["src/b.ts"] }, status: "ok" },
    { data: { mutation: "deterministic_format", formatter: "prettier", paths: ["src/a.ts"] }, status: "ok" },
    { data: { command: "pnpm codegen", exitCode: 0, paths: ["src/generated.ts"] }, status: "ok" },
  ]) {
    const changed = projectProviderContext([...base, toolUse("later", "run_task", { command: "pnpm format" }),
      toolResult("later", "run_task", later)], { systemPrompt: "", tools: [] });
    assert.match(JSON.stringify(changed.messages), /REVISIONLESS_EDIT/u);
    assert.equal(changed.metrics.validatedEditsReplaced, 0);
  }
});

test("multipart command results drop the echoed command and stay decodable", () => {
  const output = "line one\nline two\n";
  const messages: Message[] = [toolUse("command", "run_task", { command: "npm test" }), {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "command", name: "run_task",
      content: encodeToolResult({ status: "ok", data: { command: "npm test", exitCode: 0, output } }) as never }],
  }];
  const block = (projectProviderContext(messages, { systemPrompt: "", tools: [] }).messages[1]!.content as ContentBlock[])[0]!;
  assert.equal(block.type, "tool_result");
  if (block.type !== "tool_result") return;
  assert.deepEqual(unwrapFeedbackEnvelope(block.content), { status: "ok", data: { exitCode: 0, output } });
});

test("publishes content-free provider context measurements", async () => {
  const emitted: ContextProjectionMetrics[] = [];
  const extension = createContextProjectionExtension({
    emit: (metrics) => emitted.push(metrics),
    systemPrompt: "system",
    tools: [{ description: "Edit", name: "edit_code" }],
  });
  let build:
    | ((messages: Message[]) => Message[] | Promise<Message[]>)
    | undefined;
  await extension.setup?.(
    {
      registerMessageBuilder(builder: {
        build(messages: Message[]): Message[] | Promise<Message[]>;
      }) {
        build = builder.build;
      },
    } as never,
    {} as never,
  );
  await build?.(
    projectionMessages().map((message, index) => ({
      ...message,
      id: `message-${index}`,
    })) as Message[],
  );
  await build?.(projectionMessages());
  await build?.(projectionMessages());
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1]?.requestIndex, 2);
  assert.ok((emitted[1]?.composedBytes ?? 0) > 0);
  assert.doesNotMatch(JSON.stringify(emitted), /ORIGINAL_SOURCE|FIRST_PATCH/u);
});

test("executes native Cline compaction on a long context", async () => {
  const notices: Array<{
    message: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const prepare = nativeCompactionPrepareTurn();
  assert.ok(prepare);
  const messages = longMessages();
  const result = await prepare({
    abortSignal: new AbortController().signal,
    agentId: "agent",
    apiMessages: messages,
    conversationId: "conversation",
    emitStatusNotice: (message: string, metadata?: Record<string, unknown>) =>
      notices.push({ message, metadata }),
    iteration: messages.length,
    messages,
    model: {
      id: "fixture",
      info: { contextWindow: 3_000, maxInputTokens: 2_000 },
      provider: "anthropic",
    },
    parentAgentId: null,
    systemPrompt: "system",
    tools: [],
  });
  assert.ok(result);
  assert.ok(result.messages.length < messages.length);
  assert.ok(
    notices.some(
      ({ metadata }) =>
        metadata?.kind === "auto_compaction" && metadata.phase === "completed",
    ),
  );
});

function nativeCompactionPrepareTurn() {
  const providerConfig = createProviderConfig({
    apiKey: "fixture",
    model: "fixture",
    provider: "anthropic",
  });
  return createContextCompactionPrepareTurn({
    compaction: { enabled: true, strategy: "basic" },
    modelId: "fixture",
    providerConfig,
    providerId: "anthropic",
    sessionId: "long-context",
  });
}

function longMessages(): Message[] {
  return Array.from({ length: 30 }, (_, index) => ({
    content: `message ${index} ${"x".repeat(1_000)}`,
    role: index % 2 ? "assistant" : "user",
  }));
}

function projectionMessages(): Message[] {
  return [
    toolUse("read-1", "read_code", { target: "src/a.ts" }),
    toolResult("read-1", "read_code", {
      data: { content: "ORIGINAL_SOURCE".repeat(100), path: "src/a.ts" },
      receipt: "r1",
      status: "ok",
    }),
    toolUse("edit-1", "edit_code", {
      operations: [
        { kind: "patch", patch: "FIRST_PATCH".repeat(100), path: "src/a.ts" },
      ],
    }),
    successfulEditResult("edit-1", "c1", "src/a.ts", "src_1"),
    toolUse("read-2", "read_code", { target: "src/a.ts" }),
    toolResult("read-2", "read_code", {
      data: { content: "FRESH_SOURCE", path: "src/a.ts" },
      receipt: "r2",
      status: "ok",
    }),
    toolUse("edit-2", "edit_code", {
      operations: [{ kind: "patch", patch: "LATEST_PATCH", path: "src/b.ts" }],
    }),
    successfulEditResult("edit-2", "c2", "src/b.ts", "src_2"),
    toolUse("edit-3", "edit_code", {
      operations: [{ kind: "patch", patch: "FAILED_PATCH", path: "src/c.ts" }],
    }),
    toolResult("edit-3", "edit_code", { status: "blocked" }),
  ];
}

function successfulEditResult(
  id: string,
  receipt: string,
  path: string,
  sourceRevisionId: string,
) {
  return toolResult(id, "edit_code", {
    data: { changes: [{ path }], sourceRevisionId },
    receipt,
    status: "ok",
  });
}

function validationResult(
  id: string,
  paths: string[],
  sourceRevisionId: string,
) {
  return toolResult(id, "run_task", {
    data: {
      validation: {
        paths,
        sourceRevisionId,
        status: "passed",
        taskKind: "build",
      },
    },
    status: "ok",
  });
}

function editInput(path: string, content: string) {
  return { operations: [{ kind: "patch", patch: content, path }] };
}

function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): Message {
  return {
    content: [{ id, input, name, type: "tool_use" }],
    role: "assistant",
  };
}

test("overlapping reads retain unique source, metadata and the original transcript", () => {
  const shared = overlapSource("shared");
  const messages = overlapReads(["old unique\n" + shared, shared + "new unique\n"]);
  const original = structuredClone(messages);
  const projected = projectProviderContext(messages, { systemPrompt: "", tools: [] });
  const serialized = JSON.stringify(projected.messages);
  assert.match(serialized, /old unique/u);
  assert.match(serialized, /new unique/u);
  assert.match(serialized, /partially_superseded_by_later_read/u);
  assert.match(serialized, /alias-0/u);
  assert.equal(serialized.split("shared_0").length, 2);
  assert.ok(projected.metrics.projectedBytesSaved > 200);
  assert.deepEqual(messages, original);
  assert.deepEqual(projectProviderContext(projected.messages, { systemPrompt: "", tools: [] }).messages, projected.messages);
});

test("overlap projection keeps changed lines and follows coverage across three reads", () => {
  const first = overlapSource("first");
  const second = overlapSource("second");
  const messages = overlapReads([
    "old state\n" + first + "old middle\n" + second,
    first + "intermediate state\n" + second,
    second + "latest state\n",
  ]);
  const serialized = JSON.stringify(projectProviderContext(messages, { systemPrompt: "", tools: [] }).messages);
  for (const unique of ["old state", "old middle", "intermediate state", "latest state"])
    assert.ok(serialized.includes(unique));
  assert.equal(serialized.split("first_0").length, 2);
  assert.equal(serialized.split("second_0").length, 2);
});

test("overlap projection leaves ambiguous repetition and other paths intact", () => {
  const repeated = "    common_value = some_long_expression_with_no_unique_anchor();\n".repeat(10);
  const messages = overlapReads(["first\n" + repeated, repeated + "last\n"]);
  assert.deepEqual(projectProviderContext(messages, { systemPrompt: "", tools: [] }).messages, messages);
  const different = overlapReads(["first\n" + overlapSource("shared"), overlapSource("shared") + "last\n"], true);
  assert.deepEqual(projectProviderContext(different, { systemPrompt: "", tools: [] }).messages, different);
});

test("overlap projection preserves exact Unicode and CRLF source in segments", () => {
  const shared = overlapSource("élève_🐱").replaceAll("\n", "\r\n");
  const messages = [
    toolUse("segment", "read_code", { target: "src/a.ts" }),
    toolResult("segment", "read_code", { status: "ok", data: {
      path: "src/a.ts", complete: false, segments: [{ range: [1, 12], content: "antérieur 🦊\r\n" + shared }],
    } }),
    ...overlapReads([shared + "suivant 🐈\r\n"]),
  ];
  const projected = projectProviderContext(messages, { systemPrompt: "", tools: [] }).messages;
  const results = projected.flatMap((message) => Array.isArray(message.content)
    ? message.content.flatMap((block: ContentBlock) => block.type === "tool_result" && typeof block.content === "string" ? [JSON.parse(block.content)] : []) : []);
  assert.ok(results[0].data.segments[0].content.startsWith("antérieur 🦊\r\n"));
  assert.equal(results[1].data.content, shared + "suivant 🐈\r\n");
  const output = JSON.stringify(projected);
  assert.equal(output.split("élève_🐱_0").length, 2);
});

function overlapSource(prefix: string) {
  return Array.from({ length: 10 }, (_, index) => `const ${prefix}_${index} = "a sufficiently long distinct source line";\n`).join("");
}

function overlapReads(contents: string[], differentPaths = false): Message[] {
  return contents.flatMap((content, index) => {
    const path = differentPaths ? `src/${index}.ts` : "src/a.ts";
    return [
      toolUse(`overlap-${index}`, "read_code", { target: path, view: "range" }),
      toolResult(`overlap-${index}`, "read_code", {
        status: "ok", receipt: `receipt-${index}`,
        data: { content, path, complete: false, alias: `alias-${index}` },
      }),
    ];
  });
}

function toolResult(id: string, name: string, output: unknown): Message {
  return {
    content: [
      {
        content: JSON.stringify(output),
        name,
        tool_use_id: id,
        type: "tool_result",
      },
    ],
    role: "user",
  };
}

for (const status of ["ok", "blocked"]) {
  test(`command projection preserves every ${status} result value through its paired input`, () => {
    const command = "python - <<'PY'\nprint('élève 🐱')\nPY";
    const output = { status, data: { command, output: "complete diagnostic\n", exitCode: status === "ok" ? 0 : 1 } };
    const original = [toolUse("command", "run_task", { kind: "command", command }), toolResult("command", "run_task", output)];
    const snapshot = structuredClone(original);
    const projection = projectProviderContext(original, { systemPrompt: "", tools: [] });
    const result = parsedProjectedResult(projection.messages[1]!);
    assert.equal(result.data.command, undefined);
    assert.deepEqual({ ...result, data: { ...result.data, command } }, output);
    assert.deepEqual(original, snapshot);
    assert.deepEqual(projection.messages[0], original[0]);
    assert.ok(projection.metrics.projectedBytesSaved > 0);
    assert.deepEqual(projectProviderContext(projection.messages, { systemPrompt: "", tools: [] }).messages, projection.messages);
  });
}

test("command projection preserves transformed commands and non-command results", () => {
  for (const [name, input] of [
    ["run_task", { command: "npm test " }],
    ["run_task", { kind: "project", task: "test" }],
    ["read_code", { command: "npm test" }],
  ] as const) {
    const original = [
      toolUse("command", name, input),
      toolResult("command", name, { status: "ok", data: { command: "npm test", output: "passed" } }),
    ];
    assert.deepEqual(projectProviderContext(original, { systemPrompt: "", tools: [] }).messages, original);
  }
});

test("an unpaired command result remains self-contained", () => {
  const original = [toolResult("missing", "run_task", { status: "ok", data: { command: "npm test", output: "passed" } })];
  assert.deepEqual(projectProviderContext(original, { systemPrompt: "", tools: [] }).messages, original);
});

test("a reused call identifier cannot substitute a later command output", () => {
  const original = ["first output", "second output"].flatMap((output) => [
    toolUse("reused", "run_task", { command: "npm test" }),
    toolResult("reused", "run_task", { status: "ok", data: { command: "npm test", output } }),
  ]);
  const projection = projectProviderContext(original, { systemPrompt: "", tools: [] });
  assert.equal(parsedProjectedResult(projection.messages[1]!).data.output, "first output");
  assert.equal(parsedProjectedResult(projection.messages[3]!).data.output, "second output");
});

test("command projection never rewrites an errored transport result", () => {
  const original = [
    toolUse("command", "run_task", { command: "npm test" }),
    toolResult("command", "run_task", { status: "ok", data: { command: "npm test" } }),
  ];
  const content = original[1]!.content as ContentBlock[];
  assert.equal(content[0]!.type, "tool_result");
  if (content[0]!.type === "tool_result") content[0]!.is_error = true;
  assert.deepEqual(projectProviderContext(original, { systemPrompt: "", tools: [] }).messages, original);
});

test("command projection preserves mixed text and image result blocks", () => {
  const command = "render preview";
  const original = [
    toolUse("command", "run_task", { command }),
    toolResult("command", "run_task", { status: "ok", data: { command } }),
  ];
  const content = original[1]!.content as ContentBlock[];
  assert.equal(content[0]!.type, "tool_result");
  if (content[0]!.type === "tool_result") content[0]!.content = [
    { type: "text", text: JSON.stringify({ status: "ok", data: { command } }) },
    { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
  ];
  assert.deepEqual(projectProviderContext(original, { systemPrompt: "", tools: [] }).messages, original);
});

test("command projection preserves earlier projected prefixes as new calls arrive", () => {
  const original = [
    toolUse("first", "run_task", { command: "npm test" }),
    toolResult("first", "run_task", { status: "ok", data: { command: "npm test", output: "passed" } }),
  ];
  const first = projectProviderContext(original, { systemPrompt: "", tools: [] }).messages;
  const next = [...original, toolUse("second", "run_task", { command: "npm build" })];
  assert.deepEqual(projectProviderContext(next, { systemPrompt: "", tools: [] }).messages.slice(0, first.length), first);
});

function parsedProjectedResult(message: Message) {
  const content = message.content as ContentBlock[];
  assert.equal(content[0]!.type, "tool_result");
  if (content[0]!.type !== "tool_result") throw new Error("Missing projected result");
  assert.equal(typeof content[0]!.content, "string");
  return JSON.parse(content[0]!.content as string);
}

test("provider requests retain old reads while immediately exposing fresh overlapping source", async () => {
  const builder = await stableProjectionBuilder();
  const shared = overlapSource("stable");
  const history = overlapReads(["old unique\n" + shared, shared + "fresh unique\n"]);
  const snapshot = structuredClone(history);
  const first = await builder.build(history.slice(0, 2));
  const next = await builder.build(history);
  assert.deepEqual(next.slice(0, first.length), first);
  assert.match(JSON.stringify(next.at(-1)), /fresh unique/u);
  assert.match(JSON.stringify(next[1]), /old unique|stable_0/u);
  assert.equal(builder.metrics.at(-1)!.staleReadsReplaced, 0);
  assert.deepEqual(history, snapshot);
});

test("later validation cannot remove an edit already sent to the provider", async () => {
  const builder = await stableProjectionBuilder();
  const edit = [toolUse("edit", "edit_code", editInput("src/a.ts", "VALIDATED_PATCH".repeat(500))),
    successfulEditResult("edit", "r1", "src/a.ts", "source_1")];
  const first = await builder.build(edit);
  const history = [...edit, toolUse("check", "run_task", { kind: "project", task: "test" }),
    validationResult("check", ["src/a.ts"], "source_1")];
  assert.equal(projectProviderContext(history, { systemPrompt: "", tools: [] }).metrics.validatedEditsReplaced, 1);
  const next = await builder.build(history);
  assert.deepEqual(next.slice(0, first.length), first);
  assert.equal(builder.metrics.at(-1)!.validatedEditsReplaced, 0);
});

test("the new suffix still projects duplicates and exact command echoes", async () => {
  const builder = await stableProjectionBuilder();
  const initial: Message[] = [{ role: "user", content: "Inspect this project" }];
  const first = await builder.build(initial);
  const reads = overlapReads([overlapSource("duplicate"), overlapSource("duplicate")]);
  const command = [toolUse("command", "run_task", { command: "npm test" }),
    toolResult("command", "run_task", { status: "ok", data: { command: "npm test", output: "passed" } })];
  const next = await builder.build([...initial, ...reads, ...command]);
  assert.deepEqual(next.slice(0, first.length), first);
  assert.equal(builder.metrics.at(-1)!.staleReadsReplaced, 1);
  assert.equal(parsedProjectedResult(next.at(-1)!).data.command, undefined);
});

test("appending content to the final canonical message preserves its projected blocks", async () => {
  const builder = await stableProjectionBuilder();
  const call = toolUse("command", "run_task", { command: "npm test" });
  const result = toolResult("command", "run_task", { status: "ok", data: { command: "npm test", output: "passed" } });
  const first = await builder.build([call, result]);
  const extended: Message = { ...result, content: [...result.content as ContentBlock[], { type: "text", text: "A new user requirement" }] };
  const next = await builder.build([call, extended]);
  assert.deepEqual((next[1]!.content as ContentBlock[]).slice(0, 1), first[1]!.content);
  assert.match(JSON.stringify(next[1]), /A new user requirement/u);
  assert.equal(parsedProjectedResult(next[1]!).data.command, undefined);
});

test("a newly received edit result stays paired with a previously sent call", async () => {
  const builder = await stableProjectionBuilder();
  const call = toolUse("edit", "edit_code", editInput("src/a.ts", "ORIGINAL_PATCH"));
  const first = await builder.build([call]);
  const history = [call, successfulEditResult("edit", "r1", "src/a.ts", "s1"),
    toolUse("read", "read_code", { target: "src/a.ts" }),
    toolResult("read", "read_code", { status: "ok", data: { path: "src/a.ts", content: "CURRENT_SOURCE", complete: true } })];
  const next = await builder.build(history);
  assert.deepEqual(next[0], first[0]);
  assert.equal((next[1]!.content as ContentBlock[])[0]!.type, "tool_result");
  assert.equal(builder.metrics.at(-1)!.successfulEditsReplaced, 0);
});

test("canonical edits and resets rebase instead of resurrecting prior content", async () => {
  const builder = await stableProjectionBuilder();
  const original: Message[] = [{ role: "user", content: "OLD_REQUIREMENT" }];
  await builder.build(original);
  const edited: Message[] = [{ role: "user", content: "REVISED_REQUIREMENT" }];
  assert.deepEqual(await builder.build(edited), edited);
  assert.deepEqual(await builder.build([]), []);
  const fresh = overlapReads([overlapSource("fresh"), overlapSource("fresh")]);
  assert.deepEqual(await builder.build(fresh), presentToolResults(projectProviderContext(fresh, { systemPrompt: "", tools: [] }).messages));
});

test("provider result mutation cannot modify the retained projection", async () => {
  const builder = await stableProjectionBuilder();
  const history = overlapReads([overlapSource("immutable")]);
  const first = await builder.build(history);
  const snapshot = structuredClone(first);
  (first[0]!.content as ContentBlock[]).splice(0);
  assert.deepEqual(await builder.build(history), snapshot);
});

test("preflight previews reflect the retained provider context without committing state", async () => {
  const builder = await stableProjectionBuilder();
  const history = overlapReads([overlapSource("same"), overlapSource("same")]);
  const first = await builder.build(history.slice(0, 2));
  const preview = await builder.build(withPreviewMetadata(history));
  assert.equal(builder.metrics.length, 1);
  assert.deepEqual(preview.slice(0, first.length), first);
  assert.deepEqual(await builder.build(history), preview);
  const abandoned = withPreviewMetadata([{ role: "user", content: "Abandoned reset preview" }]);
  await builder.build(abandoned);
  assert.deepEqual(await builder.build(history), preview);
  assert.equal(builder.metrics.at(-1)!.requestIndex, 3);
});

test("preflight groups split tool results like the SDK provider view", async () => {
  const builder = await stableProjectionBuilder();
  const calls: Message = { role: "assistant", content: [
    ...(toolUse("a", "run_task", { command: "a" }).content as ContentBlock[]),
    ...(toolUse("b", "run_task", { command: "b" }).content as ContentBlock[]),
  ] };
  const results = ["a", "b"].map((id) => toolResult(id, "run_task", { status: "ok", data: { command: id, output: id } }));
  const grouped: Message = { role: "user", content: results.flatMap((message) => message.content as ContentBlock[]) };
  await builder.build([calls, grouped]);
  const preview = await builder.build(withPreviewMetadata([calls, ...results]));
  assert.equal(preview.length, 2);
  assert.deepEqual(preview, await builder.build([calls, grouped]));
  assert.equal(builder.metrics.length, 2);
});

test("preflight empty user groups follow the SDK merge behavior", async () => {
  const builder = await stableProjectionBuilder();
  const call = toolUse("command", "run_task", { command: "npm test" });
  const result = toolResult("command", "run_task", { status: "ok", data: { command: "npm test" } });
  const provider = await builder.build([call, result]);
  const preview = withPreviewMetadata([call, { role: "user", content: [] }, result]);
  assert.deepEqual(await builder.build(preview), provider);
});

test("multimedia read results survive rebases and later fresh reads", async () => {
  const builder = await stableProjectionBuilder();
  const history = overlapReads([overlapSource("image"), overlapSource("image")]);
  const first = (history[1]!.content as ContentBlock[])[0]!;
  assert.equal(first.type, "tool_result");
  if (first.type === "tool_result") first.content = [
    { type: "text", text: first.content as string },
    { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
  ];
  assert.deepEqual((await builder.build(history))[1], history[1]);
  assert.deepEqual((await builder.build(history.slice(0, 2)))[1], history[1]);
  assert.deepEqual((await builder.build(history))[1], history[1]);
});

test("native compaction sees the retained context budget and starts a new projection", async () => {
  const builder = await stableProjectionBuilder();
  const prepare = nativeCompactionPrepareTurn();
  assert.ok(prepare);
  const history: Message[] = [];
  let compacted: Message[] | undefined;
  for (let turn = 0; turn < 30 && !compacted; turn += 1) {
    history.push({ role: "user", content: `Inspect the next project change ${turn}.` },
      toolUse(`read-${turn}`, "read_code", { target: "src/budget.ts" }),
      toolResult(`read-${turn}`, "read_code", { status: "ok", data: { path: "src/budget.ts", content: overlapSource("budget"), complete: true } }));
    const provider = await builder.build(history);
    const preview = await builder.build(withPreviewMetadata(history));
    assert.deepEqual(preview, provider);
    const result = await prepare(compactionInput(history, preview, turn));
    if (result) compacted = result.messages.map(({ role, content }: Message) => ({ role, content }));
  }
  assert.ok(compacted, "The stable context must trigger native compaction instead of hiding its growth");
  assert.ok(builder.metrics.at(-1)!.messageBytes > projectProviderContext(history, { systemPrompt: "", tools: [] }).metrics.messageBytes);
  assert.ok(compacted.length < history.length);
  const rebased = await builder.build(compacted);
  assert.deepEqual(rebased, presentToolResults(projectProviderContext(compacted, { systemPrompt: "", tools: [] }).messages));
  assert.equal(builder.metrics.at(-1)!.messageBytes, Buffer.byteLength(JSON.stringify(rebased)));
});

function compactionInput(messages: Message[], apiMessages: Message[], iteration: number) {
  return {
    abortSignal: new AbortController().signal, agentId: "agent", conversationId: "conversation",
    iteration, messages, apiMessages, parentAgentId: null, systemPrompt: "", tools: [],
    model: { id: "fixture", info: { contextWindow: 3_000, maxInputTokens: 2_000 }, provider: "anthropic" },
  };
}

function withPreviewMetadata(messages: Message[]): Message[] {
  return messages.map((message, index) => ({ ...message, id: `preview-${index}`, ts: 1 }));
}

async function stableProjectionBuilder() {
  const metrics: ContextProjectionMetrics[] = [];
  let build: (messages: Message[]) => Message[] | Promise<Message[]> = () => [];
  const extension = createContextProjectionExtension({ emit: (value) => metrics.push(value), systemPrompt: "", tools: [] });
  await extension.setup?.({ registerMessageBuilder(builder: { build: typeof build }) { build = builder.build; } } as never, {} as never);
  return { build: async (messages: Message[]) => await build(messages), metrics };
}

test("image projection preserves cache prefixes and matches compaction preflight", async () => {
  const builder = await stableProjectionBuilder();
  const image = { type: "image" as const, mediaType: "image/png", data: "aW1hZ2U=" };
  const first: Message[] = [{ role: "user", content: [image] }];
  const initial = await builder.build(first);
  const history: Message[] = [...first, { role: "user", content: [image] }];
  const canonical = JSON.stringify(history);
  const preview = await builder.build(withPreviewMetadata(history));
  const ready = await builder.build(history);
  assert.deepEqual(ready, preview);
  assert.deepEqual(ready.slice(0, initial.length), initial);
  assert.equal(JSON.stringify(ready).split('"type":"image"').length - 1, 1);
  assert.equal(JSON.stringify(history), canonical);
  const rebased = await builder.build([{ role: "user", content: "Compacted context" }, history[1]!]);
  assert.equal(JSON.stringify(rebased).split('"type":"image"').length - 1, 1);
});
