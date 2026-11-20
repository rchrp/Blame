import type { ApiConnection } from "../../types.js";
import { webResearchCalls } from "../../web-research-calls.js";
import type { RenderWebPage } from "../../web-research-types.js";
import { defineTool, type ClientTool } from "../tool.js";

export type WebResearchServices = {
  /** The user's API connection right now (search goes through Blame's API). */
  connection(): ApiConnection | undefined;
  /** Renders a page in the desktop's isolated browser, for JavaScript pages. */
  render?: RenderWebPage;
};

/** search_web and read_web_page, read only, as client tools. */
export function webResearchClientTools(
  services: WebResearchServices,
): ClientTool<never>[] {
  return webResearchCalls.map((call) =>
    defineTool<Record<string, unknown>>({
      name: call.name,
      description: call.description,
      inputSchema: call.inputSchema,
      effect: "read_only",
      timeoutMs: call.timeoutMs,
      async run(input, { signal, progress }) {
        const connection = services.connection();
        if (!connection)
          throw new Error(
            "Blame is not connected to its API, so the web cannot be searched right now.",
          );
        progress(
          call.name === "search_web" ? "Searching the web" : "Reading the page",
        );
        return {
          json: await call.run(input, {
            connection,
            render: services.render,
            signal,
          }),
        };
      },
    }),
  );
}
