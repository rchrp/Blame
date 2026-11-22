import * as React from "react"
import { toast } from "sonner"

import {
  budgetDollars,
  budgetMicroUsd,
  epicModelRange,
  type Epic,
  type EpicSettings,
} from "@/components/orchestrator/data/epic-data"
import {
  orchestratorModel,
  orchestratorPreference,
  useEpicModels,
} from "@/components/orchestrator/data/use-epic-models"
import { EpicModelRangeField } from "@/components/orchestrator/epic-model-range-field"
import { ModelSelector, ProviderIcon } from "@/components/model/model-selector"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { Switch } from "@/components/ui/switch"
import type { CloudAiModelPreference } from "@/context/cloud-auth"
import { cn } from "@/lib/utils"

type Draft = {
  askBeforeLaunch: boolean
  budget: string
  orchestrator: CloudAiModelPreference | null
  providers: string[]
  range: { min: number; max: number }
}

function draftOf(settings: EpicSettings): Draft {
  return {
    askBeforeLaunch: settings.askBeforeLaunch ?? false,
    budget: budgetDollars(settings.budgetMicroUsd),
    orchestrator: orchestratorPreference(settings.orchestratorModel),
    providers: settings.providers ?? [],
    range: epicModelRange(settings),
  }
}

export function EpicSettingsDialog({
  epic,
  open,
  onOpenChange,
  onSave,
}: {
  epic: Epic
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (settings: EpicSettings) => Promise<unknown>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(88svh,46rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        {open ? (
          <EpicSettingsForm
            epic={epic}
            onDone={() => onOpenChange(false)}
            onSave={onSave}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function EpicSettingsForm({
  epic,
  onDone,
  onSave,
}: {
  epic: Epic
  onDone: () => void
  onSave: (settings: EpicSettings) => Promise<unknown>
}) {
  const models = useEpicModels()
  const [draft, setDraft] = React.useState(() => draftOf(epic.settings))
  const [saving, setSaving] = React.useState(false)
  const hidden = models.hiddenModels()
  const budgetInvalid =
    draft.budget.trim() !== "" && budgetMicroUsd(draft.budget) === undefined
  const change = (patch: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...patch }))

  async function save() {
    if (budgetInvalid) return
    // The whole object: a PATCH replaces it, other keys are kept as read.
    const {
      budgetMicroUsd: _budget,
      orchestratorModel: _model,
      ...kept
    } = epic.settings
    void _budget
    void _model
    const budget = budgetMicroUsd(draft.budget)
    const settings: EpicSettings = {
      ...kept,
      askBeforeLaunch: draft.askBeforeLaunch,
      hiddenModels: hidden,
      modelRange: draft.range,
      providers: draft.providers,
      ...(budget === undefined ? {} : { budgetMicroUsd: budget }),
      ...(draft.orchestrator
        ? { orchestratorModel: orchestratorModel(draft.orchestrator) }
        : {}),
    }
    setSaving(true)
    try {
      await onSave(settings)
      onDone()
    } catch (error) {
      toast.error("Unable to save the epic's settings", {
        description: error instanceof Error ? error.message : String(error),
        position: "bottom-right",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
        <DialogTitle>Epic settings</DialogTitle>
        <DialogDescription>
          What the orchestrator may use and spend on {epic.title}.
        </DialogDescription>
      </DialogHeader>
      <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto overscroll-contain px-5 py-5">
        <Section
          title="Models for stories"
          description="For each story the orchestrator picks Cheaper, Balanced or Smarter, inside this range."
        >
          <EpicModelRangeField
            hidden={hidden}
            modelName={models.modelName}
            providers={draft.providers}
            range={draft.range}
            recommendations={models.recommendations}
            onChange={(range) => change({ range })}
          />
        </Section>
        <Section
          title="Providers"
          description={
            draft.providers.length
              ? "Stories only run on the providers selected."
              : "Stories may run on any connected provider. Select some to keep to them."
          }
        >
          <div className="flex flex-wrap gap-2">
            {models.connectedProviders.map((provider) => {
              const selected = draft.providers.includes(provider.id)
              return (
                <button
                  key={provider.id}
                  aria-pressed={selected}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    selected
                      ? "border-primary bg-primary/10 text-foreground"
                      : "bg-background text-muted-foreground hover:text-foreground"
                  )}
                  type="button"
                  onClick={() =>
                    change({
                      providers: selected
                        ? draft.providers.filter((id) => id !== provider.id)
                        : [...draft.providers, provider.id],
                    })
                  }
                >
                  <ProviderIcon providerId={provider.id} />
                  {provider.name}
                </button>
              )
            })}
          </div>
        </Section>
        <Section
          title="The orchestrator's model"
          description="The model the orchestrator itself plans and reviews with."
        >
          <div className="w-fit max-w-full">
            <ModelSelector
              role="agent"
              scope={{
                preference: draft.orchestrator,
                onChange: (orchestrator) => change({ orchestrator }),
              }}
            />
          </div>
        </Section>
        <Section
          title="Budget"
          description="Stories and the orchestrator together. Once it is spent, the orchestrator starts nothing new."
        >
          <InputGroup className="max-w-48" data-invalid={budgetInvalid}>
            <InputGroupAddon>
              <InputGroupText>$</InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              aria-invalid={budgetInvalid}
              aria-label="Budget in dollars"
              inputMode="decimal"
              placeholder="No limit"
              value={draft.budget}
              onChange={(event) => change({ budget: event.target.value })}
            />
          </InputGroup>
          {budgetInvalid ? (
            <p className="text-sm text-destructive">
              Type an amount in dollars, or leave it empty for no limit.
            </p>
          ) : null}
        </Section>
        <label className="flex items-start justify-between gap-4 rounded-lg border p-3">
          <span className="grid gap-0.5">
            <span className="text-sm font-medium">Ask me before launching</span>
            <span className="text-sm text-muted-foreground">
              Starting stories and merging them wait for your Allow.
            </span>
          </span>
          <Switch
            checked={draft.askBeforeLaunch}
            onCheckedChange={(askBeforeLaunch) => change({ askBeforeLaunch })}
          />
        </label>
      </div>
      <DialogFooter className="mx-0 mb-0 shrink-0 gap-2 rounded-b-xl bg-muted/30 px-5 py-4">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || budgetInvalid}>
          Save
        </Button>
      </DialogFooter>
    </form>
  )
}

function Section({
  children,
  description,
  title,
}: {
  children: React.ReactNode
  description: string
  title: string
}) {
  return (
    <section className="grid gap-3">
      <div className="grid gap-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  )
}
