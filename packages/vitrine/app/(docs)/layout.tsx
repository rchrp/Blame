import type { Metadata } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";

import {
  displayFont,
  GoogleTagManager,
  rootMetadata,
} from "@/app/document-shell";
import "./docs.css";

export const metadata: Metadata = {
  ...rootMetadata,
  title: "Blame Docs",
};

// The docs have their own root layout: Fumadocs' theme and search replace
// the website's header, footer and stylesheet. They open dark, like the
// website, and the header's switch offers a light theme.
export default function DocsRootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${displayFont.variable} flex min-h-screen flex-col`}>
        <GoogleTagManager />
        <RootProvider
          theme={{ defaultTheme: "dark", enableSystem: false }}
          search={{ options: { api: "/api/search" } }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
