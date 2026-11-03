import {
  pricingBillingOptions,
  type PricingBillingCycle,
} from "@blame/pricing-card/offer";
import { pricingFaq } from "@/content/faq";
import {
  isoLegalDate,
  type LegalDocument,
} from "@/content/legal-documents";
import { githubReleasesUrl, githubRepositoryUrl } from "@/lib/github";
import { absoluteSiteUrl } from "@/lib/site";

// Schema.org data for search engines and AI agents. Every page's graph
// describes the same publisher, website and application, under the same @id,
// so their facts add up across pages.

const organizationId = absoluteSiteUrl("/#organization");
const websiteId = absoluteSiteUrl("/#website");
const applicationId = absoluteSiteUrl("/#software-application");
const sourceCodeId = absoluteSiteUrl("/#source-code");
const pricingUrl = absoluteSiteUrl("/cloud");
const licenseUrl = "https://www.gnu.org/licenses/agpl-3.0.html";

const organizationStructuredData = {
  "@type": "Organization",
  "@id": organizationId,
  name: "Blame",
  alternateName: "MK Holding",
  legalName: "Raphael Charpentier EI",
  url: absoluteSiteUrl("/"),
  logo: {
    "@type": "ImageObject",
    url: absoluteSiteUrl("/icons/blame-icon-512.png"),
    width: 512,
    height: 512,
  },
  sameAs: [githubRepositoryUrl],
  email: "support@blame.so",
  telephone: "+33 6 67 28 12 29",
  address: {
    "@type": "PostalAddress",
    streetAddress: "36 rue des Geltines",
    postalCode: "69390",
    addressLocality: "Millery",
    addressCountry: "FR",
  },
  identifier: {
    "@type": "PropertyValue",
    propertyID: "SIREN",
    value: "984448217",
  },
};

const websiteStructuredData = {
  "@type": "WebSite",
  "@id": websiteId,
  url: absoluteSiteUrl("/"),
  name: "Blame",
  description:
    "The website of Blame, the open-source Agentic Development Environment (ADE) for AI coding agents.",
  publisher: { "@id": organizationId },
  inLanguage: ["en", "fr"],
};

const premiumOfferDescription =
  "Managed Cloud Previews, cloud voice transcription, and hosted file uploads";

function premiumOffer(cycle: PricingBillingCycle) {
  const option = pricingBillingOptions[cycle];
  return {
    "@type": "Offer",
    name: `${option.label} Blame Cloud`,
    description: `${premiumOfferDescription}, billed ${cycle === "monthly" ? "monthly" : "once a year"}.`,
    url: pricingUrl,
    price: Number(option.price),
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price: Number(option.price),
      priceCurrency: "USD",
      billingDuration: cycle === "monthly" ? "P1M" : "P1Y",
    },
  };
}

const softwareApplicationStructuredData = {
  "@type": "SoftwareApplication",
  "@id": applicationId,
  name: "Blame",
  alternateName: "Blame ADE",
  description:
    "Blame is an open-source Agentic Development Environment (ADE): a desktop app where each task goes from backlog to AI coding agent, isolated worktree, live preview, review, and controlled merge, through a verifiable harness.",
  url: absoluteSiteUrl("/"),
  downloadUrl: absoluteSiteUrl("/download"),
  installUrl: absoluteSiteUrl("/download"),
  releaseNotes: githubReleasesUrl,
  image: absoluteSiteUrl("/social/blame-social-card.jpg"),
  applicationCategory: "DeveloperApplication",
  applicationSubCategory: "Agentic Development Environment",
  license: licenseUrl,
  isAccessibleForFree: true,
  operatingSystem: "macOS 13 or later, Windows 10 or 11, Linux",
  featureList: [
    "Backlog-driven development: each user story becomes a lane that keeps its brief, agent work, review, and decision",
    "Light Semantic Harness: agents find code by its structure, read before they edit, and prove their checks",
    "Smart worktrees: a dedicated branch, worktree, environment, port, and runtime for each story",
    "Live previews beside each story, and managed Cloud Previews",
    "Controlled merge: approve, request changes, or reject",
    "Parallel agents across 50 AI providers and any OpenAI-compatible API",
    "Code Practices that hold every agent to your engineering standards",
    "Specialist agents for codebase context, story, frontend design, verification, and risk",
    "MCP servers for every agent",
    "Project creation from an empty folder",
    "Account sync of stories, conversations, practices, providers, and MCP servers",
  ],
  publisher: { "@id": organizationId },
  subjectOf: {
    "@type": "Report",
    name: "Light Semantic Harness: Applied Study",
    url: absoluteSiteUrl("/research/light-semantic-harness-study.pdf"),
    encodingFormat: "application/pdf",
  },
  offers: [
    {
      "@type": "Offer",
      name: "Blame Free",
      description:
        "The whole app, free and open source: local development with your own AI providers.",
      url: pricingUrl,
      price: 0,
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
    premiumOffer("monthly"),
    premiumOffer("yearly"),
  ],
};

const sourceCodeStructuredData = {
  "@type": "SoftwareSourceCode",
  "@id": sourceCodeId,
  name: "Blame",
  codeRepository: githubRepositoryUrl,
  programmingLanguage: "TypeScript",
  license: licenseUrl,
  targetProduct: { "@id": applicationId },
  publisher: { "@id": organizationId },
};

const sharedGraph = [
  organizationStructuredData,
  websiteStructuredData,
  softwareApplicationStructuredData,
  sourceCodeStructuredData,
];

function webPage(path: string, name: string, description: string) {
  const url = absoluteSiteUrl(path);
  return {
    "@type": "WebPage",
    "@id": `${url}#webpage`,
    url,
    name,
    description,
    isPartOf: { "@id": websiteId },
    publisher: { "@id": organizationId },
  };
}

function breadcrumb(path: string, name: string) {
  const url = absoluteSiteUrl(path);
  return {
    "@type": "BreadcrumbList",
    "@id": `${url}#breadcrumb`,
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Blame", item: absoluteSiteUrl("/") },
      { "@type": "ListItem", position: 2, name, item: url },
    ],
  };
}

export const homepageStructuredData = {
  "@context": "https://schema.org",
  "@graph": [
    ...sharedGraph,
    {
      ...webPage(
        "/",
        "Blame — The Open Source ADE That Sets the Standard",
        softwareApplicationStructuredData.description,
      ),
      about: { "@id": applicationId },
    },
  ],
};

export const pricingStructuredData = {
  "@context": "https://schema.org",
  "@graph": [
    ...sharedGraph,
    {
      ...webPage(
        "/cloud",
        "Blame Cloud",
        "Blame is free and open source. Blame Cloud adds hosted services.",
      ),
      // The page ends on its questions (content/faq.ts).
      "@type": ["WebPage", "FAQPage"],
      about: { "@id": applicationId },
      breadcrumb: { "@id": `${pricingUrl}#breadcrumb` },
      mainEntity: pricingFaq.map((entry) => ({
        "@type": "Question",
        name: entry.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: entry.link
            ? `${entry.answer} ${entry.link.label}: ${absoluteSiteUrl(entry.link.path)}`
            : entry.answer,
        },
      })),
    },
    breadcrumb("/cloud", "Blame Cloud"),
  ],
};

// The download page also states the release it offers and its files.
export function downloadStructuredData(
  release: { tag: string | null; downloadUrls: readonly string[] },
) {
  const url = absoluteSiteUrl("/download");
  return {
    "@context": "https://schema.org",
    "@graph": [
      organizationStructuredData,
      websiteStructuredData,
      {
        ...softwareApplicationStructuredData,
        downloadUrl: release.downloadUrls,
        ...(release.tag ? { softwareVersion: release.tag.replace(/^v/, "") } : {}),
      },
      sourceCodeStructuredData,
      {
        ...webPage(
          "/download",
          "Download Blame",
          "Download the Blame desktop app for macOS, Windows, and Linux.",
        ),
        about: { "@id": applicationId },
        breadcrumb: { "@id": `${url}#breadcrumb` },
      },
      breadcrumb("/download", "Download"),
    ],
  };
}

export function legalDocumentStructuredData(document: LegalDocument) {
  const url = absoluteSiteUrl(document.path);
  return {
    "@context": "https://schema.org",
    "@graph": [
      organizationStructuredData,
      websiteStructuredData,
      {
        ...webPage(document.path, document.title, document.description),
        inLanguage: document.language,
        datePublished: isoLegalDate(document.effectiveDate),
        dateModified: isoLegalDate(document.lastUpdated),
        version: document.version,
        breadcrumb: { "@id": `${url}#breadcrumb` },
      },
      breadcrumb(document.path, document.title),
    ],
  };
}
