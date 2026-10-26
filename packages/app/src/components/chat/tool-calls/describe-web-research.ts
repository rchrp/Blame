import {
  researchOutput,
  sourceFrom,
} from "../web-research/web-research-data.ts"
import type { ToolCallSource, ToolCallView } from "./tool-call-view.ts"
import { record, str } from "./tool-call-values.ts"

export function describeWebResearch(source: ToolCallSource): ToolCallView {
  const input = record(source.input)
  const result = researchOutput(source.output)
  const searching = source.toolName === "search_web"
  const sources = (
    searching
      ? Array.isArray(result?.sources)
        ? result.sources
        : []
      : [result?.source]
  ).flatMap((value) => {
    const source = sourceFrom(value)
    return source ? [source] : []
  })
  const error =
    str(result?.error) ??
    str(record(source.output).error) ??
    str(record(record(source.output).error).message)
  const failed = result?.status === "failed" || (!result && Boolean(error))
  const count =
    typeof result?.resultCount === "number"
      ? result.resultCount
      : sources.length
  return {
    family: "web",
    verb: searching
      ? source.running
        ? "Searching"
        : failed
          ? "Search failed"
          : result
            ? "Searched"
            : "Search"
      : source.running
        ? "Reading"
        : failed
          ? "Could not read"
          : result?.status === "partial"
            ? "Partially read"
            : result
              ? "Read"
              : "Web page",
    target: {
      text: searching
        ? (str(input.query) ?? "the web")
        : (sources[0]?.domain ?? str(input.url) ?? "web page"),
      title: searching ? str(input.query) : str(input.url),
    },
    webSources: sources,
    chips: [
      ...(!source.running && !result && !error
        ? [{ label: "Details unavailable" }]
        : []),
      ...(searching && result
        ? [{ label: `${count} ${count === 1 ? "result" : "results"}` }]
        : []),
      ...(result?.partial
        ? [{ label: "Partial results", tone: "warning" as const }]
        : []),
      ...(!searching && result?.method
        ? [
            {
              label:
                result.method === "electron"
                  ? "Browser"
                  : result.method === "text"
                    ? "Text"
                    : "Readability",
            },
          ]
        : []),
    ],
    failed,
    bodies: [
      ...(searching && str(input.query)
        ? [
            {
              type: "text" as const,
              label: "Search query",
              text: String(input.query),
            },
          ]
        : []),
      ...(sources.length
        ? [
            {
              type: "web-sources" as const,
              sources,
              reading:
                !searching &&
                result?.status !== "failed" &&
                Boolean(result?.content),
            },
          ]
        : []),
      ...(searching && result && count === 0
        ? [
            {
              type: "text" as const,
              text: "No sources returned. Try more specific or different keywords.",
            },
          ]
        : []),
      ...(result?.partial
        ? [
            {
              type: "text" as const,
              label: "Search availability",
              text: `Some engines did not respond${Array.isArray(result.unavailableEngines) ? `: ${result.unavailableEngines.join(", ")}` : "."}. These results may be incomplete.`,
            },
          ]
        : []),
      ...(error ? [{ type: "error" as const, message: error }] : []),
      ...(!searching && typeof result?.content === "string" && result.content
        ? [
            {
              type: "text" as const,
              label: "Extracted page text",
              text: result.content,
              truncated: result.truncated === true,
            },
          ]
        : []),
    ],
  }
}
