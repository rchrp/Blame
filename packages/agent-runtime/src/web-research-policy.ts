/** Provider-native search must not bypass Blame's persisted research tools. */
export function withoutNativeWebSearch(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.tools)) return value;
  return {
    ...payload,
    tools: payload.tools.flatMap((item) => {
      if (!item || typeof item !== "object") return [item];
      const tool = item as Record<string, unknown>;
      const name =
        tool.name ?? (tool.function as { name?: unknown } | undefined)?.name;
      if (
        name === "web_search" ||
        (typeof tool.type === "string" && /^web_search(?:_|$)/.test(tool.type))
      )
        return [];
      // Gemini/Vertex may put several tool capabilities in the same object.
      const {
        googleSearch,
        google_search,
        googleSearchRetrieval,
        google_search_retrieval,
        ...rest
      } = tool;
      void googleSearch;
      void google_search;
      void googleSearchRetrieval;
      void google_search_retrieval;
      return Object.keys(rest).length ? [rest] : [];
    }),
  };
}
