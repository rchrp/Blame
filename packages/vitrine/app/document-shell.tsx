import type { Metadata } from "next";
import localFont from "next/font/local";
import Script from "next/script";
import { siteUrl } from "@/lib/site";

// What every root layout shares, without a stylesheet: the website's
// layouts load app/globals.css, the docs their own app/(docs)/docs.css.

export const displayFont = localFont({
  src: "./fonts/test-soehne-dreiviertelfett.woff2",
  variable: "--font-soehne",
  weight: "700",
  style: "normal",
  display: "swap",
});

const googleTagManagerId = "GTM-P4TLSMCV";
// Google's snippet, run once the page is interactive (next/script's
// afterInteractive) rather than from the <head>, so the tag manager's
// scripts never compete with the page's own while it loads.
const googleTagManagerScript = `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${googleTagManagerId}');`;

export function GoogleTagManager() {
  return (
    <>
      <Script id="google-tag-manager" strategy="afterInteractive">
        {googleTagManagerScript}
      </Script>
      <noscript>
        <iframe
          src={`https://www.googletagmanager.com/ns.html?id=${googleTagManagerId}`}
          height="0"
          width="0"
          style={{ display: "none", visibility: "hidden" }}
        />
      </noscript>
    </>
  );
}

export const rootMetadata: Metadata = {
  metadataBase: siteUrl,
  title: "Blame",
  applicationName: "Blame",
  category: "technology",
  description:
    "Blame is the open-source ADE for AI coding agents: a verifiable harness, isolated smart worktrees, live Cloud Previews, and controlled merges.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icons/blame-icon-64.png", type: "image/png", sizes: "64x64" },
      { url: "/icons/blame-icon-128.png", type: "image/png", sizes: "128x128" },
      { url: "/icons/blame-icon-256.png", type: "image/png", sizes: "256x256" },
    ],
    apple: [
      { url: "/icons/blame-icon-256.png", type: "image/png", sizes: "256x256" },
    ],
  },
};
