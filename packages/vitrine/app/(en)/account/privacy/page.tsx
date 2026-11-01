import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Download, Mail, ShieldCheck } from "lucide-react";

import { SiteHeader } from "@/components/site-header";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Privacy and Account Data · Blame",
  description:
    "Export your Blame cloud data or request permanent account closure.",
  robots: { index: false, follow: true },
};

export default function AccountPrivacyPage() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#050712] text-white">
      <SiteHeader />
      <section className="relative isolate px-5 pb-20 pt-32 sm:px-8 lg:px-10">
        <div className="pointer-events-none absolute inset-0 -z-20 bg-[radial-gradient(circle_at_48%_12%,rgba(179,172,243,0.14),transparent_34%),linear-gradient(180deg,#070a17_0%,#050712_72%)]" />
        <AccountPrivacyCard />
      </section>
    </main>
  );
}

function AccountPrivacyCard() {
  return (
    <div className="relative isolate px-5 pb-14 pt-32 sm:px-8 sm:pb-18 lg:px-10">
      <div className="mx-auto w-full max-w-5xl">
        <PrivacyHeader />
        <PrivacyChoices />
        <PrivacyContact />
      </div>
    </div>
  );
}

function PrivacyHeader() {
  return (
    <header>
      <h1 className="mt-4 text-balance text-[clamp(2.8rem,7vw,5.5rem)] font-semibold leading-[0.94] tracking-[-0.06em]">
        Your data, under your control.
      </h1>
      <p className="mt-8 max-w-2xl text-lg leading-8 text-white/60">
        In Blame Desktop, open Settings, choose Account, then use Data and
        account closure. Your current password is required before an export or
        permanent closure can begin.
      </p>
    </header>
  );
}

function PrivacyChoices() {
  return (
    <div className="mt-10 grid gap-4 sm:grid-cols-2">
      <PrivacyAction
        icon={<Download className="size-5" />}
        title="Export account data"
        description="Download a structured JSON copy of eligible Blame cloud data. Stored authentication fields are excluded, but free-form content may reproduce secrets you supplied."
      />
      <PrivacyAction
        icon={<ShieldCheck className="size-5" />}
        title="Close your account"
        description="Access ends immediately. Active cloud data is deleted within 30 days, backups rotate within 90 days after active deletion, and a protected receipt lets you check status."
      />
    </div>
  );
}

function PrivacyContact() {
  return (
    <div className="mt-10 border-t border-white/10 pt-8">
      <p className="max-w-2xl text-sm leading-6 text-white/48">
        If you cannot sign in or need a broader privacy request, email us from
        your account address. We may request additional verification to protect
        your data.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <a href="mailto:privacy@blame.so" className={buttonVariants()}>
          <Mail className="size-4" /> privacy@blame.so
        </a>
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          <ArrowLeft className="size-4" /> Back to Blame
        </Link>
      </div>
    </div>
  );
}

function PrivacyAction({
  description,
  icon,
  title,
}: {
  description: string;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
      <div className="text-[#dedaff]">{icon}</div>
      <h2 className="mt-4 font-semibold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-white/48">{description}</p>
    </section>
  );
}
