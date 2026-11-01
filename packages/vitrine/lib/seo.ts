import type { Metadata } from "next";

import type { LegalDocument } from "@/content/legal-documents";
import { isMarkdownPagePath, markdownUrlPath } from "@/lib/markdown-paths";
import { absoluteSiteUrl } from "@/lib/site";

const socialImageUrl = absoluteSiteUrl("/social/blame-social-card.jpg");
const socialImageAlt = "Blame — The ADE that sets the standard";

type IndexablePageMetadata = {
  canonicalPath: string;
  description: string;
  languageAlternates?: Record<string, string>;
  locale?: string;
  title: string;
};

type SocialPageMetadata = {
  canonicalUrl: string;
  description: string;
  locale: string;
  title: string;
};

export function createIndexablePageMetadata({
  canonicalPath,
  description,
  languageAlternates,
  locale = "en_US",
  title,
}: IndexablePageMetadata): Metadata {
  const canonicalUrl = absoluteSiteUrl(canonicalPath);
  const socialMetadata = { canonicalUrl, description, locale, title };

  return {
    title,
    description,
    alternates: {
      canonical: canonicalUrl,
      languages: resolveLanguageAlternates(languageAlternates),
      // The page's Markdown version, for AI agents.
      types: isMarkdownPagePath(canonicalPath)
        ? { "text/markdown": absoluteSiteUrl(markdownUrlPath(canonicalPath)) }
        : undefined,
    },
    openGraph: createOpenGraphMetadata(socialMetadata),
    twitter: createTwitterMetadata(socialMetadata),
  };
}

export function createLegalDocumentMetadata(document: LegalDocument): Metadata {
  return createIndexablePageMetadata({
    title: `${document.title} · Blame`,
    description: document.description,
    canonicalPath: document.path,
    locale: document.language === "fr" ? "fr_FR" : "en_US",
    languageAlternates: document.translations
      ? { ...document.translations, "x-default": document.translations.en }
      : undefined,
  });
}

function resolveLanguageAlternates(languageAlternates?: Record<string, string>) {
  if (!languageAlternates) return undefined;

  return Object.fromEntries(
    Object.entries(languageAlternates).map(([language, pathname]) => [
      language,
      absoluteSiteUrl(pathname),
    ]),
  );
}

function createOpenGraphMetadata({
  canonicalUrl,
  description,
  locale,
  title,
}: SocialPageMetadata): Metadata["openGraph"] {
  return {
    title,
    description,
    url: canonicalUrl,
    siteName: "Blame",
    locale,
    type: "website",
    images: [
      {
        url: socialImageUrl,
        width: 1200,
        height: 628,
        alt: socialImageAlt,
      },
    ],
  };
}

function createTwitterMetadata({
  description,
  title,
}: SocialPageMetadata): Metadata["twitter"] {
  return {
    card: "summary_large_image",
    title,
    description,
    images: [{ url: socialImageUrl, alt: socialImageAlt }],
  };
}
