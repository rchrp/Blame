import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import { GitHubStarsProvider } from "@/components/github-stars";
import { SiteFooter } from "@/components/site-footer";
import { loadGitHubStars } from "@/lib/github-stars";
import { siteUrl } from "@/lib/site";
import "./globals.css";

const displayFont = localFont({
  src: "./fonts/test-soehne-dreiviertelfett.woff2",
  variable: "--font-soehne",
  weight: "700",
  style: "normal",
  display: "swap",
});

const monoFont = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

const googleTagManagerId = "GTM-P4TLSMCV";
const googleTagManagerScript = `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${googleTagManagerId}');`;

export const rootMetadata: Metadata = {
  metadataBase: siteUrl,
  title: "Blame",
  description:
    "Blame is the ADE for verifiable agentic development: Code Practices, isolated smart worktrees, live Cloud Previews, and controlled merges.",
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

type RootDocumentProps = Readonly<{
  children: React.ReactNode;
  language: "en" | "fr";
}>;

export async function RootDocument({ children, language }: RootDocumentProps) {
  const stars = await loadGitHubStars();

  return (
    <html lang={language}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: googleTagManagerScript,
          }}
        />
      </head>
      <body
        className={`${displayFont.variable} ${monoFont.variable}`}
      >
        <noscript>
          <iframe
            src={`https://www.googletagmanager.com/ns.html?id=${googleTagManagerId}`}
            height="0"
            width="0"
            style={{ display: "none", visibility: "hidden" }}
          />
        </noscript>
        <GitHubStarsProvider stars={stars}>
          {children}
          <SiteFooter />
        </GitHubStarsProvider>
      </body>
    </html>
  );
}
