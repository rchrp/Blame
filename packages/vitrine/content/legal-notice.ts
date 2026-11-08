import type {
  LegalBlock,
  LegalSection,
} from "@/components/legal-document-page";
import { legalDocumentReadyForPublication } from "@/content/legal-publication";
import { publisher } from "@/lib/publisher";

const paragraph = (text: string): LegalBlock => ({ type: "paragraph", text });
const list = (...items: string[]): LegalBlock => ({ type: "list", items });

export const legalNoticeEffectiveDate = "19 July 2026";
export const legalNoticeLastUpdated = "19 July 2026";
export const legalNoticeVersion = "1.0";

export const legalNoticeIntroduction = [
  "This Legal Notice identifies the publisher and hosting provider of the blame.so website and the Blame software and cloud services. It is provided in accordance with applicable French law, including the French Law for Confidence in the Digital Economy.",
] as const;

export const legalNoticeSections = [
  {
    id: "publisher",
    title: "1. Publisher and service provider",
    blocks: [
      paragraph(
        "The website and the Blame Services are published and provided by Raphael Charpentier, an individual entrepreneur (entrepreneur individuel) applying the French micro-enterprise regime and operating under the trade name MK Holding.",
      ),
      list(
        `Business address: ${publisher.address}.`,
        `SIREN: ${publisher.siren}.`,
        "Registration: French National Business Register and R.C.S. Lyon.",
        "Email: legal@blame.so.",
        `Telephone: ${publisher.phone}.`,
        "VAT: VAT not applicable pursuant to Article 293 B of the French General Tax Code.",
      ),
    ],
  },
  {
    id: "publication-director",
    title: "2. Publication director",
    blocks: [
      paragraph(
        "The publication director is Raphael Charpentier, in his capacity as proprietor of Raphael Charpentier EI / MK Holding. He may be contacted at legal@blame.so or at the publisher's postal address above.",
      ),
    ],
  },
  {
    id: "hosting",
    title: "3. Hosting provider",
    blocks: [
      paragraph(
        "The website, API, databases, and primary cloud infrastructure are hosted by OVH SAS, a company registered with the Lille Trade and Companies Register under number 424 761 419, whose registered office is at 2 rue Kellermann, 59100 Roubaix, France. Telephone: +33 9 72 10 10 07. Website: https://www.ovhcloud.com.",
      ),
      paragraph(
        "Blame's primary production hosting and storage region is the OVHcloud Gravelines data-centre region in France. Operational location information does not replace OVH SAS's registered contact details above.",
      ),
    ],
  },
  {
    id: "contact",
    title: "4. Contact and complaints",
    blocks: [
      list(
        "General support and Consumer complaints: support@blame.so.",
        "Billing, invoices, and cancellation: billing@blame.so.",
        "Withdrawal requests: withdrawal@blame.so.",
        "Privacy and data protection: privacy@blame.so.",
        "Security reports: security@blame.so.",
        "Legal correspondence: legal@blame.so.",
      ),
      paragraph(
        "A French Consumer who has first submitted a written complaint to Blame and has not obtained a satisfactory resolution may use the mediation arrangements described in the Terms of Service and French Conditions Générales de Service, subject to the mediator's eligibility rules.",
      ),
    ],
  },
  {
    id: "intellectual-property",
    title: "5. Intellectual property",
    blocks: [
      paragraph(
        "The Blame name, software, user interface, website, graphics, logos, text, audiovisual material, documentation, and other original content are protected by applicable intellectual-property laws and belong to Raphael Charpentier EI or the identified rightsholder. No right is granted except the limited rights expressly stated in the Terms of Service.",
      ),
      paragraph(
        "You may link to publicly accessible pages in a fair and lawful manner. You may not reproduce, extract, redistribute, frame, scrape, or commercially exploit a substantial part of the website or Services without prior written permission or a statutory exception.",
      ),
    ],
  },
  {
    id: "website-information",
    title: "6. Website information and availability",
    blocks: [
      paragraph(
        "We take reasonable care to keep public information accurate and the website available. Product features, compatibility, prices, and availability may nevertheless change. Contractual information displayed and accepted at checkout prevails for the relevant order, subject to mandatory law.",
      ),
      paragraph(
        "Links to third-party websites are supplied for convenience. Blame does not control their availability or content and does not endorse them merely by linking to them. Nothing in this notice excludes liability that cannot lawfully be excluded.",
      ),
    ],
  },
  {
    id: "personal-data",
    title: "7. Personal data and storage technologies",
    blocks: [
      paragraph(
        "The Privacy Policy at https://blame.so/privacy explains the processing of personal data, legal bases, recipients, international transfers, retention periods, security, and individual rights. Privacy requests may be sent to privacy@blame.so.",
      ),
      paragraph(
        "Blame does not currently use advertising or behavioural-analytics cookies. Strictly necessary or user-requested storage may be used without consent where the law permits. Any future non-essential tracker will be disabled until the required information and consent controls are provided.",
      ),
    ],
  },
  {
    id: "applicable-documents",
    title: "8. Applicable contractual documents",
    blocks: [
      list(
        "Terms of Service: https://blame.so/terms-of-service.",
        "French Consumer Conditions Générales de Service: https://blame.so/fr/conditions-generales-de-service.",
        "Refund Policy: https://blame.so/refund-policy.",
        "Data Processing Addendum: https://blame.so/legal/dpa.",
        "Subprocessor Register: https://blame.so/legal/subprocessors.",
        "Subscription management and electronic cancellation: use the Billing link under Consumer rights to open the Stripe Customer Portal.",
        "Electronic withdrawal: https://blame.so/withdraw.",
      ),
    ],
  },
] satisfies readonly LegalSection[];

export const legalNoticeReadyForPublication = legalDocumentReadyForPublication(
  true,
  {
    legalNoticeEffectiveDate,
    legalNoticeIntroduction,
    legalNoticeSections,
    legalNoticeVersion,
  },
);
