import type { MetadataRoute } from "next";

import {
  isoLegalDate,
  legalDocumentList,
} from "@/content/legal-documents";
import { docsPagesInOrder } from "@/lib/docs/source";
import { absoluteSiteUrl } from "@/lib/site";

// Product pages first, then the docs, then every legal document with the
// date it last changed and, for the Terms, its other language.
const productPaths = ["/", "/cloud", "/download"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const products = productPaths.map((pathname) => ({
    url: absoluteSiteUrl(pathname),
    changeFrequency: "weekly" as const,
    priority: pathname === "/" ? 1 : 0.8,
  }));
  const docs = docsPagesInOrder().map((page) => ({
    url: absoluteSiteUrl(page.url),
    changeFrequency: "weekly" as const,
    priority: page.url === "/docs" ? 0.8 : 0.6,
  }));
  const legal = legalDocumentList
    .filter((document) => document.readyForPublication)
    .map((document) => ({
      url: absoluteSiteUrl(document.path),
      lastModified: isoLegalDate(document.lastUpdated),
      changeFrequency: "yearly" as const,
      priority: 0.3,
      alternates: document.translations
        ? {
            languages: {
              en: absoluteSiteUrl(document.translations.en),
              fr: absoluteSiteUrl(document.translations.fr),
            },
          }
        : undefined,
    }));
  return [...products, ...docs, ...legal];
}
