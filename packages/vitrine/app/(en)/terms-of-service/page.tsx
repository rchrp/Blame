import { LegalDocumentRoute } from "@/components/legal-document-route";
import { legalDocuments } from "@/content/legal-documents";
import { createLegalDocumentMetadata } from "@/lib/seo";

const legalDocument = legalDocuments.termsOfService;

export const metadata = createLegalDocumentMetadata(legalDocument);

export default function TermsOfServicePage() {
  return <LegalDocumentRoute document={legalDocument} />;
}
