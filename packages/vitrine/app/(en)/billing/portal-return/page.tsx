import type { Metadata } from "next";

import { BillingReturnPage } from "@/components/billing-return-page";

export const metadata: Metadata = {
  title: "Billing updated · Blame",
  description:
    "Return to Blame and refresh your Blame Cloud subscription status.",
  robots: { index: false, follow: false },
};

export default function BillingPortalReturnPage() {
  return <BillingReturnPage variant="portal" />;
}
