import Image from "next/image";
import Link from "next/link";
import {
  githubContributingUrl,
  githubIssuesUrl,
  githubLicenseUrl,
  githubReleasesUrl,
  githubRepositoryUrl,
} from "@/lib/github";

const footerGroups = [
  {
    title: "Product",
    links: [
      { href: "/pricing", label: "Pricing" },
      { href: "/download", label: "Download" },
      { href: "/account/privacy", label: "Account data & closure" },
    ],
  },
  {
    title: "Open source",
    links: [
      { href: githubRepositoryUrl, label: "GitHub repository" },
      { href: githubReleasesUrl, label: "Releases" },
      { href: githubIssuesUrl, label: "Report an issue" },
      { href: githubContributingUrl, label: "Contributing" },
      { href: githubLicenseUrl, label: "AGPL-3.0 license" },
    ],
  },
  {
    title: "Legal",
    links: [
      {
        href: "/terms-of-service",
        label: "Terms of Service",
      },
      { href: "/privacy", label: "Privacy Policy" },
      { href: "/legal-notice", label: "Legal Notice" },
      { href: "/refund-policy", label: "Refund Policy" },
      { href: "/legal/dpa", label: "Data Processing Addendum" },
      { href: "/legal/subprocessors", label: "Subprocessor Register" },
    ],
  },
  {
    title: "Consumer rights",
    links: [
      { href: "/billing", label: "Billing" },
      { href: "/withdraw", label: "Withdraw from contract" },
      { href: "mailto:support@blame.so", label: "Consumer complaints" },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-white/10 bg-black px-5 py-14 text-white sm:px-8 lg:px-10">
      <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[1.3fr_2fr] xl:grid-cols-[1fr_2.6fr]">
        <PublisherSummary />
        <FooterNavigation />
      </div>
      <Copyright />
    </footer>
  );
}

function PublisherSummary() {
  return (
    <div>
      <Link
        href="/"
        className="font-display inline-flex items-center gap-3 text-2xl"
        aria-label="Blame home"
      >
        <span className="grid h-10 w-10 place-items-center">
          <Image
            src="/icons/blame-dark-app-icon.png"
            alt=""
            width={40}
            height={40}
            className="h-10 w-10 object-contain"
          />
        </span>
        <span>Blame</span>
      </Link>
      <p className="mt-4 max-w-md text-sm leading-7 text-white/52">
        Blame is published by Raphael Charpentier EI, operating under the trade
        name MK Holding, registered under SIREN 984 448 217 (R.C.S. Lyon).
      </p>
      <a
        className="mt-4 inline-block text-sm text-[#dedaff] underline decoration-white/20 underline-offset-4"
        href="mailto:support@blame.so"
      >
        support@blame.so
      </a>
    </div>
  );
}

function FooterNavigation() {
  return (
    <div className="grid gap-10 sm:grid-cols-2 xl:grid-cols-4">
      {footerGroups.map((group) => (
        <FooterGroup key={group.title} group={group} />
      ))}
    </div>
  );
}

function FooterGroup({ group }: { group: (typeof footerGroups)[number] }) {
  return (
    <nav aria-label={group.title}>
      <p className="text-xs uppercase tracking-[0.24em] text-white/38">
        {group.title}
      </p>
      <ul className="mt-5 space-y-3 text-sm text-white/62">
        {group.links.map((link) => (
          <li key={link.href}>
            <Link className="transition hover:text-white" href={link.href}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Copyright() {
  return (
    <p className="mx-auto mt-12 max-w-7xl border-t border-white/8 pt-6 text-xs text-white/34">
      © {new Date().getFullYear()} Raphael Charpentier EI — MK Holding. Blame
      is free software, licensed under the{" "}
      <Link
        className="underline decoration-white/20 underline-offset-4 transition hover:text-white/70"
        href={githubLicenseUrl}
      >
        GNU AGPL v3
      </Link>
      .
    </p>
  );
}
