import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SquarePen } from "lucide-react";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  EditOnGitHub,
  MarkdownCopyButton,
} from "fumadocs-ui/layouts/notebook/page";
import { createRelativeLink } from "fumadocs-ui/mdx";

import { getMDXComponents } from "@/components/docs/mdx";
import {
  docsMarkdownPath,
  docsPageGitHubUrl,
  docsSource,
} from "@/lib/docs/source";
import { createIndexablePageMetadata } from "@/lib/seo";
import { absoluteSiteUrl } from "@/lib/site";

type DocsPageProps = {
  params: Promise<{ slug?: string[] }>;
};

export const dynamicParams = false;

export default async function DocsContentPage({ params }: DocsPageProps) {
  const { slug } = await params;
  const page = docsSource.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle className="font-display">{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row items-center gap-2 border-b pb-6">
        <MarkdownCopyButton markdownUrl={docsMarkdownPath(page)} />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            // Links between pages can use the .mdx file's relative path.
            a: createRelativeLink(docsSource, page),
          })}
        />
      </DocsBody>
      <EditOnGitHub href={docsPageGitHubUrl(page)} className="w-fit">
        <SquarePen className="size-3.5" aria-hidden="true" />
        Edit this page on GitHub
      </EditOnGitHub>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return docsSource.generateParams();
}

export async function generateMetadata({
  params,
}: DocsPageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = docsSource.getPage(slug);
  if (!page) notFound();

  const metadata = createIndexablePageMetadata({
    title: `${page.data.title} · Blame Docs`,
    description: page.data.description ?? "",
    canonicalPath: page.url,
  });
  return {
    ...metadata,
    alternates: {
      ...metadata.alternates,
      // The page's Markdown version, for AI agents.
      types: { "text/markdown": absoluteSiteUrl(docsMarkdownPath(page)) },
    },
  };
}
