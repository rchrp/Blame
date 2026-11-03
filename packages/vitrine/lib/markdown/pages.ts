import { primaryArtifacts } from "@/app/(en)/download/artifacts";
import { loadLatestRelease } from "@/app/(en)/download/latest-release";
import { legalDocumentList } from "@/content/legal-documents";
import type { MarkdownPagePath } from "@/lib/markdown-paths";
import { legalDocumentMarkdown } from "@/lib/markdown/legal";
import {
  downloadMarkdown,
  homeMarkdown,
  pricingMarkdown,
} from "@/lib/markdown/site";

// The Markdown version of a page, or null when the page is not published.
export async function pageMarkdown(path: MarkdownPagePath) {
  if (path === "/") return homeMarkdown();
  if (path === "/cloud") return pricingMarkdown();
  if (path === "/download") {
    return downloadMarkdown(await loadLatestRelease(primaryArtifacts));
  }
  const document = legalDocumentList.find((candidate) => candidate.path === path);
  if (!document) throw new Error(`No Markdown version for ${path}`);
  const published =
    process.env.NODE_ENV !== "production" || document.readyForPublication;
  return published ? legalDocumentMarkdown(document) : null;
}
