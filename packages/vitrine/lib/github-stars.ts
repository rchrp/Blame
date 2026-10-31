import { githubRepository } from "@/lib/github";

const repositoryApiUrl = `https://api.github.com/repos/${githubRepository}`;
const revalidateSeconds = 3600;

// Rendered on the server and cached for an hour, so visitors never call the
// GitHub API themselves. Without a count, the GitHub link still renders.
export async function loadGitHubStars(): Promise<number | null> {
  try {
    const response = await fetch(repositoryApiUrl, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: revalidateSeconds },
    });
    if (!response.ok) return null;

    const repository = (await response.json()) as { stargazers_count?: unknown };
    return typeof repository.stargazers_count === "number"
      ? repository.stargazers_count
      : null;
  } catch {
    return null;
  }
}
