import {
  isMarkdownPagePath,
  markdownPagePaths,
} from "@/lib/markdown-paths";
import { pageMarkdown } from "@/lib/markdown/pages";
import { markdownResponse } from "@/lib/markdown/response";

// The Markdown version of each page. /pricing.md is rewritten here (see
// next.config.ts), and so is /pricing when an agent asks for Markdown (see
// proxy.ts). The download page's release is refreshed like the page's.
export const revalidate = 600;
export const dynamicParams = false;

export function generateStaticParams() {
  return markdownPagePaths.map((path) => ({
    page: path === "/" ? [] : path.slice(1).split("/"),
  }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ page?: string[] }> },
) {
  const { page = [] } = await params;
  const path = `/${page.join("/")}`;
  const markdown = isMarkdownPagePath(path) ? await pageMarkdown(path) : null;
  if (!isMarkdownPagePath(path) || markdown === null) {
    return new Response("Not found", { status: 404 });
  }
  return markdownResponse(markdown, { canonicalPath: path });
}
