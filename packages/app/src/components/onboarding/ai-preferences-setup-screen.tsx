import * as React from "react"
import type { BlameProvider as Provider, ReasoningSelection } from "@blame/agent-runtime"
import { CheckIcon, LoaderCircleIcon, PlusIcon, RefreshCwIcon } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { toast } from "sonner"

import {
  type AutoModelChoice,
  chooseAutoModels,
  supportedVariant,
} from "@/components/model/auto-model-choice"
import {
  ConnectProviderDialog,
  ProviderSelectDialog,
} from "@/components/model/connect-provider-dialog"
import { ProviderMark, modelDisplayName } from "@/components/model/model-selector"
import {
  allProvidersValue,
  recommendedApiKeyProviders,
  subscriptionProviders,
  type ModelSelection,
  type SelectableModel,
  useModelSelection,
} from "@/components/model/model-selection"
import { ProviderAccessBadge } from "@/components/model/provider-access-badge"
import {
  groupProviders,
  type ProviderGroup,
  type ProviderGroupID,
} from "@/components/model/provider-groups"
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress"
import { GlassPanel } from "@/components/onboarding/stage/glass-panel"
import { useOnboardingStage } from "@/components/onboarding/stage/onboarding-stage"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { useCloudAuth } from "@/context/cloud-auth"
import { useWizardKeys } from "@/lib/keyboard"
import { springSnappy, springSoft } from "@/lib/motion"
import { cn } from "@/lib/utils"

type SetupDialog =
  | { type: "providers" }
  | { type: "connect"; providerID: string }
  | undefined

// Connect a provider, and Blame picks the models: the coding agent and the
// alternative model are chosen from what Smart Selection ranks (see
// `chooseAutoModels`). Both stay changeable afterwards, in a story's model
// picker and in Settings.
export function AiPreferencesSetupScreen() {
  const auth = useCloudAuth()
  const stage = useOnboardingStage()
  const selection = useModelSelection({ role: "agent" })
  const [dialog, setDialog] = React.useState<SetupDialog>()
  const [saving, setSaving] = React.useState(false)
  const connected = selection.connectedProviderIDs.size > 0
  const choice = chooseAutoModels(
    selection
      .recommendedModels(allProvidersValue)
      .map((candidate) => ({
        ...candidate,
        outputPrice: candidate.model.cost.output,
      })),
    selection.currentModel
  )
  const canContinue = connected && !!choice && !selection.loading

  React.useEffect(() => {
    stage.setStepProgress(saving ? 1 : connected ? 0.5 : 0)
  }, [stage, connected, saving])

  async function save() {
    if (auth.status !== "authenticated" || !choice || saving) return
    setSaving(true)
    try {
      await auth.saveAiPreferences({
        agentModel: preferencePayload(choice.agent, choice.agentVariant),
        alternativeModel: preferencePayload(
          choice.alternative,
          choice.alternativeVariant
        ),
      })
      stage.celebrate()
      toast.success("You're all set", {
        description: "Blame picked your models. Change them anytime in Settings.",
        position: "bottom-right",
      })
    } catch (error) {
      toast.error("Unable to save AI preferences", {
        description:
          error instanceof Error ? error.message : "Please try again.",
        position: "bottom-right",
      })
      setSaving(false)
    }
  }

  function next() {
    if (canContinue) void save()
  }

  // Once a provider is connected, focus lands on Continue, so Enter always
  // means "next".
  const continueRef = React.useRef<HTMLButtonElement>(null)
  const canContinueRef = React.useRef(canContinue)
  React.useEffect(() => {
    canContinueRef.current = canContinue
  })
  const focusContinue = React.useCallback(() => {
    requestAnimationFrame(() => continueRef.current?.focus())
  }, [])

  function handleDialogCloseAutoFocus(event: Event) {
    if (!canContinueRef.current) return
    event.preventDefault()
    focusContinue()
  }

  useWizardKeys({ enabled: !dialog, onNext: next })

  return (
    <section className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 pt-10 pb-12">
      <OnboardingProgress step="provider" className="mb-4" />
      <GlassPanel
        layout
        transition={{ layout: springSoft }}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <div className="relative min-h-[26rem] flex-1 overflow-hidden px-6 pt-5 pb-4">
          <ProviderStep
            selection={selection}
            choice={choice}
            onConnect={(providerID) =>
              setDialog({ type: "connect", providerID })
            }
            onBrowse={() => setDialog({ type: "providers" })}
          />
        </div>
        <footer className="flex items-center justify-end gap-3 border-t border-foreground/[0.06] bg-foreground/[0.02] px-6 py-3.5">
          <Button
            ref={continueRef}
            type="button"
            disabled={!canContinue || saving}
            className="min-w-36 shadow-[0_10px_24px_-10px_var(--primary)] transition-[transform,box-shadow] duration-200 hover:-translate-y-px active:scale-[0.99]"
            onClick={next}
          >
            {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
            Finish setup
            <Kbd className="ml-1 bg-primary-foreground/15 text-primary-foreground/80">↵</Kbd>
          </Button>
        </footer>
      </GlassPanel>
      <ProviderSelectDialog
        open={dialog?.type === "providers"}
        selection={selection}
        onCloseAutoFocus={handleDialogCloseAutoFocus}
        onConnect={(providerID) => setDialog({ type: "connect", providerID })}
        onOpenChange={(open) =>
          setDialog(open ? { type: "providers" } : undefined)
        }
      />
      <ConnectProviderDialog
        providerID={dialog?.type === "connect" ? dialog.providerID : undefined}
        selection={selection}
        onBack={() => setDialog({ type: "providers" })}
        onCloseAutoFocus={handleDialogCloseAutoFocus}
        onOpenChange={(open) => {
          if (!open) setDialog(undefined)
        }}
      />
    </section>
  )
}

function ProviderStep({
  choice,
  onBrowse,
  onConnect,
  selection,
}: {
  choice: AutoModelChoice<SelectableModel> | undefined
  onBrowse(): void
  onConnect(providerID: string): void
  selection: ModelSelection
}) {
  const groups = groupProviders(selection.allProviders)
  const subscriptions = providerGroup(groups, "subscription")
  const apiKeys = providerGroup(groups, "api-keys")
  const moreCount = providerGroup(groups, "more").length
  const connectedCount = selection.connectedProviderIDs.size
  const loading = subscriptions.length + apiKeys.length === 0

  function tile(provider: Provider, index: number, variant: TileVariant) {
    return (
      <ProviderTile
        key={provider.id}
        provider={provider}
        index={index}
        variant={variant}
        autoFocus={index === 0 && connectedCount === 0}
        connected={selection.connectedProviderIDs.has(provider.id)}
        onConnect={onConnect}
      />
    )
  }

  return (
    <div className="grid content-start gap-5" onKeyDown={moveProviderFocus}>
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="font-heading text-2xl font-bold tracking-tight">
            Connect your AI provider
          </h1>
          <p className="text-sm text-foreground/60">
            Blame runs on your own credentials. Your provider bills you directly.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void selection.refreshProviders()}
          disabled={selection.loading}
          aria-label="Refresh providers"
        >
          <RefreshCwIcon className={cn(selection.loading && "animate-spin")} />
          Refresh
        </Button>
      </div>
      <ProviderSection label="Use your subscription" className="sm:grid-cols-2">
        {loading
          ? tileSkeletons(subscriptionProviders.length, "subscription")
          : subscriptions.map((provider, index) =>
              tile(provider, index, "subscription")
            )}
      </ProviderSection>
      <ProviderSection label="API keys" className="grid-cols-2 sm:grid-cols-4">
        {loading
          ? tileSkeletons(recommendedApiKeyProviders.length, "api-key")
          : apiKeys.map((provider, index) =>
              tile(provider, subscriptions.length + index, "api-key")
            )}
      </ProviderSection>
      <div className="grid gap-1">
        <div className="flex min-h-8 items-center justify-between gap-3">
          <AnimatePresence initial={false} mode="wait">
            <motion.p
              key={connectedCount > 0 ? "connected" : "empty"}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="text-sm text-foreground/60"
            >
              {connectedCount > 0 ? (
                <>
                  <span className="font-medium text-foreground">
                    {connectedCount} provider{connectedCount > 1 ? "s" : ""} connected.
                  </span>{" "}
                  Change the models Blame picks anytime in Settings.
                </>
              ) : (
                "Use the arrow keys to move between providers, Enter to connect."
              )}
            </motion.p>
          </AnimatePresence>
          {moreCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-roving-item
              className="shrink-0 text-foreground/70"
              onClick={onBrowse}
            >
              <PlusIcon />
              {moreCount} more provider{moreCount > 1 ? "s" : ""}
            </Button>
          ) : null}
        </div>
        <AnimatePresence initial={false}>
          {choice ? <ChosenModels choice={choice} /> : null}
        </AnimatePresence>
      </div>
    </div>
  )
}

function ChosenModels({ choice }: { choice: AutoModelChoice<SelectableModel> }) {
  const rows = [
    { label: "Coding agent", model: choice.agent },
    { label: "Everything else", model: choice.alternative },
  ]
  return (
    <motion.dl
      aria-label="Models Blame picked"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={springSoft}
      className="flex flex-wrap items-center gap-x-6 gap-y-1.5"
    >
      {rows.map(({ label, model }) => (
        <div key={label} className="flex min-w-0 items-center gap-2">
          <ProviderMark provider={model.provider} />
          <dt className="text-xs text-foreground/50">{label}</dt>
          <dd className="truncate text-sm font-semibold">
            {modelDisplayName(model)}
          </dd>
        </div>
      ))}
    </motion.dl>
  )
}

type TileVariant = "subscription" | "api-key"

function ProviderSection({
  children,
  className,
  label,
}: {
  children: React.ReactNode
  className: string
  label: string
}) {
  return (
    <div className="grid gap-2">
      <span className="text-xs font-semibold text-foreground/55">{label}</span>
      <div role="group" aria-label={label} className={cn("grid gap-2.5", className)}>
        {children}
      </div>
    </div>
  )
}

function ProviderTile({
  autoFocus,
  connected,
  index,
  onConnect,
  provider,
  variant,
}: {
  autoFocus: boolean
  connected: boolean
  index: number
  onConnect(providerID: string): void
  provider: Provider
  variant: TileVariant
}) {
  const status = (
    <span className="text-[11px] text-foreground/50">
      {connected ? "Connected · Manage" : "Connect"}
    </span>
  )
  const check = (
    <AnimatePresence>
      {connected ? (
        <motion.span
          initial={{ scale: 0, rotate: -45 }}
          animate={{ scale: 1, rotate: 0 }}
          exit={{ scale: 0 }}
          transition={springSnappy}
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
        >
          <CheckIcon className="size-3" strokeWidth={3} />
        </motion.span>
      ) : null}
    </AnimatePresence>
  )

  return (
    <motion.button
      type="button"
      data-roving-item
      autoFocus={autoFocus}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.03 * index, ...springSoft }}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.97 }}
      className={cn(
        "group relative flex rounded-2xl border border-foreground/[0.08] bg-background/55 p-3 text-left outline-none transition-[border-color,background-color,box-shadow] duration-200 hover:border-primary/30 hover:bg-background/90 hover:shadow-[0_12px_28px_-16px_var(--primary)] focus-visible:border-primary/50 focus-visible:ring-3 focus-visible:ring-primary/25",
        variant === "subscription"
          ? "h-[4.25rem] items-center gap-3"
          : "h-[5.5rem] flex-col items-start justify-between",
        connected && "border-primary/40 bg-primary/[0.06]"
      )}
      onClick={() => onConnect(provider.id)}
    >
      {variant === "subscription" ? (
        <>
          <span className="flex size-8 shrink-0 items-center justify-center">
            <span className="scale-125">
              <ProviderMark provider={provider} />
            </span>
          </span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-sm font-semibold">{provider.name}</span>
            {status}
          </span>
          <ProviderAccessBadge providerID={provider.id} />
          {check}
        </>
      ) : (
        <>
          <span className="flex w-full items-start justify-between">
            <span className="origin-top-left scale-125">
              <ProviderMark provider={provider} />
            </span>
            {check}
          </span>
          <span className="grid w-full gap-0.5">
            <span className="truncate text-sm font-semibold">{provider.name}</span>
            {status}
          </span>
        </>
      )}
    </motion.button>
  )
}

function tileSkeletons(count: number, variant: TileVariant) {
  return Array.from({ length: count }, (_, index) => (
    <div
      key={index}
      className={cn(
        "animate-pulse rounded-2xl bg-foreground/[0.05]",
        variant === "subscription" ? "h-[4.25rem]" : "h-[5.5rem]"
      )}
      style={{ animationDelay: `${index * 80}ms` }}
    />
  ))
}

function providerGroup(groups: ProviderGroup[], id: ProviderGroupID) {
  return groups.find((group) => group.id === id)?.providers ?? []
}

/**
 * Arrow keys across the tiles. The sections have different column counts,
 * so up and down pick the closest tile in the next row on screen.
 */
function moveProviderFocus(event: React.KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]
  if (!keys.includes(event.key) || event.altKey) return
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>("[data-roving-item]:not([disabled])")
  )
  const current = document.activeElement as HTMLElement
  const index = items.indexOf(current)
  if (index === -1) return
  event.preventDefault()
  if (event.key === "Home") return items[0]?.focus()
  if (event.key === "End") return items.at(-1)?.focus()
  if (event.key === "ArrowRight") return items[Math.min(index + 1, items.length - 1)]?.focus()
  if (event.key === "ArrowLeft") return items[Math.max(index - 1, 0)]?.focus()

  const from = current.getBoundingClientRect()
  const down = event.key === "ArrowDown"
  const centerX = (rect: DOMRect) => rect.left + rect.width / 2
  const candidates = items
    .map((item) => ({ item, rect: item.getBoundingClientRect() }))
    .filter(({ rect }) => (down ? rect.top >= from.bottom - 1 : rect.bottom <= from.top + 1))
  if (!candidates.length) return
  const rowTop = down
    ? Math.min(...candidates.map(({ rect }) => rect.top))
    : Math.max(...candidates.map(({ rect }) => rect.top))
  const row = candidates.filter(({ rect }) => Math.abs(rect.top - rowTop) < 2)
  row.sort(
    (a, b) =>
      Math.abs(centerX(a.rect) - centerX(from)) - Math.abs(centerX(b.rect) - centerX(from))
  )
  row[0]?.item.focus()
}

function preferencePayload(
  model: SelectableModel,
  variant: ReasoningSelection | undefined
) {
  return {
    providerId: model.provider.id,
    modelId: model.id,
    credentialLabel: model.credentialLabel ?? null,
    reasoningEffort: supportedVariant(model.variants, variant),
  }
}
