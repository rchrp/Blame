import * as React from "react"
import { toast } from "sonner"

import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { createCloudApi } from "@/lib/cloud-api"
import { parseGitHubRepository } from "@/lib/github-api"
import {
  parseGithubRepositoryInput,
  type GithubInstallation,
  type ProjectGithub,
} from "@/lib/github-cloud-api"

const installationPollMs = 2_000
const connectWaitMs = 5 * 60_000

/**
 * The open account project's GitHub repository, through the Blame GitHub
 * App: connect installations, link `owner/name`, unlink it.
 */
export function useProjectGithub() {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const project = useProjects().activeProject
  const projectId = project?.id
  const projectPath = project?.path
  const api = React.useMemo(
    () => createCloudApi(auth.apiConnection),
    [auth.apiConnection]
  )
  const [github, setGithub] = React.useState<ProjectGithub>()
  const [installations, setInstallations] = React.useState<
    GithubInstallation[]
  >([])
  const [installationId, setInstallationId] = React.useState<string>()
  const [repository, setRepository] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string>()
  const [linkError, setLinkError] = React.useState<string>()
  const [connecting, setConnecting] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const connectDeadline = React.useRef(0)
  const knownInstallations = React.useRef(new Set<string>())

  const applyInstallations = React.useCallback((next: GithubInstallation[]) => {
    setInstallations(next)
    setInstallationId((current) =>
      next.some(({ id }) => id === current) ? current : next[0]?.id
    )
  }, [])

  const refresh = React.useCallback(async () => {
    if (!projectId) {
      setLoading(false)
      return
    }
    setLoadError(undefined)
    try {
      const [githubResult, installationResult] = await Promise.all([
        api.projectGithub(projectId),
        api.githubInstallations(),
      ])
      setGithub(githubResult.github)
      applyInstallations(installationResult.installations)
    } catch (cause) {
      setLoadError(message(cause, "GitHub settings could not be loaded."))
    } finally {
      setLoading(false)
    }
  }, [api, applyInstallations, projectId])

  React.useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  // Suggests the repository of the project's GitHub remote.
  React.useEffect(() => {
    if (!projectPath || !platform.workspace) return
    let active = true
    void platform.workspace
      .gitStatus({ root: projectPath })
      .then(({ remote }) => {
        const parsed = remote ? parseGitHubRepository(remote) : undefined
        if (active && parsed)
          setRepository(
            (current) => current || `${parsed.owner}/${parsed.name}`
          )
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [platform.workspace, projectPath])

  // Reloads the installations while the person installs the app on GitHub.
  React.useEffect(() => {
    if (!connecting) return
    const poll = window.setInterval(() => {
      if (Date.now() >= connectDeadline.current) {
        setConnecting(false)
        return
      }
      void api
        .githubInstallations()
        .then(({ installations: next }) => {
          applyInstallations(next)
          const added = next.find(
            ({ id }) => !knownInstallations.current.has(id)
          )
          if (!added) return
          setInstallationId(added.id)
          setConnecting(false)
          toast.success(`GitHub connected on ${added.accountLogin}.`)
        })
        .catch(() => undefined)
    }, installationPollMs)
    return () => window.clearInterval(poll)
  }, [api, applyInstallations, connecting])

  const connect = React.useCallback(async () => {
    knownInstallations.current = new Set(installations.map(({ id }) => id))
    setConnecting(true)
    try {
      const intent = await api.githubConnectIntent()
      connectDeadline.current = Math.min(
        Date.parse(intent.expiresAt),
        Date.now() + connectWaitMs
      )
      platform.openExternalLink?.(intent.url)
    } catch (cause) {
      setConnecting(false)
      toast.error(message(cause, "GitHub connection could not be started."))
    }
  }, [api, installations, platform])

  const link = React.useCallback(async () => {
    if (!projectId || !installationId) return
    const parsed = parseGithubRepositoryInput(repository)
    if (!parsed) {
      setLinkError("Enter the repository as owner/name.")
      return
    }
    setLinkError(undefined)
    setSaving(true)
    try {
      const result = await api.linkGithubRepository(projectId, {
        installationId,
        ...parsed,
      })
      setGithub(result.github)
      toast.success(`${parsed.owner}/${parsed.name} linked.`)
    } catch (cause) {
      setLinkError(message(cause, "The repository could not be linked."))
    } finally {
      setSaving(false)
    }
  }, [api, installationId, projectId, repository])

  const unlink = React.useCallback(async () => {
    if (!projectId) return
    setSaving(true)
    try {
      const result = await api.unlinkGithubRepository(projectId)
      setGithub(result.github)
      setLinkError(undefined)
    } catch (cause) {
      toast.error(message(cause, "The repository could not be unlinked."))
    } finally {
      setSaving(false)
    }
  }, [api, projectId])

  return {
    connect,
    connecting,
    github,
    installationId,
    installations,
    link,
    linkError,
    loadError,
    loading,
    project,
    repository,
    saving,
    setInstallationId,
    setRepository: (value: string) => {
      setRepository(value)
      setLinkError(undefined)
    },
    unlink,
  }
}

function message(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback
}
