"use client";

import { Star } from "lucide-react";
import { createContext, useContext, type ReactNode, type SVGProps } from "react";
import { formatStarCount, githubRepositoryUrl } from "@/lib/github";

const GitHubStarsContext = createContext<number | null>(null);

export function GitHubStarsProvider({
  children,
  stars,
}: {
  children: ReactNode;
  stars: number | null;
}) {
  return (
    <GitHubStarsContext.Provider value={stars}>
      {children}
    </GitHubStarsContext.Provider>
  );
}

export function useGitHubStars() {
  return useContext(GitHubStarsContext);
}

export function GitHubMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

// The header's GitHub entry point: the mark, a "Star" call to action, and the
// live star count when the server could read it.
export function GitHubStarsLink({ className = "" }: { className?: string }) {
  const stars = useGitHubStars();
  const label =
    stars === null
      ? "Star Blame on GitHub"
      : `Star Blame on GitHub, ${stars} ${stars === 1 ? "star" : "stars"}`;

  return (
    <a
      href={githubRepositoryUrl}
      aria-label={label}
      className={`group inline-flex min-h-10 items-center gap-2 rounded-full border border-white/14 bg-white/[0.08] pl-3.5 pr-4 text-sm text-white/90 shadow-2xl shadow-black/20 backdrop-blur-xl transition duration-200 hover:bg-white/[0.14] focus:outline-none focus:ring-2 focus:ring-white/50 focus:ring-offset-2 focus:ring-offset-[#050505] ${className}`}
    >
      <GitHubMark className="size-[1.125rem] shrink-0" />
      <span>Star</span>
      {stars !== null && (
        <span className="flex items-center gap-1 border-l border-white/14 pl-2 tabular-nums text-white/72 transition group-hover:text-white">
          <Star className="size-3.5 fill-current text-[#f7cf83]" />
          {formatStarCount(stars)}
        </span>
      )}
    </a>
  );
}
