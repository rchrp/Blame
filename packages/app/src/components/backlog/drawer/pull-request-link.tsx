import { GitPullRequestIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { usePlatform } from "@/context/platform"
import { cn } from "@/lib/utils"

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

// What a story in review offers once its pull request is open: the review
// happens on GitHub, so Reject and Approve & Merge give way to this button.
export function PullRequestButton({
  className,
  size = "default",
  url,
}: {
  className?: string
  size?: "default" | "sm"
  url: string
}) {
  const platform = usePlatform()
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      title={url}
      className={cn("justify-start", className)}
      onClick={() => {
        if (platform.openExternalLink) platform.openExternalLink(url)
        else window.open(url, "_blank", "noopener,noreferrer")
      }}
    >
      <GitPullRequestIcon />
      View Pull Request
    </Button>
  )
}
