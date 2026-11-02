import { LegalDocumentRoute } from "@/components/legal-document-route";
import { legalDocuments } from "@/content/legal-documents";
import { createLegalDocumentMetadata } from "@/lib/seo";

const legalDocument = legalDocuments.codeSigningPolicy;

export const metadata = createLegalDocumentMetadata(legalDocument);

export default function CodeSigningPolicyPage() {
  return <LegalDocumentRoute document={legalDocument} />;
}
