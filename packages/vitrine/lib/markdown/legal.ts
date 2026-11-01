import type { LegalBlock } from "@/components/legal-document-page";
import type { LegalDocument } from "@/content/legal-documents";
import { absoluteSiteUrl } from "@/lib/site";
import { markdownUrlPath } from "@/lib/markdown-paths";

// A legal document as Markdown, from the same content as its page.
export function legalDocumentMarkdown(document: LegalDocument) {
  const french = document.language === "fr";
  const labels = french
    ? {
        effective: "Date d’entrée en vigueur",
        updated: "Dernière mise à jour",
        page: "Page",
        other: "English version",
      }
    : {
        effective: "Effective date",
        updated: "Last updated",
        page: "Page",
        other: "Version française",
      };
  const otherLanguage = document.translations
    ? document.translations[french ? "en" : "fr"]
    : null;

  return [
    `# ${document.title}`,
    [
      `${labels.effective}: ${document.effectiveDate}`,
      `${labels.updated}: ${document.lastUpdated}`,
      `Version: ${document.version}`,
    ].join(" · "),
    [
      `${labels.page}: ${absoluteSiteUrl(document.path)}`,
      otherLanguage
        ? `${labels.other}: ${absoluteSiteUrl(markdownUrlPath(otherLanguage))}`
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
    ...document.introduction,
    ...document.sections.flatMap((section) => [
      `## ${section.title}`,
      ...section.blocks.map(blockMarkdown),
    ]),
  ].join("\n\n");
}

function blockMarkdown(block: LegalBlock) {
  if (block.type === "paragraph") return block.text;
  if (block.type === "list") return listMarkdown(block.items);
  const body = [
    `**${block.title}**`,
    ...block.paragraphs,
    ...(block.items ? [listMarkdown(block.items)] : []),
  ].join("\n\n");
  return body
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function listMarkdown(items: readonly string[]) {
  return items.map((item) => `- ${item}`).join("\n");
}
