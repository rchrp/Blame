import { firstLine, list, num, record, str } from "./tool-call-values.ts"
import type {
  ScreenshotRef,
  ToolCallBody,
  ToolCallChip,
  ToolCallSource,
  ToolCallView,
} from "./tool-call-view.ts"

// The agent's browser tools (preview_devtools__*), read as sentences:
// "Captured /settings/providers 1440×900 dark", "Clicked element 1_23".

export const previewDevtoolsPrefix = "preview_devtools__"
const screenshotIdPattern = /^[0-9a-f]{64}$/u

type Describe = (
  input: Record<string, unknown>,
  source: ToolCallSource
) => Pick<ToolCallView, "verb" | "target" | "chips">

const describers: Record<string, Describe> = {
  take_snapshot: (_input, source) => ({
    verb: source.running ? "Reading" : "Read",
    target: { text: "the page structure" },
    chips: [],
  }),
  click: (input, source) => ({
    verb:
      input.dblClick === true
        ? source.running
          ? "Double-clicking"
          : "Double-clicked"
        : source.running
          ? "Clicking"
          : "Clicked",
    target: element(input.uid),
    chips: [],
  }),
  fill: (input, source) => ({
    verb: source.running ? "Filling" : "Filled",
    target: element(input.uid),
    chips: str(input.value)
      ? [
          {
            label: `“${firstLine(String(input.value), 32)}”`,
            title: String(input.value),
          },
        ]
      : [],
  }),
  navigate_page: (input, source) => navigation(input, source.running),
  emulate: (input, source) => ({
    verb: source.running ? "Emulating" : "Emulated",
    target: { text: emulation(input) },
    chips: [],
  }),
  resize_page: (input, source) => ({
    verb: source.running ? "Resizing the page to" : "Resized the page to",
    target: size(input.width, input.height),
    chips: [],
  }),
  list_console_messages: (_input, source) => ({
    verb: source.running ? "Reading" : "Read",
    target: { text: "console messages" },
    chips: consoleChips(outputText(source.output)),
  }),
}

export function isPreviewDevtoolsTool(toolName: string | undefined) {
  return Boolean(toolName?.startsWith(previewDevtoolsPrefix))
}

export function describePreviewDevtools(source: ToolCallSource): ToolCallView {
  const name = (source.toolName ?? "").slice(previewDevtoolsPrefix.length)
  const input = record(source.input)
  const failed = !source.running && failedResult(source.output)
  if (name === "take_screenshot")
    return describeScreenshot(source, input, failed)
  const describe = describers[name]
  const sentence = describe
    ? describe(input, source)
    : {
        verb: humanize(name),
        target: str(input.uid) ? element(input.uid) : undefined,
        chips: [],
      }
  const text = outputText(source.output)
  return {
    family: "preview",
    ...sentence,
    bodies: failed
      ? [{ type: "error", message: text || "The browser tool failed." }]
      : text
        ? [
            {
              type: "text",
              text: text.length > 6_000 ? `${text.slice(0, 6_000)}…` : text,
              truncated: text.length > 6_000,
            },
          ]
        : [],
    failed,
  }
}

function describeScreenshot(
  source: ToolCallSource,
  input: Record<string, unknown>,
  failed: boolean
): ToolCallView {
  const screenshots = screenshotRefs(source.output)
  const first = screenshots[0]
  const chips: ToolCallChip[] = []
  if (first) {
    chips.push({
      label: `${first.viewport.width}×${first.viewport.height}`,
      mono: true,
    })
    if (first.colorScheme === "dark") chips.push({ label: "dark" })
  }
  if (input.fullPage === true) chips.push({ label: "full page" })
  const bodies: ToolCallBody[] = failed
    ? [
        {
          type: "error",
          message: outputText(source.output) || "The screenshot failed.",
        },
      ]
    : source.running
      ? [{ type: "screenshot", screenshots: [], pending: true }]
      : screenshots.length
        ? [{ type: "screenshot", screenshots }]
        : []
  return {
    family: "preview",
    verb: source.running ? "Capturing" : "Captured",
    target: first?.pageUrl
      ? { text: pagePath(first.pageUrl), mono: true, title: first.pageUrl }
      : { text: str(input.uid) ? `element ${input.uid}` : "the preview" },
    chips,
    bodies,
    failed,
  }
}

// A component opened alone on a temporary page, with its screenshot.
export function describeComponentPreview(source: ToolCallSource): ToolCallView {
  const input = record(source.input)
  const failed = !source.running && failedResult(source.output)
  const shot = describeScreenshot(source, input, failed)
  const path = str(input.path)
  const report = outputText(source.output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(Error overlay|Console errors|msgid=)/u.test(line))
    .join("\n")
  const problems = /Error overlay: (?!none)|^msgid=/mu.test(report)
  return {
    ...shot,
    verb: source.running ? "Previewing" : "Previewed",
    target: path ? { text: path, mono: true, title: path } : shot.target,
    chips: [
      ...shot.chips.filter((chip) => chip.label !== "full page"),
      ...(problems && !failed
        ? [{ label: "Errors", tone: "danger" as const }]
        : []),
    ],
    bodies: failed
      ? shot.bodies
      : [
          ...shot.bodies,
          ...(report ? [{ type: "text" as const, text: report }] : []),
        ],
  }
}

export function screenshotRefs(
  value: unknown,
  refs: ScreenshotRef[] = []
): ScreenshotRef[] {
  if (Array.isArray(value)) value.forEach((item) => screenshotRefs(item, refs))
  else if (value && typeof value === "object") {
    const ref = screenshotRef(value)
    if (ref) {
      if (!refs.some((item) => item.id === ref.id)) refs.push(ref)
    } else Object.values(value).forEach((item) => screenshotRefs(item, refs))
  }
  return refs
}

function screenshotRef(value: object): ScreenshotRef | undefined {
  const item = value as Record<string, unknown>
  if (
    item.type !== "screenshot_ref" ||
    typeof item.id !== "string" ||
    !screenshotIdPattern.test(item.id)
  )
    return undefined
  const width = num(item.width) ?? 0
  const height = num(item.height) ?? 0
  const viewport = record(item.viewport)
  return {
    colorScheme: item.colorScheme === "dark" ? "dark" : "light",
    height,
    id: item.id,
    mimeType: str(item.mimeType) ?? "image/png",
    pageUrl: str(item.pageUrl) ?? "",
    ...(str(item.sessionId) ? { sessionId: String(item.sessionId) } : {}),
    viewport: {
      height: num(viewport.height) ?? height,
      width: num(viewport.width) ?? width,
    },
    width,
  }
}

export function pagePath(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}` || "/"
  } catch {
    return url
  }
}

function navigation(input: Record<string, unknown>, running: boolean) {
  const type = str(input.type) ?? "url"
  if (type === "back")
    return {
      verb: running ? "Going back" : "Went back",
      target: undefined,
      chips: [],
    }
  if (type === "forward")
    return {
      verb: running ? "Going forward" : "Went forward",
      target: undefined,
      chips: [],
    }
  if (type === "reload")
    return {
      verb: running ? "Reloading" : "Reloaded",
      target: { text: "the page" },
      chips: [],
    }
  const url = str(input.url)
  return {
    verb: running ? "Opening" : "Opened",
    target: url
      ? { text: pagePath(url), mono: true, title: url }
      : { text: "a page" },
    chips: [],
  }
}

function emulation(input: Record<string, unknown>) {
  const parts: string[] = []
  const scheme = str(input.colorScheme)
  if (scheme === "dark" || scheme === "light") parts.push(`${scheme} mode`)
  else if (scheme === "auto") parts.push("the default color scheme")
  const viewport = str(input.viewport)?.match(/^(\d+)x(\d+)/u)
  if (viewport)
    parts.push(
      `a ${viewport[1]}×${viewport[2]}${/mobile/u.test(String(input.viewport)) ? " mobile" : ""} viewport`
    )
  const network = str(input.networkConditions)
  if (network) parts.push(network === "Offline" ? "offline" : network)
  const cpu = num(input.cpuThrottlingRate)
  if (cpu && cpu > 1) parts.push(`a ${cpu}× slower CPU`)
  if (str(input.geolocation)) parts.push("a location")
  if (typeof input.userAgent === "string")
    parts.push(input.userAgent ? "a user agent" : "the default user agent")
  return parts.length ? parts.join(", ") : "the browser defaults"
}

function element(uid: unknown) {
  return str(uid)
    ? { text: `element ${uid}`, mono: true }
    : { text: "an element" }
}

function size(width: unknown, height: unknown) {
  const w = num(width)
  const h = num(height)
  return w && h ? { text: `${w}×${h}`, mono: true } : { text: "a new size" }
}

function consoleChips(text: string): ToolCallChip[] {
  const messages = text
    .split("\n")
    .filter((line) => /^msgid=/u.test(line.trim()))
  const errors = messages.filter((line) => /\[error\]/iu.test(line)).length
  if (!messages.length) return text ? [] : [{ label: "No messages" }]
  return errors
    ? [
        {
          label: `${errors} ${errors === 1 ? "error" : "errors"}`,
          tone: "danger",
        },
      ]
    : [
        {
          label: `${messages.length} ${messages.length === 1 ? "message" : "messages"}`,
        },
      ]
}

// The text blocks of an MCP result, whether stored as an object or a list.
function outputText(output: unknown) {
  const blocks = Array.isArray(output) ? output : list(record(output).content)
  return blocks
    .map((block) => {
      const item = record(block)
      return item.type === "text" ? (str(item.text) ?? "") : ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()
}

function failedResult(output: unknown) {
  return record(output).isError === true
}

function humanize(name: string) {
  const text = name.replaceAll("_", " ").trim()
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "Used the browser"
}
