import { displayFont, GoogleTagManager } from "@/app/document-shell";
import { GitHubStarsProvider } from "@/components/github-stars";
import { SiteFooter } from "@/components/site-footer";
import { loadGitHubStars } from "@/lib/github-stars";
import "./globals.css";

export { rootMetadata } from "@/app/document-shell";

type RootDocumentProps = Readonly<{
  children: React.ReactNode;
  language: "en" | "fr";
}>;

export async function RootDocument({ children, language }: RootDocumentProps) {
  const stars = await loadGitHubStars();

  return (
    <html lang={language}>
      <body
        className={displayFont.variable}
      >
        <GoogleTagManager />
        <GitHubStarsProvider stars={stars}>
          {children}
          <SiteFooter />
        </GitHubStarsProvider>
      </body>
    </html>
  );
}
