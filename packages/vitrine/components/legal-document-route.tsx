import { notFound } from "next/navigation";

import { JsonLd } from "@/components/json-ld";
import { LegalDocumentPage } from "@/components/legal-document-page";
import type { LegalDocument } from "@/content/legal-documents";
import { legalDocumentStructuredData } from "@/lib/structured-data";

// A legal document's page, with its structured data. In production it stays
// hidden until the document is approved for publication.
export function LegalDocumentRoute({ document }: { document: LegalDocument }) {
  if (process.env.NODE_ENV === "production" && !document.readyForPublication) {
    notFound();
  }

  return (
    <>
      <JsonLd
        id="legal-document-structured-data"
        data={legalDocumentStructuredData(document)}
      />
      <LegalDocumentPage
        languageRoutes={
          document.translations
            ? {
                englishHref: document.translations.en,
                frenchHref: document.translations.fr,
              }
            : undefined
        }
        effectiveDate={document.effectiveDate}
        introduction={document.introduction}
        language={document.language}
        lastUpdated={document.lastUpdated}
        sections={document.sections}
        title={document.title}
        version={document.version}
      />
    </>
  );
}
