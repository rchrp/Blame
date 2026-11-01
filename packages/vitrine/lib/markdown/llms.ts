import { pricingBillingOptions } from "@blame/pricing-card/offer";
import { primaryArtifacts } from "@/app/(en)/download/artifacts";
import { loadLatestRelease } from "@/app/(en)/download/latest-release";
import { legalDocumentList } from "@/content/legal-documents";
import { githubReleasesUrl, githubRepositoryUrl } from "@/lib/github";
import { markdownUrlPath } from "@/lib/markdown-paths";
import {
  downloadMarkdown,
  homeMarkdown,
  pricingMarkdown,
  productSummary,
} from "@/lib/markdown/site";
import { absoluteSiteUrl } from "@/lib/site";

// /llms.txt and /llms-full.txt, following https://llmstxt.org: an index of
// the site for AI agents, and the product pages in a single file.

const { monthly, yearly } = pricingBillingOptions;

export function llmsTxt() {
  const legal = legalDocumentList
    .filter((document) => document.readyForPublication)
    .map(
      (document) =>
        `- [${document.title}](${absoluteSiteUrl(markdownUrlPath(document.path))}): ${document.description}`,
    );

  return `# Blame

> ${productSummary}

Blame is free and open source (AGPL-3.0-only). Blame Premium adds hosted services (managed Cloud Previews, cloud voice transcription, hosted file uploads) for $${monthly.price}/month or $${yearly.price}/year. Agents run on your machine with your own AI provider: 50 providers are supported, plus any OpenAI-compatible API.

Every page below is plain Markdown. A page of the website also answers in Markdown when requested with \`Accept: text/markdown\`.

## Product

- [Overview](${absoluteSiteUrl("/index.md")}): what Blame is, how a story goes from backlog to merge, the Light Semantic Harness, platforms, and FAQ
- [Pricing](${absoluteSiteUrl("/pricing.md")}): what is free and what Blame Premium adds
- [Download](${absoluteSiteUrl("/download.md")}): the latest release for macOS, Windows, and Linux, with requirements
- [Full product text](${absoluteSiteUrl("/llms-full.txt")}): the three pages above in one file

## Source and research

- [GitHub repository](${githubRepositoryUrl}): source code, README, issues, and discussions
- [Releases](${githubReleasesUrl}): every version, betas, and checksums
- [Light Semantic Harness: Applied Study (PDF)](${absoluteSiteUrl("/research/light-semantic-harness-study.pdf")}): measured results, guarantees, and limits of Blame's agent harness
- [Demo video](https://youtu.be/cD6jASpIKQw): a user story from backlog to reviewed merge

## Optional

${legal.join("\n")}
`;
}

export async function llmsFullTxt() {
  const release = await loadLatestRelease(primaryArtifacts);
  return [homeMarkdown(), pricingMarkdown(), downloadMarkdown(release)].join(
    "\n---\n\n",
  );
}
