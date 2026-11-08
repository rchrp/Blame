import { GitPullRequestIcon } from "lucide-react"

import { usePlatform } from "@/context/platform"

// The story's GitHub pull request, opened in the browser.
export function PullRequestLink({ url }: { url: string }) {
  const platform = usePlatform()
  const number = /\/pull\/(\d+)/u.exec(url)?.[1]
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
      onClick={(event) => {
        if (!platform.openExternalLink) return
        event.preventDefault()
        platform.openExternalLink(url)
      }}
    >
      <GitPullRequestIcon className="size-3.5" />
      {number ? `Pull request #${number}` : "Pull request"}
    </a>
  )
}
