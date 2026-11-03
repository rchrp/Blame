import { docsPageMarkdown, docsSource } from "@/lib/docs/source";
import { markdownResponse } from "@/lib/markdown/response";

// The Markdown version of each docs page: /docs/install.md is rewritten
// here (see next.config.ts), and so is /docs/install when an agent asks for
// Markdown (see proxy.ts).
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return docsSource.generateParams();
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug?: string[] }> },
) {
  const { slug } = await params;
  const page = docsSource.getPage(slug);
  if (!page) return new Response("Not found", { status: 404 });
  return markdownResponse(await docsPageMarkdown(page), {
    canonicalPath: page.url,
  });
}
