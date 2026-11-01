import { LegalDocumentRoute } from "@/components/legal-document-route";
import { legalDocuments } from "@/content/legal-documents";
import { createLegalDocumentMetadata } from "@/lib/seo";

const legalDocument = legalDocuments.refundPolicy;

export const metadata = createLegalDocumentMetadata(legalDocument);

export default function RefundPolicyPage() {
  return <LegalDocumentRoute document={legalDocument} />;
}
