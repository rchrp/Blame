import { absoluteSiteUrl } from "@/lib/site";

// A Markdown answer for an AI agent. When it stands for a page, a canonical
// Link header sends search engines to that page instead, and Vary keeps
// caches from serving it to a browser that asked for the HTML.
export function markdownResponse(
  body: string,
  { canonicalPath, plainText = false }: { canonicalPath?: string; plainText?: boolean } = {},
) {
  const headers = new Headers({
    "Content-Type": `${plainText ? "text/plain" : "text/markdown"}; charset=utf-8`,
    Vary: "Accept",
  });
  if (canonicalPath) {
    headers.set("Link", `<${absoluteSiteUrl(canonicalPath)}>; rel="canonical"`);
  }
  return new Response(body, { headers });
}
