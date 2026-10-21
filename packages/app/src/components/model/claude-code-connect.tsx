import {
  ArrowLeftIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react"
import * as React from "react"
import type {
  BlameProvider as Provider,
  ClaudeCodeStatus,
  ProviderCredentialSummary,
} from "@blame/agent-runtime"

import type { ModelSelection } from "@/components/model/model-selection"
import { ProviderMark } from "@/components/model/model-selector"
import { Button } from "@/components/ui/button"
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { usePlatform } from "@/context/platform"
import { cn } from "@/lib/utils"

const setupGuideUrl = "https://code.claude.com/docs/en/setup"
const statusPollMs = 5_000

type StepState = "done" | "current" | "pending"

/**
 * Guides the user through installing Claude Code and signing in on this
 * computer, then saves the connection. Each step checks itself, so the user
 * can follow along from a terminal and come back.
 */
export function ClaudeCodeConnectContent({
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
  const providers = selection.agent?.providers
  const { checking, check, status } = useClaudeCodeStatus(
    providers?.claudeCodeStatus
  )
  const [error, setError] = React.useState<string>()
  const [saving, setSaving] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const installed = !!status?.installed
  const signedIn = installed && !!status?.loggedIn
  const subscription = status?.authMethod === "claude.ai"
  const supported = !!providers?.claudeCodeStatus && !!providers.connectClaudeCode

  const connect = () => {
    if (!providers?.connectClaudeCode) return
    setError(undefined)
    setSaving(true)
    void providers
      .connectClaudeCode({ apiConnection: selection.apiConnection })
      .then(() => selection.refreshProviders())
      .then(onDone)
      .catch((reason) => setError(errorMessage(reason, "Unable to connect Claude Code")))
      .finally(() => setSaving(false))
  }

  const disconnect = () => {
    if (!credential || !providers) return
    setError(undefined)
    setDeleting(true)
    void providers
      .deleteCredential(selection.apiConnection, credential.id)
      .then(() => selection.refreshProviders())
      .then(onDone)
      .catch((reason) => setError(errorMessage(reason, "Unable to disconnect")))
      .finally(() => setDeleting(false))
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
            <DialogTitle>
              {credential ? "Claude Code connection" : "Connect Claude Code"}
            </DialogTitle>
            <DialogDescription>
              Use your Claude Pro or Max plan. Blame runs Claude Code on this
              computer and keeps its own tools and checks.
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      {!supported ? (
        <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
          Claude Code connects from the Blame desktop app, where it can run on
          your computer.
        </p>
      ) : (
        <ol className="grid">
          <SetupStep
            index={1}
            state={installed ? "done" : status ? "current" : "pending"}
            title="Install Claude Code"
          >
            {installed ? (
              <p>
                Claude Code {status?.version ? `${status.version} ` : ""}
                is installed.
              </p>
            ) : (
              <>
                <p>Run this in a terminal, then come back here.</p>
                <CommandSnippet command={installCommand()} />
                <GuideLink />
              </>
            )}
          </SetupStep>
          <SetupStep
            index={2}
            state={signedIn ? "done" : installed ? "current" : "pending"}
            title="Sign in with your Claude account"
          >
            {signedIn ? (
              <>
                <p>
                  Signed in
                  {status?.email ? (
                    <>
                      {" as "}
                      <span className="font-medium text-foreground">
                        {status.email}
                      </span>
                    </>
                  ) : null}
                  {status?.subscriptionType
                    ? ` · ${planName(status.subscriptionType)} plan`
                    : null}
                </p>
                {!subscription ? (
                  <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                    Claude Code is signed in with an API key, so usage is billed
                    to that key. Sign in again to use your subscription.
                  </p>
                ) : null}
              </>
            ) : installed ? (
              <>
                <p>Start the sign-in, then finish it in your browser.</p>
                <CommandSnippet command="claude auth login" />
              </>
            ) : (
              <p>Available once Claude Code is installed.</p>
            )}
          </SetupStep>
          <SetupStep
            index={3}
            last
            state={credential && signedIn ? "done" : signedIn ? "current" : "pending"}
            title="Connect to Blame"
          >
            <p>
              Usage counts against your Claude plan limits.
              {isWindows()
                ? " On Windows, stories that run in the Blame runtime can't use Claude Code yet; Quick Chat can."
                : null}
            </p>
          </SetupStep>
        </ol>
      )}

      {error || status?.error ? (
        <p className="text-sm text-destructive">{error ?? status?.error}</p>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {credential ? (
            <Button
              type="button"
              variant="destructive"
              disabled={deleting || saving}
              onClick={disconnect}
            >
              {deleting ? <LoaderCircleIcon className="animate-spin" /> : <Trash2Icon />}
              Disconnect
            </Button>
          ) : null}
          {supported ? (
            <Button
              type="button"
              variant="ghost"
              disabled={checking}
              onClick={() => void check()}
            >
              <RefreshCwIcon className={cn(checking && "animate-spin")} />
              Check again
            </Button>
          ) : null}
        </div>
        <Button
          type="button"
          disabled={!supported || !signedIn || saving || deleting}
          onClick={connect}
        >
          {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
          {credential ? "Update connection" : "Connect Claude Code"}
        </Button>
      </div>
    </>
  )
}

function useClaudeCodeStatus(read: (() => Promise<ClaudeCodeStatus>) | undefined) {
  const [status, setStatus] = React.useState<ClaudeCodeStatus>()
  const [checking, setChecking] = React.useState(false)
  const inFlight = React.useRef(false)

  const check = React.useCallback(async () => {
    if (!read || inFlight.current) return
    inFlight.current = true
    setChecking(true)
    try {
      setStatus(await read())
    } catch (reason) {
      setStatus({
        installed: false,
        loggedIn: false,
        error: errorMessage(reason, "Unable to check Claude Code"),
      })
    } finally {
      inFlight.current = false
      setChecking(false)
    }
  }, [read])

  const ready = !!status?.installed && !!status.loggedIn

  React.useEffect(() => {
    const run = () => void check()
    const first = window.setTimeout(run, 0)
    window.addEventListener("focus", run)
    return () => {
      window.clearTimeout(first)
      window.removeEventListener("focus", run)
    }
  }, [check])

  // Keep watching while the user installs or signs in from a terminal.
  React.useEffect(() => {
    if (ready) return
    const timer = window.setInterval(() => void check(), statusPollMs)
    return () => window.clearInterval(timer)
  }, [check, ready])

  return { checking, check, status }
}

function SetupStep({
  children,
  index,
  last,
  state,
  title,
}: {
  children: React.ReactNode
  index: number
  last?: boolean
  state: StepState
  title: string
}) {
  return (
    <li className="grid grid-cols-[1.5rem_1fr] gap-x-3">
      <div className="flex flex-col items-center">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
            state === "done" && "border-primary bg-primary text-primary-foreground",
            state === "current" &&
              "border-primary text-primary ring-4 ring-primary/15 dark:border-indigo-300 dark:text-indigo-300",
            state === "pending" && "border-border text-muted-foreground"
          )}
        >
          {state === "done" ? <CheckIcon className="size-3.5" /> : index}
        </span>
        {last ? null : (
          <span
            className={cn(
              "my-1 w-px flex-1",
              state === "done" ? "bg-primary/40" : "bg-border"
            )}
          />
        )}
      </div>
      <div className={cn("grid min-w-0 gap-2", !last && "pb-5")}>
        <p
          className={cn(
            "pt-0.5 text-sm font-medium",
            state === "pending" && "text-muted-foreground"
          )}
        >
          {title}
          <span className="sr-only">
            {state === "done" ? " (done)" : state === "current" ? " (next)" : ""}
          </span>
        </p>
        <div className="grid gap-2 text-sm text-muted-foreground">{children}</div>
      </div>
    </li>
  )
}

function CommandSnippet({ command }: { command: string }) {
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1_500)
    return () => window.clearTimeout(timer)
  }, [copied])

  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/50 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
        {command}
      </code>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        onClick={() =>
          void navigator.clipboard.writeText(command).then(() => setCopied(true))
        }
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        <span className="sr-only">{copied ? "Copied" : "Copy command"}</span>
      </Button>
    </div>
  )
}

function GuideLink() {
  const platform = usePlatform()
  return (
    <button
      type="button"
      className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      onClick={() =>
        platform.openExternalLink
          ? platform.openExternalLink(setupGuideUrl)
          : window.open(setupGuideUrl, "_blank", "noopener,noreferrer")
      }
    >
      Other ways to install
      <ExternalLinkIcon className="size-3" />
    </button>
  )
}

function installCommand() {
  return isWindows()
    ? "irm https://claude.ai/install.ps1 | iex"
    : "curl -fsSL https://claude.ai/install.sh | bash"
}

function isWindows() {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
}

function planName(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback
}
