"use client";

import Image from "next/image";
import Link from "next/link";
import {
  PricingCard as SharedPricingCard,
  pricingLegalLinkClassName,
} from "@blame/pricing-card";

import { buttonVariants } from "@/components/ui/button";

export function PricingCard() {
  return (
    <SharedPricingCard
      className="landing-reveal landing-reveal-actions mt-12"
      logo={
        <Image
          src="/icons/blame-dark-app-icon.png"
          alt=""
          width={48}
          height={48}
          className="h-12 w-12 object-contain"
        />
      }
      action={() => (
        <Link
          href="/download"
          className={buttonVariants({ variant: "dark", className: "w-full" })}
        >
          Download Blame
        </Link>
      )}
      legalLinks={
        <>
          <Link className={pricingLegalLinkClassName} href="/terms-of-service">
            Terms
          </Link>
          <Link className={pricingLegalLinkClassName} href="/privacy">
            Privacy
          </Link>
          <Link className={pricingLegalLinkClassName} href="/refund-policy">
            Refunds
          </Link>
          <Link className={pricingLegalLinkClassName} href="/withdraw">
            Withdrawal
          </Link>
        </>
      }
    />
  );
}
