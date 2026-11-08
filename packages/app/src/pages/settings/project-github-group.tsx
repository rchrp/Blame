import { LoaderCircleIcon, PlugZapIcon, UnlinkIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { SettingsGroup, SettingsRow } from "./settings-layout"
import { useProjectGithub } from "./use-project-github"

export type ProjectGithubState = ReturnType<typeof useProjectGithub>

// The account project's GitHub repository, which cloud sessions use through
// the Blame GitHub App.
export function ProjectGithubGroup() {
  return <ProjectGithubSettings state={useProjectGithub()} />
}

export function ProjectGithubSettings({
  state,
}: {
  state: ProjectGithubState
}) {
  return (
    <SettingsGroup
      title="GitHub repository"
      description="The repository the agent works with in this project's cloud sessions, through the Blame GitHub App."
    >
      <ProjectGithubRows state={state} />
    </SettingsGroup>
  )
}

function ProjectGithubRows({ state }: { state: ProjectGithubState }) {
  if (!state.project) {
    return (
      <SettingsRow
        title="No project open"
        description="Open a project to link it to GitHub."
      >
        {null}
      </SettingsRow>
    )
  }
  if (state.loading) {
    return (
      <SettingsRow title="GitHub" description="Loading GitHub settings…">
        <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
      </SettingsRow>
    )
  }
  if (state.loadError || !state.github) {
    return (
      <SettingsRow
        title="GitHub"
        description={state.loadError ?? "GitHub settings could not be loaded."}
      >
        {null}
      </SettingsRow>
    )
  }
  const available = state.github.available
  const linked = state.github.repository

  return (
    <>
      {available ? null : (
        <SettingsRow
          title="GitHub App not configured"
          description="This Blame server has no GitHub App configured, so projects cannot be linked to GitHub here."
        >
          {null}
        </SettingsRow>
      )}
      <SettingsRow
        title="GitHub installations"
        description={installationsSummary(state)}
      >
        <Button
          type="button"
          variant="outline"
          disabled={!available || state.connecting}
          onClick={() => void state.connect()}
        >
          {state.connecting ? (
            <LoaderCircleIcon className="animate-spin" />
          ) : (
            <PlugZapIcon />
          )}
          {state.connecting ? "Waiting for GitHub…" : "Connect GitHub"}
        </Button>
      </SettingsRow>
      {linked ? (
        <SettingsRow
          title={`${linked.owner}/${linked.name}`}
          description={linkedDescription(state, linked.installationId)}
        >
          <Button
            type="button"
            variant="outline"
            disabled={!available || state.saving}
            onClick={() => void state.unlink()}
          >
            <UnlinkIcon />
            Unlink
          </Button>
        </SettingsRow>
      ) : (
        <RepositoryLinkForm state={state} disabled={!available} />
      )}
    </>
  )
}

function RepositoryLinkForm({
  disabled,
  state,
}: {
  disabled: boolean
  state: ProjectGithubState
}) {
  const noInstallation = !state.installations.length
  const formDisabled = disabled || noInstallation || state.saving

  return (
    <form
      className="flex flex-col gap-3 border-b py-4 last:border-b-0"
      onSubmit={(event) => {
        event.preventDefault()
        void state.link()
      }}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium">Link a repository</div>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose the installation that includes the repository, then enter it as
          owner/name.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select
          value={state.installationId ?? ""}
          onValueChange={state.setInstallationId}
          disabled={formDisabled}
        >
          <SelectTrigger
            aria-label="GitHub installation"
            className="w-full sm:w-48"
          >
            <SelectValue placeholder="No installation" />
          </SelectTrigger>
          <SelectContent>
            {state.installations.map((installation) => (
              <SelectItem key={installation.id} value={installation.id}>
                {installation.accountLogin}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="Repository"
          placeholder="owner/name"
          value={state.repository}
          disabled={formDisabled}
          onChange={(event) => state.setRepository(event.target.value)}
          className="min-w-0 flex-1"
        />
        <Button
          type="submit"
          disabled={formDisabled || !state.repository.trim()}
        >
          {state.saving ? <LoaderCircleIcon className="animate-spin" /> : null}
          Link repository
        </Button>
      </div>
      {state.linkError ? (
        <p role="alert" className="text-sm text-destructive">
          {state.linkError}
        </p>
      ) : null}
    </form>
  )
}

function installationsSummary(state: ProjectGithubState) {
  if (!state.installations.length)
    return "Install the Blame GitHub App on your GitHub account or organization, then come back here."
  const accounts = state.installations.map(({ accountLogin }) => accountLogin)
  return `Connected on ${accounts.join(", ")}. Connect again to add an account or repositories.`
}

function linkedDescription(state: ProjectGithubState, installationId: string) {
  const installation = state.installations.find(
    ({ id }) => id === installationId
  )
  return installation
    ? `Linked through the Blame GitHub App installation on ${installation.accountLogin}.`
    : "Linked through the Blame GitHub App."
}
