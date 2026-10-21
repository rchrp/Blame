import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  InfoIcon,
  PlusIcon,
  SlidersHorizontalIcon,
} from "lucide-react"
import * as React from "react"
import type { BlameProvider as Provider, ProviderCredentialSummary } from "@blame/agent-runtime"

import {
  ConnectProviderDialog,
  ProviderSelectDialog,
} from "@/components/model/connect-provider-dialog"
import { ManageModelsDialog } from "@/components/model/manage-models-dialog"
import { iconNames, type IconName } from "@/components/provider-icons/types"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  allProvidersValue,
  credentialLabel,
  defaultCredentialLabel,
  defaultVariant,
  getVariantLabel,
  isModelSelected,
  type ModelGroup,
  type ModelPreferenceRole,
  type ModelSelection,
  type ModelSelectionScope,
  openAICompatibleProviderID,
  type RecommendedSelectableModel,
  type SelectableModel,
  useModelSelection,
} from "./model-selection"
const providerIconSprite = new URL(
  "../provider-icons/sprite.svg",
  import.meta.url
).href
const providerIconAliases: Partial<Record<string, IconName>> = {
  "claude-code": "anthropic",
  gemini: "google",
  vertex: "google-vertex",
  "openai-codex": "openai",
  "openai-native": "openai",
}
type ModelDialog =
  | { type: "providers" }
  | { type: "connect"; providerID: string }
  | { type: "manage" }
  | undefined
type WheelDirection = -1 | 1

export function ModelSelector({
  modelTriggerClassName,
  role,
  scope,
}: {
  modelTriggerClassName?: string
  role?: ModelPreferenceRole
  scope?: ModelSelectionScope
}) {
  const selection = useModelSelection({ role, scope })
  const [dialog, setDialog] = React.useState<ModelDialog>()

  return (
    <>
      <ModelPicker
        modelTriggerClassName={modelTriggerClassName}
        selection={selection}
        setDialog={setDialog}
      />
      <ProviderSelectDialog
        open={dialog?.type === "providers"}
        selection={selection}
        onConnect={(providerID) => setDialog({ type: "connect", providerID })}
        onOpenChange={(open) =>
          setDialog(open ? { type: "providers" } : undefined)
        }
      />
      <ConnectProviderDialog
        providerID={dialog?.type === "connect" ? dialog.providerID : undefined}
        selection={selection}
        onBack={() => setDialog({ type: "providers" })}
        onOpenChange={(open) => {
          if (!open) setDialog(undefined)
        }}
      />
      <ManageModelsDialog
        open={dialog?.type === "manage"}
        selection={selection}
        onConnectProvider={() => setDialog({ type: "providers" })}
        onOpenChange={(open) =>
          setDialog(open ? { type: "manage" } : undefined)
        }
      />
    </>
  )
}

function ModelPicker({
  modelTriggerClassName,
  selection,
  setDialog,
}: {
  modelTriggerClassName?: string
  selection: ModelSelection
  setDialog: (dialog: ModelDialog) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [advanced, setAdvanced] = React.useState(false)
  const [providerID, setProviderID] = React.useState(allProvidersValue)
  const onWheel = useWheelStep((direction) => {
    const model = advanced
      ? adjacentManualModel(selection, providerID, direction)
      : adjacentSmartModel(
          selection,
          providerID,
          reverseWheelDirection(direction)
        )
    if (model) selectModelWithoutWaiting(selection, model)
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="flex w-full min-w-0 items-center justify-end gap-2">
          <ModelPickerTrigger
            className={modelTriggerClassName}
            open={open}
            selection={selection}
            onWheel={onWheel}
          />
          <ModelVariantSelector selection={selection} />
        </div>
      </PopoverAnchor>
      <ModelPickerContent
        advanced={advanced}
        providerID={providerID}
        selection={selection}
        setAdvanced={setAdvanced}
        setDialog={setDialog}
        setOpen={setOpen}
        setProviderID={setProviderID}
      />
    </Popover>
  )
}

function useWheelStep<Element extends HTMLElement = HTMLButtonElement>(
  onStep: (direction: WheelDirection) => void
): React.WheelEventHandler<Element> {
  const lastStepAt = React.useRef(-Infinity)
  return React.useCallback(
    (event) => {
      if (event.deltaY === 0) return
      event.preventDefault()
      event.stopPropagation()
      if (event.timeStamp - lastStepAt.current < 80) return
      lastStepAt.current = event.timeStamp
      onStep(event.deltaY > 0 ? 1 : -1)
    },
    [onStep]
  )
}

function reverseWheelDirection(direction: WheelDirection): WheelDirection {
  return direction === 1 ? -1 : 1
}

function ModelPickerTrigger({
  className,
  onWheel,
  open,
  selection,
}: {
  className?: string
  onWheel: React.WheelEventHandler<HTMLButtonElement>
  open: boolean
  selection: ModelSelection
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            className={cn(
              "h-8 w-0 max-w-52 min-w-0 flex-1 justify-center rounded-xl border-0 bg-muted/70 px-3 shadow-none hover:bg-muted aria-expanded:bg-muted",
              className
            )}
            disabled={!selection.serverReady || selection.loading}
            onWheel={onWheel}
          >
            <ModelSummary model={selection.currentModel} />
            {open ? (
              <ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
          </Button>
        </PopoverTrigger>
      </TooltipTrigger>
      <TooltipContent side="left">Choose model</TooltipContent>
    </Tooltip>
  )
}

type ModelPickerContentProps = {
  advanced: boolean
  providerID: string
  selection: ModelSelection
  setAdvanced: (value: boolean) => void
  setDialog: (dialog: ModelDialog) => void
  setOpen: (value: boolean) => void
  setProviderID: (value: string) => void
}

function ModelPickerContent(props: ModelPickerContentProps) {
  return (
    <PopoverContent
      align="end"
      side="top"
      sideOffset={10}
      collisionPadding={12}
      className="w-96 overflow-hidden rounded-2xl p-0 shadow-xl ring-foreground/8"
      onWheel={(event) => event.stopPropagation()}
    >
      <ModelPickerPanel {...props} />
    </PopoverContent>
  )
}

type ModelPickerPanelProps = {
  advanced: boolean
  providerID: string
  selection: ModelSelection
  setAdvanced: (value: boolean) => void
  setDialog: (dialog: ModelDialog) => void
  setOpen: (value: boolean) => void
  setProviderID: (value: string) => void
}

function ModelPickerPanel({
  advanced,
  providerID,
  selection,
  setAdvanced,
  setDialog,
  setOpen,
  setProviderID,
}: ModelPickerPanelProps) {
  const openDialog = (type: "providers" | "manage") => {
    setOpen(false)
    setDialog({ type })
  }
  return (
    <div className="space-y-4 p-5">
      <ModelPickerHeader
        providerID={providerID}
        selection={selection}
        setProviderID={setProviderID}
        onConnect={() => openDialog("providers")}
        onManage={() => openDialog("manage")}
      />
      <ModelPickerMode
        advanced={advanced}
        providerID={providerID}
        selection={selection}
      />
      <ModelPickerBottomBar advanced={advanced} onChange={setAdvanced} />
    </div>
  )
}

function ModelPickerHeader({
  onConnect,
  onManage,
  providerID,
  selection,
  setProviderID,
}: {
  onConnect: () => void
  onManage: () => void
  providerID: string
  selection: ModelSelection
  setProviderID: (value: string) => void
}) {
  return (
    <div className="group/provider-header flex min-h-9 items-center justify-between gap-2">
      <ProviderFilter
        providerID={providerID}
        selection={selection}
        setProviderID={setProviderID}
      />
      <ModelPickerActions onConnect={onConnect} onManage={onManage} />
    </div>
  )
}

function ModelPickerMode({
  advanced,
  providerID,
  selection,
}: Pick<ModelPickerPanelProps, "advanced" | "providerID" | "selection">) {
  if (advanced) {
    return <AdvancedModelPicker providerID={providerID} selection={selection} />
  }
  return (
    <SmartModelSlider
      key={providerID}
      providerID={providerID}
      selection={selection}
    />
  )
}

function ModelPickerBottomBar({
  advanced,
  onChange,
}: {
  advanced: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-end">
      <ModelPickerModeToggle advanced={advanced} onChange={onChange} />
    </div>
  )
}

function ModelPickerModeToggle({
  advanced,
  onChange,
}: {
  advanced: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      className="block text-sm text-muted-foreground transition-colors hover:text-foreground"
      type="button"
      onClick={() => onChange(!advanced)}
    >
      {advanced ? "Smart selection" : "Manual selection"}
    </button>
  )
}

type ProviderFilterProps = {
  providerID: string
  selection: ModelSelection
  setProviderID: (value: string) => void
}

function ProviderFilter({
  providerID,
  selection,
  setProviderID,
}: ProviderFilterProps) {
  const [open, setOpen] = React.useState(false)
  const choices = providerChoices(selection)
  const selected = selectedProviderChoice(choices, providerID, selection)
  const select = (choice: ProviderChoice) => {
    setOpen(false)
    selectProviderChoice(choice, selection, setProviderID)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ProviderFilterTrigger choice={selected} open={open} />
      <ProviderFilterContent
        choices={choices}
        selected={selected}
        onSelect={select}
      />
    </Popover>
  )
}

type ProviderChoice = {
  account?: ProviderCredentialSummary
  label: string
  provider?: Provider
  value: string
}

function ProviderFilterTrigger({
  choice,
  open,
}: {
  choice: ProviderChoice
  open: boolean
}) {
  return (
    <PopoverTrigger asChild>
      <button
        aria-label="Filter model provider"
        className="flex min-w-0 items-center gap-2 py-1 text-base font-medium text-foreground transition-opacity hover:opacity-75"
        type="button"
      >
        {choice.provider ? <ProviderMark provider={choice.provider} /> : null}
        <span className="min-w-0 truncate">{choice.label}</span>
        <PickerChevron open={open} />
      </button>
    </PopoverTrigger>
  )
}

function ProviderFilterContent({
  choices,
  onSelect,
  selected,
}: {
  choices: ProviderChoice[]
  onSelect: (choice: ProviderChoice) => void
  selected: ProviderChoice
}) {
  return (
    <PopoverContent
      align="start"
      side="bottom"
      sideOffset={6}
      className="w-80 rounded-xl p-2"
    >
      <div className="max-h-72 space-y-0.5 overflow-y-auto">
        {choices.map((choice) => (
          <ProviderChoiceItem
            choice={choice}
            key={choice.value}
            selected={choice.value === selected.value}
            onSelect={onSelect}
          />
        ))}
      </div>
    </PopoverContent>
  )
}

function ProviderChoiceItem({
  choice,
  onSelect,
  selected,
}: {
  choice: ProviderChoice
  onSelect: (choice: ProviderChoice) => void
  selected: boolean
}) {
  return (
    <button
      className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-foreground/10"
      type="button"
      onClick={() => onSelect(choice)}
    >
      {choice.provider ? <ProviderMark provider={choice.provider} /> : null}
      <span className="min-w-0 flex-1 truncate">{choice.label}</span>
      {selected ? <CheckIcon className="size-4 shrink-0 text-primary" /> : null}
    </button>
  )
}

function providerChoices(selection: ModelSelection) {
  return [
    { label: "All", value: allProvidersValue },
    ...selection.connectedProviders.flatMap((provider) =>
      providerAccountChoices(
        provider,
        selection.accountsForProvider(provider.id)
      )
    ),
  ] satisfies ProviderChoice[]
}

function providerAccountChoices(
  provider: Provider,
  accounts: ProviderCredentialSummary[]
) {
  if (!accounts.length) {
    return [{ label: provider.name, provider, value: provider.id }]
  }
  return accounts.map((account) => ({
    account,
    label:
      accounts.length > 1
        ? `${credentialLabel(account)} - ${provider.name}`
        : provider.name,
    provider,
    value: `${provider.id}\u0001${account.label}`,
  }))
}

function selectedProviderChoice(
  choices: ProviderChoice[],
  providerID: string,
  selection: ModelSelection
) {
  const fallback = choices[0] ?? {
    label: "All",
    value: allProvidersValue,
  }
  if (providerID === allProvidersValue) return fallback
  const account = selection.selectedAccountLabel(providerID)
  return (
    choices.find(
      (choice) =>
        choice.provider?.id === providerID && choice.account?.label === account
    ) ??
    choices.find((choice) => choice.provider?.id === providerID) ??
    fallback
  )
}

function selectProviderChoice(
  choice: ProviderChoice,
  selection: ModelSelection,
  setProviderID: (value: string) => void
) {
  const providerID = choice.provider?.id ?? allProvidersValue
  setProviderID(providerID)
  if (choice.account && choice.provider) {
    void selection.setAccount(choice.provider.id, choice.account.label)
    return
  }
  selectProviderRecommendation(selection, providerID)
}

function providerModelGroups(selection: ModelSelection, providerID: string) {
  return selection.providerGroups.filter(
    (group) =>
      providerID === allProvidersValue || group.provider.id === providerID
  )
}

function adjacentManualModel(
  selection: ModelSelection,
  providerID: string,
  direction: WheelDirection
) {
  return adjacentGroupedModel(
    providerModelGroups(selection, providerID),
    selection.currentModel,
    direction
  )
}

function adjacentGroupedModel(
  groups: ModelGroup[],
  currentModel: SelectableModel | undefined,
  direction: WheelDirection
) {
  const models = groups.flatMap((group) => group.models)
  const currentIndex = models.findIndex((model) =>
    isModelSelected(currentModel, model)
  )
  return adjacentItem(models, currentIndex, direction)
}

function adjacentSmartModel(
  selection: ModelSelection,
  providerID: string,
  direction: WheelDirection
) {
  const recommendations = [...selection.recommendedModels(providerID)].sort(
    (left, right) => left.position - right.position
  )
  const currentIndex = recommendations.findIndex((recommendation) =>
    isModelSelected(selection.currentModel, recommendation.model)
  )
  return adjacentItem(recommendations, currentIndex, direction)?.model
}

function adjacentItem<T>(
  items: T[],
  currentIndex: number,
  direction: WheelDirection
) {
  const fallbackIndex = direction > 0 ? -1 : items.length
  const startIndex = currentIndex < 0 ? fallbackIndex : currentIndex
  const nextIndex = Math.min(
    items.length - 1,
    Math.max(0, startIndex + direction)
  )
  return nextIndex === currentIndex ? undefined : items[nextIndex]
}

function selectModelWithoutWaiting(
  selection: ModelSelection,
  model: SelectableModel
) {
  void selection
    .setModel(model)
    .catch((error) => console.error("Unable to select model", error))
}

type SmartModelSliderProps = {
  providerID: string
  selection: ModelSelection
}

function SmartModelSlider({ providerID, selection }: SmartModelSliderProps) {
  const source = selection.recommendedModels(providerID)
  const boundary = selection.recommendations?.benchmarkBoundary ?? 0.74
  const hasUnbenchmarked = source.some(isUnbenchmarked)
  const recommendations = sliderRecommendations(
    source,
    boundary,
    hasUnbenchmarked
  )
  const selectedPosition = recommendationPosition(
    recommendations,
    selection.currentModel
  )
  const selectionIdentity = `${selection.currentModel ? modelReactKey(selection.currentModel) : ""}:${selectedPosition}`
  const [sliderState, setSliderState] = React.useState(() => ({
    inputRevision: 0,
    position: selectedPosition,
    selectionIdentity,
  }))
  const selectionChanged = sliderState.selectionIdentity !== selectionIdentity
  const resolvedSliderState = selectionChanged
    ? {
        inputRevision:
          sliderState.inputRevision +
          Number(sliderState.position !== selectedPosition),
        position: selectedPosition,
        selectionIdentity,
      }
    : sliderState
  if (selectionChanged) {
    setSliderState(resolvedSliderState)
  }
  const position = resolvedSliderState.position
  const setPosition = (nextPosition: number) =>
    setSliderState({ ...resolvedSliderState, position: nextPosition })
  const onWheel = useWheelStep<HTMLDivElement>((direction) => {
    const recommendation = adjacentSliderRecommendation(
      recommendations,
      position,
      reverseWheelDirection(direction)
    )
    if (!recommendation) return
    setPosition(recommendation.position)
    selectModelWithoutWaiting(selection, recommendation.model)
  })

  if (!recommendations.length) {
    return <EmptySmartModelSlider />
  }

  return (
    <div className="space-y-3">
      <SliderLabels boundary={boundary} hasUnbenchmarked={hasUnbenchmarked} />
      <SmartSliderInput
        key={resolvedSliderState.inputRevision}
        position={position}
        recommendations={recommendations}
        select={(recommendation) =>
          selectRecommendation(selection, recommendation)
        }
        setPosition={setPosition}
        onWheel={onWheel}
      />
    </div>
  )
}

function EmptySmartModelSlider() {
  return (
    <div className="py-8 text-center text-sm text-muted-foreground">
      No ranked models
    </div>
  )
}

type SmartSliderInputProps = {
  onWheel: React.WheelEventHandler<HTMLDivElement>
  position: number
  recommendations: RecommendedSelectableModel[]
  select: (recommendation: RecommendedSelectableModel) => Promise<void>
  setPosition: (position: number) => void
}

function SmartSliderInput(props: SmartSliderInputProps) {
  const control = useSmartSliderControl(props)
  return (
    <div className="relative h-8" onWheel={props.onWheel}>
      <SliderTrack position={props.position} />
      <SliderMarkers {...props} />
      <SliderRangeInput control={control} />
      <SliderThumb position={props.position} />
    </div>
  )
}

function adjacentSliderRecommendation(
  recommendations: RecommendedSelectableModel[],
  position: number,
  direction: WheelDirection
) {
  const ordered = [...recommendations].sort(
    (left, right) => left.position - right.position
  )
  const current = nearestRecommendation(ordered, position)
  const currentIndex = ordered.findIndex(
    (recommendation) => recommendation === current
  )
  return adjacentItem(ordered, currentIndex, direction)
}

function useSmartSliderControl(props: SmartSliderInputProps) {
  const [inputPosition, setInputPosition] = React.useState(props.position)
  const selectedPosition = React.useRef(props.position)
  const selectedKey = React.useRef(
    recommendationIdentity(
      nearestRecommendation(props.recommendations, props.position)
    )
  )
  const change = (rawPosition: number) => {
    setInputPosition(rawPosition)
    const recommendation = nearestRecommendation(
      props.recommendations,
      rawPosition
    )
    if (!recommendation) return
    selectedPosition.current = recommendation.position
    props.setPosition(recommendation.position)
    const nextKey = recommendationIdentity(recommendation)
    if (selectedKey.current === nextKey) return
    selectedKey.current = nextKey
    void props
      .select(recommendation)
      .catch((error) => console.error("Unable to select model", error))
  }
  const settle = () => setInputPosition(selectedPosition.current)
  return { change, inputPosition, settle }
}

function SliderRangeInput({
  control,
}: {
  control: ReturnType<typeof useSmartSliderControl>
}) {
  return (
    <input
      aria-label="Model cost and intelligence"
      className="peer absolute inset-0 z-10 h-full w-full cursor-grab opacity-0 active:cursor-grabbing"
      max={1000}
      min={0}
      type="range"
      value={Math.round(control.inputPosition * 1000)}
      onBlur={control.settle}
      onChange={(event) =>
        control.change(Number(event.currentTarget.value) / 1000)
      }
      onKeyUp={control.settle}
      onPointerUp={control.settle}
    />
  )
}

function SliderTrack({ position }: { position: number }) {
  return (
    <div className="smart-model-slider-track pointer-events-none absolute inset-x-0 top-1/2 h-[18px] -translate-y-1/2 rounded-full">
      <span
        className="smart-model-slider-fill absolute inset-y-0 left-0 overflow-hidden rounded-full transition-[width,box-shadow] duration-300 ease-out motion-reduce:transition-none"
        style={sliderFillStyle(position)}
      />
    </div>
  )
}

function SliderThumb({ position }: { position: number }) {
  return (
    <span
      className="pointer-events-none absolute top-1/2 z-2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-md ring-2 ring-neutral-900 dark:ring-background transition-[left,scale,box-shadow] duration-200 ease-out peer-hover:scale-125 peer-hover:shadow-lg peer-focus-visible:scale-125 peer-active:scale-125 peer-active:shadow-xl motion-reduce:transition-none"
      style={{ left: sliderPoint(position) }}
    />
  )
}

type SliderFillStyle = React.CSSProperties & { "--smart-position": number }

function sliderFillStyle(position: number): SliderFillStyle {
  return { "--smart-position": position, width: sliderPoint(position) }
}

function SliderLabels({
  boundary,
  hasUnbenchmarked,
}: {
  boundary: number
  hasUnbenchmarked: boolean
}) {
  return (
    <div className="relative h-7 text-sm text-muted-foreground">
      <span className="absolute bottom-0 left-0 flex items-center gap-1">
        <span>Cheaper</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="How smart model selection works"
              className="rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
            >
              <InfoIcon className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            sideOffset={6}
            className="max-w-64 text-pretty"
          >
            Models that cost more while scoring lower than another model are
            omitted. They remain available in Manual selection.
          </TooltipContent>
        </Tooltip>
      </span>
      <span
        className="absolute bottom-0"
        style={{
          right: hasUnbenchmarked
            ? `calc(${(1 - boundary) * 100}% + 0.75rem)`
            : 0,
        }}
      >
        Smarter
      </span>
      {hasUnbenchmarked ? (
        <span className="absolute -top-1 right-0 flex flex-col text-right leading-4">
          <span>New</span>
          <span>No benchmark</span>
        </span>
      ) : null}
    </div>
  )
}

function SliderMarkers({
  position,
  recommendations,
}: {
  position: number
  recommendations: RecommendedSelectableModel[]
}) {
  return recommendations.map((recommendation) =>
    Math.abs(recommendation.position - position) < 0.025 ? null : (
      <span
        key={`${recommendation.providerId}:${recommendation.modelId}`}
        className="pointer-events-none absolute top-1/2 z-1 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/30"
        style={{ left: sliderPoint(recommendation.position) }}
      />
    )
  )
}

function sliderPoint(position: number) {
  const percent = position * 100
  const offset = 16 * (1 - 2 * position)
  return `calc(${percent}% + ${offset}px)`
}

function sliderRecommendations(
  recommendations: RecommendedSelectableModel[],
  boundary: number,
  hasUnbenchmarked: boolean
) {
  if (hasUnbenchmarked || boundary <= 0) return recommendations
  return recommendations.map((recommendation) => ({
    ...recommendation,
    position: Math.min(1, recommendation.position / boundary),
  }))
}

function AdvancedModelPicker({
  providerID,
  selection,
}: {
  providerID: string
  selection: ModelSelection
}) {
  return (
    <AdvancedModelSelect
      groups={providerModelGroups(selection, providerID)}
      selection={selection}
    />
  )
}

function AdvancedModelSelect({
  groups,
  selection,
}: {
  groups: ModelGroup[]
  selection: ModelSelection
}) {
  const [open, setOpen] = React.useState(false)
  const onWheel = useWheelStep((direction) => {
    const model = adjacentGroupedModel(
      groups,
      selection.currentModel,
      direction
    )
    if (model) selectModelWithoutWaiting(selection, model)
  })
  const selectModel = (model: SelectableModel) => {
    void selection.setModel(model)
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <AdvancedModelSelectTrigger
        model={selection.currentModel}
        open={open}
        onWheel={onWheel}
      />
      <AdvancedModelSelectContent
        groups={groups}
        selected={selection.currentModel}
        onSelect={selectModel}
      />
    </Popover>
  )
}

function AdvancedModelSelectTrigger({
  model,
  onWheel,
  open,
}: {
  model: SelectableModel | undefined
  onWheel: React.WheelEventHandler<HTMLButtonElement>
  open: boolean
}) {
  return (
    <PopoverTrigger asChild>
      <button
        className="flex h-10 w-full items-center justify-between gap-3 rounded-xl bg-muted/70 px-4 text-sm transition-colors hover:bg-muted"
        type="button"
        onWheel={onWheel}
      >
        <span className="flex min-w-0 items-center gap-2 truncate">
          {model ? <ProviderMark provider={model.provider} /> : null}
          <span className="truncate">{model?.name ?? "Select model"}</span>
        </span>
        <PickerChevron open={open} />
      </button>
    </PopoverTrigger>
  )
}

function AdvancedModelSelectContent({
  groups,
  onSelect,
  selected,
}: {
  groups: ModelGroup[]
  onSelect: (model: SelectableModel) => void
  selected: SelectableModel | undefined
}) {
  return (
    <PopoverContent
      align="start"
      side="bottom"
      sideOffset={6}
      className="w-[var(--radix-popover-trigger-width)] gap-2 rounded-xl p-2"
    >
      <AdvancedModelGroups
        groups={groups}
        selected={selected}
        onSelect={onSelect}
      />
    </PopoverContent>
  )
}

function AdvancedModelGroups({
  groups,
  onSelect,
  selected,
}: {
  groups: ModelGroup[]
  onSelect: (model: SelectableModel) => void
  selected: SelectableModel | undefined
}) {
  return (
    <div className="max-h-64 overflow-y-auto">
      {groups.map((group, index) => (
        <AdvancedModelGroup
          group={group}
          key={group.provider.id}
          selected={selected}
          separated={index > 0}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

function AdvancedModelGroup({
  group,
  onSelect,
  selected,
  separated,
}: {
  group: ModelGroup
  onSelect: (model: SelectableModel) => void
  selected: SelectableModel | undefined
  separated: boolean
}) {
  return (
    <div className={separated ? "mt-2 border-t border-foreground/5 pt-2" : ""}>
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
        <ProviderMark provider={group.provider} />
        {group.provider.name}
      </div>
      <div className="space-y-0.5">
        {group.models.map((model) => (
          <AdvancedModelItem
            key={modelReactKey(model)}
            model={model}
            selected={isModelSelected(selected, model)}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  )
}

function AdvancedModelItem({
  model,
  onSelect,
  selected,
}: {
  model: SelectableModel
  onSelect: (model: SelectableModel) => void
  selected: boolean
}) {
  return (
    <button
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-foreground/10"
      type="button"
      onClick={() => onSelect(model)}
    >
      <span className="min-w-0 flex-1 truncate">{model.name}</span>
      {selected ? <CheckIcon className="size-4 shrink-0 text-primary" /> : null}
    </button>
  )
}

function ModelPickerActions({
  onConnect,
  onManage,
}: {
  onConnect: () => void
  onManage: () => void
}) {
  return (
    <div className="flex items-center opacity-0 transition-opacity group-focus-within/provider-header:opacity-100 group-hover/provider-header:opacity-100">
      <Button size="icon-sm" variant="ghost" onClick={onConnect}>
        <PlusIcon />
        <span className="sr-only">Connect provider</span>
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={onManage}>
        <SlidersHorizontalIcon />
        <span className="sr-only">Manage models</span>
      </Button>
    </div>
  )
}

function recommendationPosition(
  recommendations: RecommendedSelectableModel[],
  currentModel: SelectableModel | undefined
) {
  const current = recommendations.find(
    (recommendation) =>
      recommendation.providerId === currentModel?.provider.id &&
      recommendation.modelId === currentModel?.id
  )
  return current?.position ?? recommendations[0]?.position ?? 0
}

function nearestRecommendation(
  recommendations: RecommendedSelectableModel[],
  position: number
) {
  return recommendations.reduce<RecommendedSelectableModel | undefined>(
    (nearest, candidate) => {
      if (!nearest) return candidate
      const currentDistance = Math.abs(nearest.position - position)
      return Math.abs(candidate.position - position) < currentDistance
        ? candidate
        : nearest
    },
    undefined
  )
}

async function selectRecommendation(
  selection: ModelSelection,
  recommendation: RecommendedSelectableModel | undefined
) {
  if (!recommendation) return
  await selection.setModel(recommendation.model)
}

function selectProviderRecommendation(
  selection: ModelSelection,
  providerID: string
) {
  const currentPosition = recommendationPosition(
    selection.recommendedModels(allProvidersValue),
    selection.currentModel
  )
  void selectRecommendation(
    selection,
    nearestRecommendation(
      selection.recommendedModels(providerID),
      currentPosition
    )
  )
}

function isUnbenchmarked(recommendation: RecommendedSelectableModel) {
  return recommendation.segment === "unbenchmarked"
}

function recommendationIdentity(
  recommendation: RecommendedSelectableModel | undefined
) {
  return recommendation
    ? `${recommendation.providerId}:${recommendation.modelId}`
    : undefined
}

function ModelVariantSelector({ selection }: { selection: ModelSelection }) {
  const [open, setOpen] = React.useState(false)
  const selected = selection.currentVariant ?? defaultVariant
  const onWheel = useWheelStep((direction) => {
    const currentIndex = selection.variantOptions.indexOf(selected)
    const variant = adjacentItem(
      selection.variantOptions,
      currentIndex,
      reverseWheelDirection(direction)
    )
    if (variant) selectModelVariant(selection, variant)
  })
  if (selection.variantOptions.length <= 2) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              className="flex h-8 w-32 max-w-[38%] items-center justify-between gap-2 rounded-xl bg-muted/70 px-4 text-sm capitalize transition-colors hover:bg-muted"
              type="button"
              onWheel={onWheel}
            >
              <span className="truncate">{getVariantLabel(selected)}</span>
              <PickerChevron open={open} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="left">Choose thinking mode</TooltipContent>
      </Tooltip>
      <ModelVariantContent
        options={selection.variantOptions}
        selected={selected}
        onSelect={(variant) => {
          setOpen(false)
          selectModelVariant(selection, variant)
        }}
      />
    </Popover>
  )
}

function selectModelVariant(selection: ModelSelection, variant: string) {
  void selection
    .setVariant(variant === defaultVariant ? undefined : variant)
    .catch((error) => console.error("Unable to select thinking mode", error))
}

function ModelVariantContent({
  onSelect,
  options,
  selected,
}: {
  onSelect: (variant: string) => void
  options: string[]
  selected: string
}) {
  return (
    <PopoverContent
      align="start"
      side="top"
      sideOffset={6}
      className="w-[var(--radix-popover-trigger-width)] rounded-xl p-2"
    >
      <div className="space-y-0.5">
        {options.map((variant) => (
          <button
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm capitalize transition-colors hover:bg-foreground/10"
            key={variant}
            type="button"
            onClick={() => onSelect(variant)}
          >
            <span className="flex-1">{getVariantLabel(variant)}</span>
            {variant === selected ? (
              <CheckIcon className="size-4 text-primary" />
            ) : null}
          </button>
        ))}
      </div>
    </PopoverContent>
  )
}

function PickerChevron({ open }: { open: boolean }) {
  return open ? (
    <ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" />
  ) : (
    <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
  )
}

function ModelSummary({ model }: { model: SelectableModel | undefined }) {
  if (!model) {
    return (
      <span className="min-w-0 flex-1 truncate text-center text-muted-foreground">
        Select model
      </span>
    )
  }

  return (
    <span className="flex min-w-0 flex-1 items-center justify-center gap-2">
      <ProviderMark provider={model.provider} />
      <span className="min-w-0 truncate">{modelTriggerDisplayName(model)}</span>
    </span>
  )
}

function modelTriggerDisplayName(model: SelectableModel) {
  return modelDisplayName(model).replace(/^GPT-/i, "")
}

export function modelDisplayName(model: SelectableModel) {
  return model.name
}

export function modelReactKey(model: SelectableModel) {
  return `${model.provider.id}:${model.id}:${model.credentialLabel ?? defaultCredentialLabel}`
}

export function ModelTags({ model }: { model: SelectableModel }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {modelFree(model) ? (
        <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
          Free
        </span>
      ) : null}
      {model.latest ? (
        <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
          Latest
        </span>
      ) : null}
    </span>
  )
}

function modelFree(model: SelectableModel) {
  if (model.provider.id === openAICompatibleProviderID) return false
  return model.cost.input === 0 && model.cost.output === 0
}

export function ProviderMark({ provider }: { provider: Provider }) {
  const icon = providerIconName(provider.id)

  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted/60">
      {icon ? (
        <svg
          aria-label={provider.name}
          className="size-4"
          data-component="provider-icon"
          role="img"
        >
          <use href={`${providerIconSprite}#${icon}`} />
        </svg>
      ) : (
        <ProviderMonogram className="text-[0.625rem]" name={provider.name} />
      )}
    </span>
  )
}

// A provider's logo alone, for avatars and compact lists.
export function ProviderIcon({
  className,
  providerId,
}: {
  className?: string
  providerId: string
}) {
  const icon = providerIconName(providerId)
  if (!icon)
    return (
      <ProviderMonogram
        className={cn("text-[0.5625rem]", className)}
        name={providerId}
      />
    )
  return (
    <svg
      aria-hidden="true"
      className={cn("size-3.5", className)}
      data-component="provider-icon"
    >
      <use href={`${providerIconSprite}#${icon}`} />
    </svg>
  )
}

// Providers without a logo show their initial instead of a generic glyph.
function ProviderMonogram({
  className,
  name,
}: {
  className?: string
  name: string
}) {
  return (
    <span
      aria-label={name}
      role="img"
      className={cn(
        "flex size-3.5 items-center justify-center font-semibold text-muted-foreground uppercase",
        className
      )}
    >
      {name.trim().charAt(0) || "?"}
    </span>
  )
}

// Sprite entries that only hold a generic sparkles glyph, not the provider's logo.
const placeholderIcons = new Set<string>([
  "azure-cognitive-services",
  "chutes",
  "cortecs",
  "google-vertex-anthropic",
  "lmstudio",
  "minimax-cn-coding-plan",
  "minimax-coding-plan",
  "morph",
  "requesty",
  "sap-ai-core",
  "stepfun",
  "synthetic",
  "upstage",
  "wandb",
])

function providerIconName(providerID: string): IconName | undefined {
  const icon = providerIconAliases[providerID] ?? providerID
  if (placeholderIcons.has(icon)) return undefined
  return iconNames.includes(icon as IconName) ? (icon as IconName) : undefined
}
