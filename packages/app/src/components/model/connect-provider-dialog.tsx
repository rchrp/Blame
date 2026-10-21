import {
  ArrowLeftIcon,
  LoaderCircleIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"
import * as React from "react"
import type {
  BlameProvider as Provider,
  ProviderCredentialSummary,
} from "@blame/agent-runtime"

import { ClaudeCodeConnectContent } from "@/components/model/claude-code-connect"
import { ProviderMark } from "@/components/model/model-selector"
import { type ModelSelection, popularProviders } from "@/components/model/model-selection"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

const openAICompatibleProviderID = "openai-compatible"
const claudeCodeProviderID = "claude-code"

export function ProviderSelectDialog({
  onCloseAutoFocus,
  onConnect,
  onOpenChange,
  open,
  selection,
}: {
  onCloseAutoFocus?: (event: Event) => void
  onConnect: (providerID: string) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  selection: ModelSelection
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[80vh] overflow-hidden p-0 sm:max-w-lg"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>Connect provider</DialogTitle>
          <DialogDescription>
            Choose a provider and connect it to Blame.
          </DialogDescription>
        </DialogHeader>
        <Command className="min-h-0">
          <CommandInput placeholder="Search providers" />
          <CommandList className="max-h-[24rem] overscroll-contain">
            <CommandEmpty>No providers found</CommandEmpty>
            {groupProviders(selection.allProviders).map((group) => (
              <CommandGroup key={group.name} heading={group.name}>
                {group.providers.map((provider) => (
                  <CommandItem
                    key={provider.id}
                    value={`${provider.name} ${provider.id}`}
                    onSelect={() => onConnect(provider.id)}
                  >
                    <ProviderMark provider={provider} />
                    <span className="min-w-0 flex-1 truncate">
                      {provider.name}
                    </span>
                    {selection.connectedProviderIDs.has(provider.id) ? (
                      <Badge variant="secondary">Connected</Badge>
                    ) : null}
                    {provider.id === "anthropic" ? (
                      <Badge variant="outline">Recommended</Badge>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

export function ConnectProviderDialog({
  onBack,
  onCloseAutoFocus,
  onOpenChange,
  providerID,
  selection,
}: {
  onBack: () => void
  onCloseAutoFocus?: (event: Event) => void
  onOpenChange: (open: boolean) => void
  providerID: string | undefined
  selection: ModelSelection
}) {
  const provider = selection.allProviders.find((item) => item.id === providerID)
  const credentials = selection.credentials.filter(
    (item) => item.providerId === providerID
  )

  if (!provider) return null

  return (
    <Dialog open={!!providerID} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" onCloseAutoFocus={onCloseAutoFocus}>
        <ProviderConnectionsContent
          provider={provider}
          credentials={credentials}
          selection={selection}
          onBack={onBack}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function ProviderConnectionsContent({
  credentials,
  onBack,
  onDone,
  provider,
  selection,
}: {
  credentials: ProviderCredentialSummary[]
  onBack: () => void
  onDone: () => void
  provider: Provider
  selection: ModelSelection
}) {
  const [editingCredential, setEditingCredential] = React.useState<
    ProviderCredentialSummary | undefined
  >()
  const [adding, setAdding] = React.useState(credentials.length === 0)

  if ((adding || editingCredential) && provider.id === claudeCodeProviderID) {
    return (
      <ClaudeCodeConnectContent
        provider={provider}
        credential={editingCredential}
        selection={selection}
        onBack={() => {
          setAdding(false)
          setEditingCredential(undefined)
        }}
        onDone={onDone}
      />
    )
  }

  if (adding || editingCredential) {
    return (
      <ConnectProviderContent
        provider={provider}
        credential={editingCredential}
        selection={selection}
        onBack={() => {
          setAdding(false)
          setEditingCredential(undefined)
        }}
        onDone={onDone}
      />
    )
  }

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-3 pr-8">
          <Button size="icon-sm" variant="ghost" onClick={onBack}>
            <ArrowLeftIcon />
            <span className="sr-only">Back</span>
          </Button>
          <ProviderMark provider={provider} />
          <div className="grid gap-1">
            <DialogTitle>{provider.name} connections</DialogTitle>
            <DialogDescription>
              Manage the accounts and API keys connected to this provider.
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>
      <div className="grid gap-3">
        {credentials.map((credential) => (
          <button
            key={credential.id}
            type="button"
            className="flex items-center gap-3 rounded-md border p-3 text-left hover:bg-accent"
            onClick={() => setEditingCredential(credential)}
          >
            <ProviderMark provider={provider} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {connectionLabel(credential)}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {connectionDescription(credential)}
              </span>
            </span>
          </button>
        ))}
      </div>
      <div className="flex justify-end">
        <Button type="button" onClick={() => setAdding(true)}>
          <PlusIcon />
          Add connection
        </Button>
      </div>
    </>
  )
}

function ConnectProviderContent({
  credential,
  onBack,
  onDone,
  provider,
  selection,
}: {
  credential?: ProviderCredentialSummary
  onBack: () => void
  onDone: () => void
  provider: Provider
  selection: ModelSelection
}) {
  const [apiKey, setApiKey] = React.useState("")
  const [label, setLabel] = React.useState(connectionInitialLabel(credential))
  const [baseUrl, setBaseUrl] = React.useState(credential?.baseUrl ?? "")
  const [modelInput, setModelInput] = React.useState("")
  const [modelIds, setModelIds] = React.useState(
    openAICompatibleModelIds(credential)
  )
  const [error, setError] = React.useState<string>()
  const [deleting, setDeleting] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [oauthLoading, setOauthLoading] = React.useState(false)
  const oauth = provider.capabilities?.includes("oauth")
  const openAICompatible = provider.id === openAICompatibleProviderID
  const showBaseUrl = openAICompatible

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-3 pr-8">
          <Button size="icon-sm" variant="ghost" onClick={onBack}>
            <ArrowLeftIcon />
            <span className="sr-only">Back</span>
          </Button>
          <ProviderMark provider={provider} />
          <div className="grid gap-1">
            <DialogTitle>
              {credential ? "Edit" : "Connect"} {provider.name}
            </DialogTitle>
            <DialogDescription>
              {credential
                ? "Update or remove this provider connection."
                : "Add an API key for this provider."}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (oauth) {
            return
          }
          if (!label.trim()) {
            setError("Connection name is required")
            return
          }
          if (!apiKey.trim()) {
            setError("API key is required")
            return
          }
          if (openAICompatible && !modelIds.length) {
            setError("At least one model ID is required")
            return
          }
          setError(undefined)
          setSaving(true)
          void selection.agent?.providers
            .saveCredential(selection.apiConnection, {
              providerId: provider.id,
              label: label.trim(),
              apiKey,
              baseUrl: showBaseUrl ? baseUrl.trim() || null : null,
              modelIds: openAICompatible ? modelIds : undefined,
            })
            .then(() => selection.refreshProviders())
            .then(onDone)
            .catch((error) =>
              setError(
                error instanceof Error
                  ? error.message
                  : "Unable to save API key"
              )
            )
            .finally(() => setSaving(false))
        }}
      >
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="provider-label">
            Connection name
          </label>
          <Input
            id="provider-label"
            value={label}
            disabled={!!credential}
            placeholder="Work"
            onChange={(event) => setLabel(event.currentTarget.value)}
          />
        </div>
        {oauth ? (
          <Button
            type="button"
            disabled={oauthLoading || !selection.agent || !label.trim()}
            onClick={() => {
              setError(undefined)
              setOauthLoading(true)
              void selection.agent?.providers
                .loginOAuth({
                  apiConnection: selection.apiConnection,
                  providerId: provider.id,
                  label: label.trim(),
                  baseUrl: showBaseUrl ? baseUrl.trim() || null : null,
                })
                .then(() => selection.refreshProviders())
                .then(onDone)
                .catch((error) =>
                  setError(
                    error instanceof Error
                      ? error.message
                      : "Unable to connect OAuth provider"
                  )
                )
                .finally(() => setOauthLoading(false))
            }}
          >
            {oauthLoading ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : null}
            Continue with OAuth
          </Button>
        ) : (
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="provider-api-key">
              {provider.name} API key
            </label>
            <Input
              id="provider-api-key"
              value={apiKey}
              placeholder="Enter API key"
              onChange={(event) => setApiKey(event.currentTarget.value)}
            />
          </div>
        )}
        {showBaseUrl ? (
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="provider-base-url">
              Base URL
            </label>
            <Input
              id="provider-base-url"
              value={baseUrl}
              placeholder="https://provider.example/v1"
              onChange={(event) => setBaseUrl(event.currentTarget.value)}
            />
          </div>
        ) : null}
        {openAICompatible ? (
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="provider-model-id">
              Model IDs
            </label>
            <div className="flex flex-wrap gap-1 rounded-md border p-2">
              {modelIds.map((modelId) => (
                <button
                  key={modelId}
                  type="button"
                  className="rounded-md bg-muted px-2 py-1 text-xs"
                  onClick={() =>
                    setModelIds((current) =>
                      current.filter((item) => item !== modelId)
                    )
                  }
                >
                  {modelId} x
                </button>
              ))}
              <Input
                id="provider-model-id"
                value={modelInput}
                className="h-7 min-w-32 flex-1 border-0 px-1 shadow-none focus-visible:ring-0"
                placeholder="model-id"
                onChange={(event) => setModelInput(event.currentTarget.value)}
                onBlur={() => {
                  setModelIds((current) => addModelId(current, modelInput))
                  setModelInput("")
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  setModelIds((current) => addModelId(current, modelInput))
                  setModelInput("")
                }}
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={!modelInput.trim()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setModelIds((current) => addModelId(current, modelInput))
                  setModelInput("")
                }}
              >
                <PlusIcon />
                <span className="sr-only">Add model ID</span>
              </Button>
            </div>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          {credential ? (
            <Button
              type="button"
              variant="destructive"
              disabled={deleting || saving || !selection.agent}
              onClick={() => {
                setDeleting(true)
                setError(undefined)
                void selection.agent?.providers
                  .deleteCredential(selection.apiConnection, credential.id)
                  .then(() => selection.refreshProviders())
                  .then(onDone)
                  .catch((error) =>
                    setError(
                      error instanceof Error
                        ? error.message
                        : "Unable to delete API key"
                    )
                  )
                  .finally(() => setDeleting(false))
              }}
            >
              {deleting ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <Trash2Icon />
              )}
              Delete
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="submit"
            disabled={
              oauth ||
              saving ||
              !selection.agent ||
              !label.trim() ||
              !apiKey.trim() ||
              (openAICompatible && !modelIds.length)
            }
          >
            {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
            {credential ? "Save" : "Continue"}
          </Button>
        </div>
      </form>
    </>
  )
}

function connectionInitialLabel(
  credential: ProviderCredentialSummary | undefined
) {
  return credential?.label ?? ""
}

function openAICompatibleModelIds(
  credential: ProviderCredentialSummary | undefined
) {
  if (credential?.providerId !== openAICompatibleProviderID) return []
  if (credential.modelIds?.length) return credential.modelIds
  return credential.label === "default" ? [] : [credential.label]
}

function addModelId(modelIds: string[], input: string) {
  const modelId = input.trim()
  if (!modelId || modelIds.includes(modelId)) return modelIds
  return [...modelIds, modelId]
}

function connectionLabel(credential: ProviderCredentialSummary) {
  if (credential.label !== "default") return credential.label
  return credential.accountId ?? "Default"
}

function connectionDescription(credential: ProviderCredentialSummary) {
  if (
    credential.providerId === openAICompatibleProviderID &&
    credential.modelIds?.length
  ) {
    return credential.modelIds.join(", ")
  }
  if (credential.baseUrl) return credential.baseUrl
  if (credential.authMethod === "local-cli") return "Claude Code on this computer"
  return credential.authMethod === "oauth" ? "OAuth account" : "API key"
}

function groupProviders(providers: Provider[]) {
  const groups = providers.reduce((map, provider) => {
    const name = popularProviders.includes(provider.id) ? "Popular" : "Other"
    map.set(name, [...(map.get(name) ?? []), provider])
    return map
  }, new Map<string, Provider[]>())

  return Array.from(groups.entries())
    .map(([name, items]) => ({
      name,
      providers: items.sort(
        (a, b) =>
          getProviderRank(a.id) - getProviderRank(b.id) ||
          a.name.localeCompare(b.name)
      ),
    }))
    .sort((a, b) =>
      a.name === "Popular"
        ? -1
        : b.name === "Popular"
          ? 1
          : a.name.localeCompare(b.name)
    )
}

function getProviderRank(providerID: string) {
  const index = popularProviders.indexOf(providerID)
  return index === -1 ? popularProviders.length : index
}
