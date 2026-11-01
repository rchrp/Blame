import type { Metadata } from "next";

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
    },
    openGraph: createOpenGraphMetadata(socialMetadata),
    twitter: createTwitterMetadata(socialMetadata),
  };
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
