import { NextResponse, type NextRequest } from "next/server";

import {
  docsMarkdownRoutePath,
  isMarkdownPagePath,
  markdownRoutePath,
} from "@/lib/markdown-paths";

// Content negotiation for AI agents: a page requested with an Accept header
// that prefers text/markdown to text/html gets its Markdown version, at the
// page's own URL. Browsers never ask for Markdown, so they are unaffected.
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const markdownRoute = isMarkdownPagePath(path)
    ? markdownRoutePath(path)
    : docsMarkdownRoutePath(path);
  if (!markdownRoute || !prefersMarkdown(request.headers.get("accept"))) {
    return NextResponse.next();
  }
  return NextResponse.rewrite(new URL(markdownRoute, request.url));
}

// Page requests only: not Next.js assets, the Markdown routes themselves, or
// files (paths with a dot). The pages with a Markdown version are checked
// above, against lib/markdown-paths.ts; for the docs, every /docs page.
export const config = {
  matcher: ["/((?!_next/|md/|md$|.*\\.).*)"],
};

function prefersMarkdown(accept: string | null) {
  if (!accept) return false;
  const ranges = accept.split(",").map((part) => {
    const [type = "", ...parameters] = part.trim().toLowerCase().split(";");
    const q = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    return { type: type.trim(), q: q ? Number(q.slice(2)) || 0 : 1 };
  });
  const quality = (type: string) => {
    const [family] = type.split("/");
    const match =
      ranges.find((range) => range.type === type) ??
      ranges.find((range) => range.type === `${family}/*`) ??
      ranges.find((range) => range.type === "*/*");
    return match?.q ?? 0;
  };
  const markdown = ranges.find((range) => range.type === "text/markdown")?.q ?? 0;
  return markdown > 0 && markdown >= quality("text/html");
}
