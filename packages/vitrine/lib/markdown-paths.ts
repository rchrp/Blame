// The pages that have a Markdown version for AI agents, and where it is
// served: /pricing.md for /pricing, /index.md for the home page. next.config
// imports this file, so it uses relative imports only.

export const markdownPagePaths = [
  "/",
  "/pricing",
  "/download",
  "/terms-of-service",
  "/fr/conditions-generales-de-service",
  "/privacy",
  "/code-signing-policy",
  "/refund-policy",
  "/legal-notice",
  "/legal/dpa",
  "/legal/subprocessors",
] as const;

export type MarkdownPagePath = (typeof markdownPagePaths)[number];

export function isMarkdownPagePath(path: string): path is MarkdownPagePath {
  return (markdownPagePaths as readonly string[]).includes(path);
}

// The public URL of a page's Markdown version.
export function markdownUrlPath(pagePath: MarkdownPagePath) {
  return pagePath === "/" ? "/index.md" : `${pagePath}.md`;
}

// The route that renders it (app/(agents)/md/[[...page]]/route.ts).
export function markdownRoutePath(pagePath: MarkdownPagePath) {
  return pagePath === "/" ? "/md" : `/md${pagePath}`;
}
