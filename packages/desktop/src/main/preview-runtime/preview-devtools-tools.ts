import {
  applyEmulation,
  emulationInput,
} from "./preview-devtools-emulation.ts";

// The agent's browser tools (preview_devtools__*): a small set, each one an
// agent-browser command or two. Elements are named by the refs a snapshot
// returns (@e3) or by CSS selectors. Output stays short: page text and
// trees as agent-browser prints them, lists one line per entry, request
// headers that carry credentials redacted.

export type PreviewDevtoolsTool = {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
};

export type PreviewToolResult = {
  content: Array<
    | { text: string; type: "text" }
    | { data: string; mimeType: string; type: "image" }
  >;
  isError?: boolean;
};

export type PreviewToolContext = {
  // Runs one agent-browser command and returns its JSON data.
  cli(args: string[]): Promise<Record<string, unknown>>;
  // An absolute URL on the story's preview, or an error saying why not.
  previewUrl(value: string): string;
  // Reads a screenshot agent-browser wrote, then deletes it.
  screenshot(): { path: string; read(): Promise<Buffer> };
  // Host paths agent-browser may upload, from workspace or artifact paths.
  uploadPaths(values: unknown[]): Promise<string[]>;
  viewport: { height: number; width: number };
};

const target = {
  description: "A ref from take_snapshot, such as @e3, or a CSS selector.",
  type: "string",
};

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): PreviewDevtoolsTool {
  return {
    description,
    inputSchema: {
      additionalProperties: false,
      properties,
      ...(required.length ? { required } : {}),
      type: "object",
    },
    name,
  };
}

export const previewDevtoolsTools: readonly PreviewDevtoolsTool[] = [
  tool(
    "take_snapshot",
    "Read the page. interactive (default) lists interactive elements and headings, each with a ref such as @e3 for the other tools; full adds every text node; text returns the visible text as Markdown, without refs. selector limits it to one element.",
    {
      mode: { enum: ["interactive", "full", "text"], type: "string" },
      selector: { description: "A CSS selector.", type: "string" },
    },
  ),
  tool(
    "take_screenshot",
    "Capture the page as it looks now, or one element. The result names the screenshot so the final answer can show it.",
    { fullPage: { type: "boolean" }, target },
  ),
  tool("click", "Click an element.", { double: { type: "boolean" }, target }, [
    "target",
  ]),
  tool(
    "fill",
    "Clear a text field and type a value into it.",
    { target, value: { type: "string" } },
    ["target", "value"],
  ),
  tool(
    "type_text",
    "Type text with real key events, into target or else the focused element.",
    { target, text: { type: "string" } },
    ["text"],
  ),
  tool(
    "press_key",
    "Press a key or a combination, such as Enter, Tab, ArrowDown or Control+a.",
    { key: { type: "string" } },
    ["key"],
  ),
  tool("hover", "Move the pointer over an element.", { target }, ["target"]),
  tool(
    "select_option",
    "Choose options of a select element, by value or visible label.",
    { target, values: { items: { type: "string" }, type: "array" } },
    ["target", "values"],
  ),
  tool("drag", "Drag one element onto another.", { from: target, to: target }, [
    "from",
    "to",
  ]),
  tool("scroll", "Scroll the page, or bring target into view.", {
    direction: { enum: ["down", "left", "right", "up"], type: "string" },
    pixels: { type: "number" },
    target,
  }),
  tool(
    "upload_file",
    "Set the files of a file input. Paths are in the workspace.",
    { filePaths: { items: { type: "string" }, type: "array" }, target },
    ["target", "filePaths"],
  ),
  tool(
    "wait_for",
    "Wait until text appears on the page or an element exists. timeout in ms, 5000 by default.",
    { target, text: { type: "string" }, timeout: { type: "number" } },
  ),
  tool(
    "navigate_page",
    "Open a page of this preview (a path such as /settings works) and wait for it to load, or go back, forward or reload.",
    {
      timeout: { type: "number" },
      type: { enum: ["back", "forward", "reload", "url"], type: "string" },
      url: { type: "string" },
    },
  ),
  tool(
    "emulate",
    "Change how the page is shown. Settings stay until changed. viewport null returns to the default size; device names a phone or tablet, such as iPhone 16 or Pixel 9.",
    {
      colorScheme: { enum: ["auto", "dark", "light"], type: "string" },
      device: { type: "string" },
      geolocation: {
        properties: {
          latitude: { type: "number" },
          longitude: { type: "number" },
        },
        required: ["latitude", "longitude"],
        type: "object",
      },
      offline: { type: "boolean" },
      viewport: {
        properties: { height: { type: "number" }, width: { type: "number" } },
        required: ["width", "height"],
        type: ["object", "null"],
      },
    },
  ),
  tool(
    "list_console_messages",
    "Console messages and uncaught page errors since the last navigate_page call. clear empties both lists afterwards.",
    { clear: { type: "boolean" } },
  ),
  tool(
    "list_network_requests",
    "Requests made since the page last loaded, one per line with its id. filter keeps URLs containing it.",
    { filter: { type: "string" } },
  ),
  tool(
    "get_network_request",
    "One request in full: headers, request body and response.",
    { id: { type: "string" } },
    ["id"],
  ),
  tool(
    "evaluate_script",
    "Evaluate a JavaScript expression in the page and return its JSON value. A promise is awaited.",
    { expression: { type: "string" } },
    ["expression"],
  ),
  tool(
    "handle_dialog",
    "Accept or dismiss the page's open confirm dialog.",
    { action: { enum: ["accept", "dismiss"], type: "string" } },
    ["action"],
  ),
];

const toolNames = new Set(previewDevtoolsTools.map(({ name }) => name));
const maximumListedEntries = 100;
const maximumTextLength = 20_000;
const credentialHeader =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/iu;

export function previewDevtoolsToolExists(name: string) {
  return toolNames.has(name);
}

export async function runPreviewDevtoolsTool(
  name: string,
  input: Record<string, unknown>,
  context: PreviewToolContext,
): Promise<PreviewToolResult> {
  const cli = context.cli;
  switch (name) {
    case "take_snapshot":
      return text(await snapshot(input, cli));
    case "take_screenshot":
      return screenshot(input, context);
    case "click":
      await cli([
        input.double === true ? "dblclick" : "click",
        required(input, "target"),
      ]);
      return text(`Clicked ${input.target}.`);
    case "fill":
      await cli([
        "fill",
        required(input, "target"),
        required(input, "value", true),
      ]);
      return text(`Filled ${input.target}.`);
    case "type_text":
      await cli(
        typeof input.target === "string" && input.target
          ? ["type", input.target, required(input, "text", true)]
          : ["keyboard", "type", required(input, "text", true)],
      );
      return text("Typed the text.");
    case "press_key":
      await cli(["press", required(input, "key")]);
      return text(`Pressed ${input.key}.`);
    case "hover":
      await cli(["hover", required(input, "target")]);
      return text(`Hovering ${input.target}.`);
    case "select_option":
      await cli([
        "select",
        required(input, "target"),
        ...strings(input.values, "values"),
      ]);
      return text(`Selected ${strings(input.values, "values").join(", ")}.`);
    case "drag":
      await cli(["drag", required(input, "from"), required(input, "to")]);
      return text(`Dragged ${input.from} onto ${input.to}.`);
    case "scroll":
      if (typeof input.target === "string" && input.target) {
        await cli(["scrollintoview", input.target]);
        return text(`Scrolled ${input.target} into view.`);
      }
      await cli([
        "scroll",
        oneOf(input.direction, ["down", "left", "right", "up"], "down"),
        ...(positive(input.pixels)
          ? [String(Math.round(Number(input.pixels)))]
          : []),
      ]);
      return text("Scrolled.");
    case "upload_file": {
      const files = await context.uploadPaths(
        Array.isArray(input.filePaths) ? input.filePaths : [],
      );
      if (!files.length) throw new Error("upload_file needs filePaths.");
      await cli(["upload", required(input, "target"), ...files]);
      return text(`Set ${files.length} file(s) on ${input.target}.`);
    }
    case "wait_for":
      return waitFor(input, cli);
    case "navigate_page":
      return navigate(input, context);
    case "emulate":
      return text(await applyEmulation(emulationInput(input), context));
    case "list_console_messages":
      return text(await consoleMessages(input.clear === true, cli));
    case "list_network_requests":
      return text(await networkRequests(input, context));
    case "get_network_request":
      return text(
        requestDetail(await cli(["network", "request", required(input, "id")])),
      );
    case "evaluate_script": {
      const data = await cli(["eval", required(input, "expression")]);
      return text(
        clip(JSON.stringify(data.result ?? null, null, 2) ?? "undefined"),
      );
    }
    case "handle_dialog":
      await cli([
        "dialog",
        oneOf(input.action, ["accept", "dismiss"], "accept"),
      ]);
      return text(
        `Dialog ${input.action === "dismiss" ? "dismissed" : "accepted"}.`,
      );
    default:
      throw new Error(`Preview DevTools tool is unavailable: ${name}`);
  }
}

async function snapshot(
  input: Record<string, unknown>,
  cli: PreviewToolContext["cli"],
) {
  const mode = oneOf(
    input.mode,
    ["full", "interactive", "text"],
    "interactive",
  );
  const selector =
    typeof input.selector === "string" && input.selector.trim()
      ? input.selector.trim()
      : undefined;
  if (mode === "text") {
    const data = selector
      ? await cli(["get", "text", selector])
      : await cli(["read"]);
    return String(data.text ?? data.content ?? "");
  }
  const data = await cli([
    "snapshot",
    mode === "interactive" ? "-i" : "-c",
    ...(selector ? ["-s", selector] : []),
  ]);
  const tree = String(data.snapshot ?? "");
  return `${data.origin ? `Page: ${data.origin}\n` : ""}${tree || "(no elements)"}`;
}

async function screenshot(
  input: Record<string, unknown>,
  context: PreviewToolContext,
): Promise<PreviewToolResult> {
  const file = context.screenshot();
  await context.cli([
    "screenshot",
    ...(typeof input.target === "string" && input.target ? [input.target] : []),
    ...(input.fullPage === true ? ["--full"] : []),
    file.path,
  ]);
  const data = await file.read();
  return {
    content: [
      { text: "Screenshot taken.", type: "text" },
      { data: data.toString("base64"), mimeType: "image/png", type: "image" },
    ],
  };
}

async function waitFor(
  input: Record<string, unknown>,
  cli: PreviewToolContext["cli"],
) {
  const timeout = positive(input.timeout)
    ? Math.round(Number(input.timeout))
    : 5_000;
  const textValue = typeof input.text === "string" ? input.text : "";
  const element = typeof input.target === "string" ? input.target : "";
  if (!textValue && !element) throw new Error("wait_for needs text or target.");
  await cli([
    "wait",
    ...(textValue ? ["--text", textValue] : [element]),
    "--timeout",
    String(timeout),
  ]);
  return text(textValue ? `Found “${textValue}”.` : `Found ${element}.`);
}

async function navigate(
  input: Record<string, unknown>,
  context: PreviewToolContext,
) {
  const type = oneOf(input.type, ["back", "forward", "reload", "url"], "url");
  const url = type === "url" ? context.previewUrl(required(input, "url")) : "";
  // What the console showed belongs to the page being left.
  await context.cli(["console", "--clear"]);
  await context.cli(["errors", "--clear"]);
  if (type !== "url") {
    const data = await context.cli([type]);
    return text(`Now on ${String(data.url ?? "the page")}.`);
  }
  const data = await context.cli(["open", url]);
  return text(
    `Opened ${String(data.url ?? url)}${data.title ? ` (${data.title})` : ""}.`,
  );
}

async function consoleMessages(clear: boolean, cli: PreviewToolContext["cli"]) {
  const flags = clear ? ["--clear"] : [];
  const messages = await cli(["console", ...flags]);
  const errors = await cli(["errors", ...flags]);
  const lines = [
    ...records(messages.messages).map(
      (entry) => `[${String(entry.type ?? "log")}] ${String(entry.text ?? "")}`,
    ),
    ...records(errors.errors).map(
      (entry) =>
        `[page error] ${String(entry.text ?? "")}${entry.url ? ` (${entry.url}:${entry.line ?? 0})` : ""}`,
    ),
  ];
  return lines.length
    ? listed(lines, "messages")
    : "No console messages or page errors.";
}

async function networkRequests(
  input: Record<string, unknown>,
  context: PreviewToolContext,
) {
  const cli = context.cli;
  const filter =
    typeof input.filter === "string" && input.filter ? input.filter : "";
  const data = await cli([
    "network",
    "requests",
    ...(filter ? ["--filter", filter] : []),
  ]);
  // data: URLs never reach the network.
  const requests = records(data.requests).filter(
    (entry) => !String(entry.url ?? "").startsWith("data:"),
  );
  // agent-browser keeps every page's requests: list the current page's.
  const loaded = requests.findLastIndex(
    (entry) => entry.resourceType === "Document",
  );
  const current = loaded > 0 && !filter ? requests.slice(loaded) : requests;
  // Requests to the preview's own origin read as paths.
  const origin = originOf(context.previewUrl("/"));
  const lines = current.map((entry) =>
    [
      `[${String(entry.requestId ?? "")}]`,
      String(entry.method ?? "GET"),
      shortUrl(
        String(entry.url ?? ""),
        entry.resourceType === "Document" ? undefined : origin,
      ),
      entry.status === undefined ? "(pending)" : String(entry.status),
      entry.resourceType ? `(${entry.resourceType})` : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
  const earlier = requests.length - current.length;
  return [
    ...(earlier
      ? [
          `${earlier} ${earlier === 1 ? "request" : "requests"} of earlier pages not shown.`,
        ]
      : []),
    lines.length ? listed(lines, "requests") : "No requests captured.",
  ].join("\n");
}

export function requestDetail(data: Record<string, unknown>) {
  const value = { ...data };
  delete value.lifecycle;
  for (const key of ["headers", "requestHeaders", "responseHeaders"])
    if (value[key] && typeof value[key] === "object")
      value[key] = redactedHeaders(value[key] as Record<string, unknown>);
  return clip(JSON.stringify(value, null, 2));
}

function redactedHeaders(headers: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, header]) => [
      name,
      credentialHeader.test(name) ? "<redacted>" : header,
    ]),
  );
}

function listed(lines: string[], noun: string) {
  const shown = lines.slice(-maximumListedEntries);
  return [
    ...(lines.length > shown.length
      ? [`${lines.length - shown.length} earlier ${noun} not shown.`]
      : []),
    ...shown.map((line) => clip(line, 600)),
  ].join("\n");
}

function originOf(value: unknown) {
  try {
    return typeof value === "string" ? new URL(value).origin : undefined;
  } catch {
    return undefined;
  }
}

function shortUrl(url: string, origin: string | undefined) {
  return origin && url.startsWith(`${origin}/`)
    ? url.slice(origin.length)
    : url;
}

function records(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object",
      )
    : [];
}

function strings(value: unknown, name: string) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every((entry) => typeof entry === "string")
  )
    throw new Error(`${name} must be a list of strings.`);
  return value as string[];
}

function required(
  input: Record<string, unknown>,
  name: string,
  allowEmpty = false,
) {
  const value = input[name];
  if (typeof value !== "string" || (!allowEmpty && !value.trim()))
    throw new Error(`${name} is required.`);
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
) {
  return values.includes(value as T) ? (value as T) : fallback;
}

function positive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function clip(value: string, limit = maximumTextLength) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function text(value: string): PreviewToolResult {
  return { content: [{ text: value, type: "text" }] };
}
