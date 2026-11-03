import { flattenTree } from "fumadocs-core/page-tree";
import { loader, type InferPageType } from "fumadocs-core/source";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";

import { githubRepositoryUrl } from "@/lib/github";
import { absoluteSiteUrl } from "@/lib/site";

// The documentation at /docs: MDX pages in content/docs, compiled by
// Fumadocs MDX (the macro below is replaced at build time).

export const docsRoute = "/docs";
export const docsContentDirectory = "packages/vitrine/content/docs";

const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    // Each page's Markdown, for /docs/….md and AI agents.
    postprocess: { includeProcessedMarkdown: true },
  },
  meta: { schema: metaSchema },
});

export const docsSource = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
});

export type DocsPage = InferPageType<typeof docsSource>;

// Every page, in the sidebar's order.
export function docsPagesInOrder() {
  return flattenTree(docsSource.getPageTree().children)
    .map((item) => docsSource.getNodePage(item))
    .filter((page): page is DocsPage => page !== undefined);
}

// The page's source file on GitHub, where it can be edited.
export function docsPageGitHubUrl(page: DocsPage) {
  return `${githubRepositoryUrl}/blob/main/${docsContentDirectory}/${page.path}`;
}

// Where a page's Markdown version is served: /docs.md for /docs,
// /docs/install.md for /docs/install (see next.config.ts).
export function docsMarkdownPath(page: Pick<DocsPage, "url">) {
  return `${page.url}.md`;
}

export async function docsPageMarkdown(page: DocsPage) {
  const description = page.data.description
    ? `> ${page.data.description}\n\n`
    : "";
  return `# ${page.data.title}

${description}Page: ${absoluteSiteUrl(page.url)}

${await page.data.getText("processed")}`;
}
