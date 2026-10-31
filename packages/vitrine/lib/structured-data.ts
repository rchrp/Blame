import { githubRepositoryUrl } from "@/lib/github";
import { absoluteSiteUrl } from "@/lib/site";

const organizationId = absoluteSiteUrl("/#organization");
const websiteId = absoluteSiteUrl("/#website");
const applicationId = absoluteSiteUrl("/#software-application");
const pricingUrl = absoluteSiteUrl("/pricing");

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
  publisher: { "@id": organizationId },
  inLanguage: ["en", "fr"],
};

const softwareApplicationStructuredData = {
  "@type": "SoftwareApplication",
  "@id": applicationId,
  name: "Blame",
  description:
    "Blame is an Agentic Development Environment (ADE) with a verifiable harness for AI coding agents, Code Practices, isolated smart worktrees, live Cloud Previews, and controlled merges.",
  url: absoluteSiteUrl("/"),
  downloadUrl: absoluteSiteUrl("/download"),
  image: absoluteSiteUrl("/social/blame-social-card.png"),
  applicationCategory: "DeveloperApplication",
  license: "https://www.gnu.org/licenses/agpl-3.0.html",
  isAccessibleForFree: true,
  operatingSystem: ["Windows", "macOS", "Linux"],
  publisher: { "@id": organizationId },
  offers: [
    {
      "@type": "Offer",
      name: "Blame Free",
      description: "Local development with your own AI providers.",
      url: pricingUrl,
      price: 0,
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
    {
      "@type": "Offer",
      name: "Monthly Blame Premium",
      description:
        "Managed cloud previews, voice transcription, and hosted file uploads billed monthly.",
      url: pricingUrl,
      price: 20,
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
    {
      "@type": "Offer",
      name: "Yearly Blame Premium",
      description:
        "Managed cloud previews, voice transcription, and hosted file uploads billed once a year.",
      url: pricingUrl,
      price: 200,
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
  ],
};

export const homepageStructuredData = {
  "@context": "https://schema.org",
  "@graph": [
    organizationStructuredData,
    websiteStructuredData,
    softwareApplicationStructuredData,
  ],
};
