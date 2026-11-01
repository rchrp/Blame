import type { LegalSection } from "@/components/legal-document-page";
import {
  dpaEffectiveDate,
  dpaIntroduction,
  dpaLastUpdated,
  dpaReadyForPublication,
  dpaSections,
  dpaVersion,
} from "@/content/data-processing-addendum";
import {
  frenchTermsEffectiveDate,
  frenchTermsIntroduction,
  frenchTermsLastUpdated,
  frenchTermsReadyForPublication,
  frenchTermsSections,
  frenchTermsVersion,
} from "@/content/french-terms-of-service";
import {
  legalNoticeEffectiveDate,
  legalNoticeIntroduction,
  legalNoticeLastUpdated,
  legalNoticeReadyForPublication,
  legalNoticeSections,
  legalNoticeVersion,
} from "@/content/legal-notice";
import {
  privacyEffectiveDate,
  privacyIntroduction,
  privacyLastUpdated,
  privacyReadyForPublication,
  privacySections,
  privacyVersion,
} from "@/content/privacy-policy";
import {
  refundEffectiveDate,
  refundIntroduction,
  refundLastUpdated,
  refundReadyForPublication,
  refundSections,
  refundVersion,
} from "@/content/refund-policy";
import {
  subprocessorsEffectiveDate,
  subprocessorsIntroduction,
  subprocessorsLastUpdated,
  subprocessorsReadyForPublication,
  subprocessorsSections,
  subprocessorsVersion,
} from "@/content/subprocessor-register";
import {
  termsEffectiveDate,
  termsIntroduction,
  termsLastUpdated,
  termsReadyForPublication,
  termsSections,
  termsVersion,
} from "@/content/terms-of-service";
import type { MarkdownPagePath } from "@/lib/markdown-paths";

// Every legal document the website publishes, in one place: its page, its
// metadata, the sitemap, its structured data and its Markdown version for AI
// agents all read from here.
export type LegalDocument = {
  // Every legal page also has a Markdown version: its path must be listed in
  // lib/markdown-paths.ts.
  path: MarkdownPagePath;
  title: string;
  description: string;
  language: "en" | "fr";
  // The English and French versions of the same contract.
  translations?: { en: MarkdownPagePath; fr: MarkdownPagePath };
  effectiveDate: string;
  lastUpdated: string;
  version: string;
  introduction: readonly string[];
  sections: readonly LegalSection[];
  readyForPublication: boolean;
};

const termsTranslations = {
  en: "/terms-of-service",
  fr: "/fr/conditions-generales-de-service",
} as const;

export const legalDocuments = {
  termsOfService: {
    path: "/terms-of-service",
    title: "Terms of Service",
    description:
      "Terms governing access to and use of Blame Desktop, Blame accounts, Blame Premium subscriptions, and related cloud services.",
    language: "en",
    translations: termsTranslations,
    effectiveDate: termsEffectiveDate,
    lastUpdated: termsLastUpdated,
    version: termsVersion,
    introduction: termsIntroduction,
    sections: termsSections,
    readyForPublication: termsReadyForPublication,
  },
  frenchTermsOfService: {
    path: "/fr/conditions-generales-de-service",
    title: "Conditions Générales de Service et de Vente",
    description:
      "Conditions contractuelles françaises applicables à Blame Desktop, aux comptes Blame, à l’abonnement Blame Premium et aux services cloud associés.",
    language: "fr",
    translations: termsTranslations,
    effectiveDate: frenchTermsEffectiveDate,
    lastUpdated: frenchTermsLastUpdated,
    version: frenchTermsVersion,
    introduction: frenchTermsIntroduction,
    sections: frenchTermsSections,
    readyForPublication: frenchTermsReadyForPublication,
  },
  privacyPolicy: {
    path: "/privacy",
    title: "Privacy Policy",
    description:
      "How Blame handles personal data across Blame Desktop, its website, cloud services, billing, and support.",
    language: "en",
    effectiveDate: privacyEffectiveDate,
    lastUpdated: privacyLastUpdated,
    version: privacyVersion,
    introduction: privacyIntroduction,
    sections: privacySections,
    readyForPublication: privacyReadyForPublication,
  },
  refundPolicy: {
    path: "/refund-policy",
    title: "Refund Policy",
    description:
      "When Blame refunds a subscription: the standard rule, the 14-day consumer right of withdrawal, legal conformity, billing errors, and how to request a review.",
    language: "en",
    effectiveDate: refundEffectiveDate,
    lastUpdated: refundLastUpdated,
    version: refundVersion,
    introduction: refundIntroduction,
    sections: refundSections,
    readyForPublication: refundReadyForPublication,
  },
  legalNotice: {
    path: "/legal-notice",
    title: "Legal Notice",
    description:
      "Publisher, publication director, hosting provider, and contact details for the blame.so website and the Blame software and cloud services.",
    language: "en",
    effectiveDate: legalNoticeEffectiveDate,
    lastUpdated: legalNoticeLastUpdated,
    version: legalNoticeVersion,
    introduction: legalNoticeIntroduction,
    sections: legalNoticeSections,
    readyForPublication: legalNoticeReadyForPublication,
  },
  dataProcessingAddendum: {
    path: "/legal/dpa",
    title: "Data Processing Addendum",
    description:
      "Data-protection terms governing Blame's processing of Customer Personal Data for Business Users.",
    language: "en",
    effectiveDate: dpaEffectiveDate,
    lastUpdated: dpaLastUpdated,
    version: dpaVersion,
    introduction: dpaIntroduction,
    sections: dpaSections,
    readyForPublication: dpaReadyForPublication,
  },
  subprocessorRegister: {
    path: "/legal/subprocessors",
    title: "Subprocessor Register",
    description:
      "The current third parties authorised to process Customer Personal Data on behalf of Blame Business Users.",
    language: "en",
    effectiveDate: subprocessorsEffectiveDate,
    lastUpdated: subprocessorsLastUpdated,
    version: subprocessorsVersion,
    introduction: subprocessorsIntroduction,
    sections: subprocessorsSections,
    readyForPublication: subprocessorsReadyForPublication,
  },
} satisfies Record<string, LegalDocument>;

export const legalDocumentList: readonly LegalDocument[] =
  Object.values(legalDocuments);

// Month names as the documents write them, in English and in French.
const monthNames = [
  ["january", "janvier"],
  ["february", "février"],
  ["march", "mars"],
  ["april", "avril"],
  ["may", "mai"],
  ["june", "juin"],
  ["july", "juillet"],
  ["august", "août"],
  ["september", "septembre"],
  ["october", "octobre"],
  ["november", "novembre"],
  ["december", "décembre"],
];

// A date as the documents write it ("19 July 2026", "19 juillet 2026"), in
// ISO form for the sitemap and structured data.
export function isoLegalDate(date: string) {
  const match = /^(\d{1,2}) (\p{L}+) (\d{4})$/u.exec(date);
  const month = match
    ? monthNames.findIndex((names) => names.includes(match[2].toLowerCase())) + 1
    : 0;
  if (!match || !month) {
    throw new Error(`Unreadable legal document date: ${date}`);
  }
  const day = match[1].padStart(2, "0");
  return `${match[3]}-${String(month).padStart(2, "0")}-${day}`;
}
