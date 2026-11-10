import * as React from "react"
import type {
  BlameProvider as Provider,
  ReasoningSelection,
} from "@blame/agent-runtime"
import {
  CheckIcon,
  CopyIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { toast } from "sonner"

import {
  ConnectProviderDialog,
  ProviderSelectDialog,
} from "@/components/model/connect-provider-dialog"
import {
  ModelTags,
  ProviderMark,
  modelDisplayName,
  modelReactKey,
} from "@/components/model/model-selector"
import {
  allProvidersValue,
  type ModelPreferenceRole,
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
import {
  dismissPremiumOffer,
  queuePremiumOffer,
} from "@/components/onboarding/onboarding-flow"
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress"
import { GlassPanel } from "@/components/onboarding/stage/glass-panel"
import { useOnboardingStage } from "@/components/onboarding/stage/onboarding-stage"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Kbd } from "@/components/ui/kbd"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useCloudAuth } from "@/context/cloud-auth"
import { useRovingFocus, useWizardKeys } from "@/lib/keyboard"
import { springSnappy, springSoft, stepVariants } from "@/lib/motion"
import { cn } from "@/lib/utils"

type SetupDialog =
  | { type: "providers" }
  | { type: "connect"; providerID: string }
  | undefined

type RoleSelection = {
  model?: SelectableModel
  variant?: string
}

const defaultVariant = "default"
const lastStep = 2

export function AiPreferencesSetupScreen() {
  const auth = useCloudAuth()
  const stage = useOnboardingStage()
  const selection = useModelSelection({ role: "agent" })
  const [alternative, setAlternative] = React.useState<RoleSelection>({})
  const [agent, setAgent] = React.useState<RoleSelection>({})
  const [dialog, setDialog] = React.useState<SetupDialog>()
  const [saving, setSaving] = React.useState(false)
  const [step, setStepState] = React.useState(0)
  const [direction, setDirection] = React.useState(1)
  const connected = selection.connectedProviderIDs.size > 0
  const ready = connected && alternative.model && agent.model
  const recommended = useRecommendedModels(selection)

  React.useEffect(() => {
    stage.setStepProgress(step / lastStep)
  }, [stage, step])

  function goTo(next: number) {
    const bounded = Math.min(Math.max(next, 0), lastStep)
    if (bounded === step) return
    setDirection(bounded > step ? 1 : -1)
    // Arrive on each model step with a sensible choice already made, so
    // Enter alone can carry someone through setup.
    if (bounded === 1 && !agent.model && recommended[0]) {
      setAgent({ model: recommended[0] })
    }
    if (bounded === 2 && !alternative.model && agent.model) {
      setAlternative({ model: agent.model, variant: agent.variant })
    }
    setStepState(bounded)
  }

  const canContinue = step === 0 ? connected : step === 1 ? !!agent.model : !!ready

  async function save() {
    if (auth.status !== "authenticated" || !ready || saving) return
    setSaving(true)
    const offerPremium = auth.mode === "account" && auth.license?.licensed !== true
    if (offerPremium) queuePremiumOffer()
    try {
      await auth.saveAiPreferences({
        alternativeModel: preferencePayload(alternative),
        agentModel: preferencePayload(agent),
      })
      stage.celebrate()
      toast.success("You're all set", {
        description: "Your models are ready.",
        position: "bottom-right",
      })
    } catch (error) {
      if (offerPremium) dismissPremiumOffer()
      toast.error("Unable to save AI preferences", {
        description:
          error instanceof Error ? error.message : "Please try again.",
        position: "bottom-right",
      })
      setSaving(false)
    }
  }

  function next() {
    if (!canContinue) return
    if (step < lastStep) goTo(step + 1)
    else void save()
  }

  // One rule for the keyboard: once a choice is made, focus lands on
  // Continue, so Enter always means "next".
  const continueRef = React.useRef<HTMLButtonElement>(null)
  const canContinueRef = React.useRef(canContinue)
  React.useEffect(() => {
    canContinueRef.current = canContinue
  })
  const focusContinue = React.useCallback(() => {
    requestAnimationFrame(() => continueRef.current?.focus())
  }, [])
  React.useEffect(() => {
    if (canContinueRef.current) focusContinue()
  }, [focusContinue, step])

  function pickAgent(value: RoleSelection) {
    setAgent(value)
    focusContinue()
  }

  function pickAlternative(value: RoleSelection) {
    setAlternative(value)
    focusContinue()
  }

  function handleDialogCloseAutoFocus(event: Event) {
    if (!canContinueRef.current) return
    event.preventDefault()
    focusContinue()
  }

  useWizardKeys({
    enabled: !dialog,
    onNext: next,
    onBack: step > 0 ? () => goTo(step - 1) : undefined,
  })

  return (
    <section className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 pt-10 pb-12">
      <OnboardingProgress
        step={step === 0 ? "provider" : "models"}
        className="mb-4"
      />
      <GlassPanel
        layout
        transition={{ layout: springSoft }}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <div className="relative min-h-[26rem] flex-1 overflow-hidden px-6 pt-5 pb-4">
          <AnimatePresence mode="wait" initial={false} custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              variants={stepVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              className="h-full"
            >
              {step === 0 ? (
                <ProviderStep
                  selection={selection}
                  onConnect={(providerID) =>
                    setDialog({ type: "connect", providerID })
                  }
                  onBrowse={() => setDialog({ type: "providers" })}
                />
              ) : step === 1 ? (
                <ModelStep
                  eyebrow="Step 2 of 3"
                  title="Pick your coding agent"
                  description="Plans, writes and verifies code. Choose your strongest model."
                  role="agent"
                  recommended={recommended}
                  selection={selection}
                  value={agent}
                  onChange={setAgent}
                  onPick={pickAgent}
                />
              ) : (
                <ModelStep
                  eyebrow="Step 3 of 3"
                  title="And one for everything else"
                  description="Project setup, titles and lighter tasks. A faster model works well."
                  role="alternative"
                  recommended={recommended}
                  selection={selection}
                  value={alternative}
                  onChange={setAlternative}
                  onPick={pickAlternative}
                  sameAs={agent.model ? agent : undefined}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-foreground/[0.06] bg-foreground/[0.02] px-6 py-3.5">
          <Button
            type="button"
            variant="ghost"
            className={cn(step === 0 && "invisible")}
            tabIndex={step === 0 ? -1 : undefined}
            onClick={() => goTo(step - 1)}
          >
            Back
            <Kbd className="ml-1 bg-foreground/[0.06]">Esc</Kbd>
          </Button>
          <Button
            ref={continueRef}
            type="button"
            disabled={!canContinue || saving}
            className="min-w-36 shadow-[0_10px_24px_-10px_var(--primary)] transition-[transform,box-shadow] duration-200 hover:-translate-y-px active:scale-[0.99]"
            onClick={next}
          >
            {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
            {step < lastStep ? "Continue" : "Finish setup"}
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

function StepHeader({
  description,
  eyebrow,
  title,
  action,
}: {
  description: string
  eyebrow: string
  title: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid gap-1">
        <p className="text-xs font-semibold text-primary dark:text-indigo-300">{eyebrow}</p>
        <h1 className="font-heading text-2xl font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-foreground/60">{description}</p>
      </div>
      {action}
    </div>
  )
}

function ProviderStep({
  onBrowse,
  onConnect,
  selection,
}: {
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
      <StepHeader
        eyebrow="Step 1 of 3"
        title="Connect your AI provider"
        description="Blame runs on your own credentials. Your provider bills you directly."
        action={
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
        }
      />
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
                Continue to choose your models.
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
    </div>
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

function ModelStep({
  description,
  eyebrow,
  onChange,
  onPick,
  recommended,
  role,
  sameAs,
  selection,
  title,
  value,
}: {
  description: string
  eyebrow: string
  onChange: (value: RoleSelection) => void
  // A deliberate choice (card, list or shortcut): also moves focus on.
  onPick: (value: RoleSelection) => void
  recommended: SelectableModel[]
  role: ModelPreferenceRole
  sameAs?: RoleSelection
  selection: ModelSelection
  title: string
  value: RoleSelection
}) {
  const selectedKey = value.model ? modelReactKey(value.model) : undefined
  const handleKeyDown = useRovingFocus(3)
  const picks = recommended.slice(0, 3)

  return (
    <div className="grid content-start gap-3">
      <StepHeader eyebrow={eyebrow} title={title} description={description} />
      {picks.length > 0 ? (
        <div className="grid gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground/55">
            Recommended for you
          </span>
          <div
            role="radiogroup"
            aria-label="Recommended models"
            className="grid gap-2 sm:grid-cols-3"
            onKeyDown={handleKeyDown}
          >
            {picks.map((model, index) => {
              const selected = modelReactKey(model) === selectedKey
              return (
                <motion.button
                  key={modelReactKey(model)}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-roving-item
                  autoFocus={!selectedKey && index === 0}
                  whileHover={{ y: -2 }}
                  whileTap={{ scale: 0.98 }}
                  className={cn(
                    "relative flex min-w-0 flex-col items-start gap-2 rounded-2xl border border-foreground/[0.08] bg-background/55 p-3 text-left outline-none transition-[border-color,background-color] duration-200 hover:bg-background/90 focus-visible:ring-3 focus-visible:ring-primary/25",
                    selected && "border-transparent"
                  )}
                  onClick={() => onPick({ model })}
                >
                  {selected ? (
                    <motion.span
                      layoutId={`model-pick-${role}`}
                      transition={springSnappy}
                      className="absolute inset-0 rounded-2xl border-2 border-primary bg-primary/[0.07]"
                    />
                  ) : null}
                  <span className="relative flex w-full items-center justify-between gap-2">
                    <ProviderMark provider={model.provider} />
                    {index === 0 ? (
                      <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                        Top pick
                      </span>
                    ) : (
                      <ModelTags model={model} />
                    )}
                  </span>
                  <span className="relative grid w-full min-w-0 gap-0.5">
                    <span className="truncate text-sm font-semibold">
                      {modelDisplayName(model)}
                    </span>
                    <span className="truncate text-[11px] text-foreground/50">
                      {model.provider.name}
                    </span>
                  </span>
                </motion.button>
              )
            })}
          </div>
        </div>
      ) : null}
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-foreground/55">All models</span>
          {sameAs?.model ? (
            <Button
              variant="ghost"
              size="xs"
              className="text-xs"
              onClick={() => onPick({ ...sameAs })}
            >
              <CopyIcon /> Same as coding agent
            </Button>
          ) : null}
        </div>
        <Command className="min-h-0 rounded-2xl border border-foreground/[0.08] bg-background/55">
          <CommandInput placeholder="Search models" />
          <CommandList className="h-28 max-h-28 overscroll-contain">
            <CommandEmpty>{selection.emptyMessage}</CommandEmpty>
            {selection.providerGroups.map((group) => (
              <CommandGroup
                key={`${role}-${group.provider.id}`}
                heading={group.provider.name}
              >
                {group.models.map((model) => (
                  <CommandItem
                    key={`${role}-${modelReactKey(model)}`}
                    value={`${model.provider.name} ${model.name} ${model.id}`}
                    onSelect={() => onPick({ model })}
                  >
                    <ProviderMark provider={model.provider} />
                    <span className="min-w-0 flex-1 truncate">
                      {modelDisplayName(model)}
                    </span>
                    <ModelTags model={model} />
                    {modelReactKey(model) === selectedKey ? (
                      <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={springSnappy}>
                        <CheckIcon className="size-4 text-primary dark:text-indigo-300" />
                      </motion.span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </div>
      <SelectedModel value={value} onChange={onChange} />
    </div>
  )
}

function SelectedModel({
  onChange,
  value,
}: {
  onChange: (value: RoleSelection) => void
  value: RoleSelection
}) {
  return (
    <div className="flex min-h-10 min-w-0 items-center gap-3 rounded-xl bg-foreground/[0.04] px-3 py-1.5">
      <span className="text-xs font-medium text-foreground/50">Selected</span>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value.model ? modelReactKey(value.model) : "none"}
          initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
          transition={{ duration: 0.25 }}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          {value.model ? <ProviderMark provider={value.model.provider} /> : null}
          <span className="min-w-0 truncate text-sm font-semibold">
            {value.model ? modelDisplayName(value.model) : "No model selected"}
          </span>
        </motion.span>
      </AnimatePresence>
      <VariantSelect value={value} onChange={onChange} />
    </div>
  )
}

function VariantSelect({
  onChange,
  value,
}: {
  onChange: (value: RoleSelection) => void
  value: RoleSelection
}) {
  const variants = [defaultVariant, ...Object.keys(value.model?.variants ?? {})]
  if (variants.length <= 1) return null

  return (
    <Select
      value={value.variant ?? defaultVariant}
      onValueChange={(variant) =>
        onChange({
          ...value,
          variant: variant === defaultVariant ? undefined : variant,
        })
      }
    >
      <SelectTrigger
        aria-label="Reasoning effort"
        className="h-7 w-auto max-w-36 border-0 bg-background/70 px-2 text-xs shadow-none"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {variants.map((variant) => (
          <SelectItem key={variant} value={variant} className="capitalize">
            {variantLabel(variant)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function useRecommendedModels(selection: ModelSelection) {
  return selection
    .recommendedModels(allProvidersValue)
    .map((recommendation) => recommendation.model)
    .filter((model) => selection.connectedProviderIDs.has(model.provider.id))
}

function preferencePayload(value: RoleSelection) {
  return {
    providerId: value.model!.provider.id,
    modelId: value.model!.id,
    credentialLabel: value.model!.credentialLabel ?? null,
    reasoningEffort: reasoningEffort(value.variant),
  }
}

function reasoningEffort(value: string | undefined): ReasoningSelection | null {
  if (
    value === "none" ||
    value === "enabled" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value
  }
  return null
}

function variantLabel(variant: string) {
  if (variant === defaultVariant) return "Default"
  if (variant === "xhigh") return "X High"
  return variant.charAt(0).toUpperCase() + variant.slice(1)
}
