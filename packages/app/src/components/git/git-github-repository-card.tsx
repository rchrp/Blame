import * as React from "react"
import {
  ExternalLinkIcon,
  GitForkIcon,
  GitPullRequestIcon,
  StarIcon,
} from "lucide-react"

import { fetchGitHubRepository, type GitHubRepository } from "@/lib/github-api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export function GitHubRepositoryCard({ remote }: { remote?: string }) {
  const [result, setResult] = React.useState<{
    error?: string
    remote: string
    repository?: GitHubRepository
  }>()

  React.useEffect(() => {
    if (!remote) return

    let cancelled = false
    fetchGitHubRepository(remote)
      .then((next) => {
        if (!cancelled) setResult({ remote, repository: next })
      })
      .catch((nextError) => {
        if (!cancelled) {
          setResult({
            error:
              nextError instanceof Error
                ? nextError.message
                : "Unable to load GitHub repository",
            remote,
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [remote])

  if (!remote) return null
  const current = result?.remote === remote ? result : undefined
  if (current?.error) {
    return (
      <div className="rounded-xl bg-muted/40 p-3 text-xs text-muted-foreground">
        GitHub repository unavailable.
      </div>
    )
  }
  if (!current?.repository) {
    return (
      <Card className="gap-3 py-3" size="sm">
        <CardHeader className="px-3">
          <Skeleton className="h-4 w-40" />
        </CardHeader>
        <CardContent className="flex gap-2 px-3">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-16" />
        </CardContent>
      </Card>
    )
  }

  const repository = current.repository

  return (
    <Card className="gap-3 py-3" size="sm">
      <CardHeader className="px-3">
        <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
          <GitPullRequestIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {repository.owner}/{repository.name}
          </span>
        </CardTitle>
        {repository.description ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {repository.description}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-1.5 px-3">
        <Badge variant="outline">
          <StarIcon className="size-3" />
          {compactNumber(repository.stars)}
        </Badge>
        <Badge variant="outline">
          <GitForkIcon className="size-3" />
          {compactNumber(repository.forks)}
        </Badge>
        <Badge variant="outline">{repository.issues} issues</Badge>
        <Button asChild className="ml-auto" size="xs" variant="ghost">
          <a href={repository.htmlUrl} rel="noreferrer" target="_blank">
            Open
            <ExternalLinkIcon />
          </a>
        </Button>
      </CardContent>
      <div className="px-3 text-[11px] text-muted-foreground">
        Default branch: {repository.defaultBranch}
      </div>
    </Card>
  )
}

function compactNumber(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value)
}
