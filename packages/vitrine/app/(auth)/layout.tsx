import { rootMetadata } from "@/app/root-document";
import { GitHubStarsProvider } from "@/components/github-stars";
import { loadGitHubStars } from "@/lib/github-stars";
import "@/app/globals.css";

export const metadata = rootMetadata;

export default async function AuthRootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const stars = await loadGitHubStars();

  return (
    <html lang="en">
      <body>
        <GitHubStarsProvider stars={stars}>{children}</GitHubStarsProvider>
      </body>
    </html>
  );
}
