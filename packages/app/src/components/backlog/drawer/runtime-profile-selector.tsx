import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloudIcon,
  CloudOffIcon,
  ContainerIcon,
  FolderGit2Icon,
  type LucideIcon,
} from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { navigate } from "@/components/navigation/navigation"
import { useCloudAuth } from "@/context/cloud-auth"
import { useOptionalBlameRuntime } from "@/context/blame-runtime"
import { usePlatform, type RuntimeProgress } from "@/context/platform"
import {
  runtimeProgressText,
  type RuntimePhase,
} from "@/lib/blame-runtime-state"
import {
  saveStoryRunMode,
  useSavedStoryRunMode,
  useStoryRunMode,
  type StoryRunMode,
} from "@/lib/runtime-preference"
import { cn } from "@/lib/utils"

type RuntimeOption = {
  description: string
  icon: LucideIcon
  iconClassName: string
  iconStyle?: React.CSSProperties
  label: string
  profile: StoryRunMode
  selectedClassName: string
  triggerClassName: string
  triggerStyle?: React.CSSProperties
}

const cloudGradient = {
  background:
    "linear-gradient(color-mix(in oklch, var(--muted) 68%, var(--background)), color-mix(in oklch, var(--muted) 68%, var(--background))) padding-box, linear-gradient(135deg, oklch(0.8 0.16 240 / 52%), oklch(0.7 0.21 245 / 52%), oklch(0.62 0.22 255 / 42%)) border-box",
  backgroundClip: "padding-box, border-box",
} satisfies React.CSSProperties

const runtimeOptions = [
  {
    description: "Run the story in an isolated managed sandbox.",
    icon: CloudIcon,
    iconClassName:
      "border border-transparent bg-transparent text-sky-600 shadow-[0_0_0_1px_oklch(0.7_0.17_250_/_0.1),0_0_8px_oklch(0.65_0.2_250_/_0.1)] ring-1 ring-foreground/15 dark:text-sky-300",
    iconStyle: cloudGradient,
    label: "Cloud Preview",
    profile: "vercel-compose",
    selectedClassName: "text-sky-600 dark:text-sky-300",
    triggerClassName:
      "border-transparent bg-transparent text-foreground shadow-[0_0_0_1px_oklch(0.7_0.17_250_/_0.12),0_0_8px_oklch(0.65_0.2_250_/_0.12)] ring-1 ring-foreground/20 transition-[filter] duration-150 hover:brightness-105 focus-visible:ring-2 focus-visible:ring-sky-300/80",
    triggerStyle: cloudGradient,
  },
  {
    description: "Run the story in an isolated sandbox on this computer.",
    icon: ContainerIcon,
    iconClassName:
      "bg-primary/12 text-primary ring-1 ring-primary/25 dark:bg-primary/30 dark:text-blue-300 dark:ring-primary/50",
    label: "Local Container",
    profile: "local-container",
    selectedClassName: "text-primary dark:text-blue-300",
    triggerClassName:
      "bg-primary/10 text-foreground shadow-none ring-1 ring-primary/30 transition-colors hover:bg-primary/15 dark:bg-primary/25 dark:ring-primary/60 dark:hover:bg-primary/35",
  },
  {
    description:
      "Runs right in your project folder: the fastest and lightest. No isolation, so agents can collide on files and ports.",
    icon: FolderGit2Icon,
    iconClassName:
      "bg-muted/70 text-muted-foreground ring-1 ring-foreground/10",
    label: "Direct",
    profile: "direct",
    selectedClassName: "text-foreground",
    triggerClassName:
      "bg-muted/70 text-foreground shadow-none ring-0 transition-colors hover:bg-muted",
  },
] as const satisfies readonly RuntimeOption[]

export const RuntimeProfileSelector = React.memo(
  function RuntimeProfileSelector({
    onChange,
    value,
  }: {
    // The story's own choice; without it, the account default is shown and
    // changed.
    value?: StoryRunMode | null
    onChange?(mode: StoryRunMode): void
  }) {
    const auth = useCloudAuth()
    const platform = usePlatform()
    const runtime = useOptionalBlameRuntime()
    const premium = auth.license?.licensed === true
    const accountDefault = useStoryRunMode(premium)
    const savedDefault = useSavedStoryRunMode()
    const current = value ?? accountDefault
    // The saved default is Cloud Preview, but without Premium the story runs
    // in a Local Container; say so instead of switching silently.
    const cloudFallback =
      !value && savedDefault === "vercel-compose" && current !== savedDefault
    const [open, setOpen] = React.useState(false)
    const cloudAvailable = Boolean(
      platform.previewRuntime && auth.status === "authenticated"
    )
    const selected = runtimeOption(current)

    // Applies to this story, and becomes the default for the next one.
    const apply = (mode: StoryRunMode) => {
      saveStoryRunMode(mode)
      onChange?.(mode)
      setOpen(false)
    }

    const selectProfile = (profile: StoryRunMode) => {
      if (profile === current) {
        setOpen(false)
        return
      }
      if (profile === "vercel-compose" && !premium) {
        setOpen(false)
        toast.info("Cloud previews require Blame Premium.", {
          action: {
            label: "View Premium",
            onClick: () => navigate("/premium"),
          },
        })
        return
      }
      if (profile === "local-container" && runtimeNeedsSetup(runtime?.phase)) {
        // Without the runtime, explain and offer to install it; the choice
        // applies once the person agrees.
        setOpen(false)
        runtime?.promptInstall({ onAccept: () => apply(profile) })
        return
      }
      if (profile === "vercel-compose" && !cloudAvailable) return
      apply(profile)
    }

    const SelectedIcon = selected.icon

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            aria-label={`Preview runtime: ${selected.label}`}
            title={cloudFallback ? cloudFallbackNote : undefined}
            className={cn(
              "h-8 w-44 justify-between gap-2 rounded-xl px-3 text-sm font-medium active:translate-y-0",
              selected.triggerClassName
            )}
            style={selected.triggerStyle}
          >
            <span className="flex min-w-0 items-center gap-2">
              <SelectedIcon className="size-4 shrink-0" />
              <span className="truncate">{selected.label}</span>
              {cloudFallback && (
                <CloudOffIcon
                  aria-label={cloudFallbackNote}
                  className="size-3.5 shrink-0 opacity-70"
                />
              )}
            </span>
            {open ? (
              <ChevronUpIcon className="size-4 shrink-0 opacity-70" />
            ) : (
              <ChevronDownIcon className="size-4 shrink-0 opacity-70" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={6}
          className="w-[22rem] rounded-xl p-2"
        >
          {cloudFallback && (
            <p className="mb-1 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              {cloudFallbackNote}{" "}
              <button
                className="font-medium text-foreground underline-offset-2 hover:underline"
                type="button"
                onClick={() => {
                  setOpen(false)
                  navigate("/premium")
                }}
              >
                View Premium
              </button>
            </p>
          )}
          <div className="space-y-0.5">
            {runtimeOptions.map((option) => (
              <RuntimeProfileOption
                disabled={
                  option.profile === "vercel-compose" && !cloudAvailable
                }
                key={option.profile}
                option={option}
                premium={premium}
                runtimeNote={
                  option.profile === "local-container"
                    ? runtimeNote(runtime?.phase, runtime?.progress)
                    : undefined
                }
                selected={option.profile === current}
                onSelect={selectProfile}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>
    )
  }
)

function RuntimeProfileOption({
  disabled,
  onSelect,
  option,
  premium,
  runtimeNote,
  selected,
}: {
  disabled: boolean
  onSelect: (profile: StoryRunMode) => void
  option: RuntimeOption
  premium: boolean
  runtimeNote?: string
  selected: boolean
}) {
  const Icon = option.icon

  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-foreground/10 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
      disabled={disabled}
      onClick={() => onSelect(option.profile)}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          option.iconClassName
        )}
        style={option.iconStyle}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{option.label}</span>
        <span className="block text-xs text-muted-foreground">
          {disabled
            ? "Sign in from the desktop app to use cloud previews."
            : option.profile === "vercel-compose" && !premium
              ? "Available with Blame Premium."
              : (runtimeNote ?? option.description)}
        </span>
      </span>
      {selected ? (
        <CheckIcon
          className={cn("size-4 shrink-0", option.selectedClassName)}
        />
      ) : null}
    </button>
  )
}

const cloudFallbackNote =
  "Your default is Cloud Preview, which needs Blame Premium, so stories run in a Local Container until then."

function runtimeNeedsSetup(phase?: RuntimePhase) {
  return (
    phase === "missing" || phase === "needs-repair" || phase === "unsupported"
  )
}

function runtimeNote(phase?: RuntimePhase, progress?: RuntimeProgress) {
  if (phase === "missing") return "Needs Blame Runtime, a one-time install."
  if (phase === "needs-repair") return "Blame Runtime needs a repair."
  if (phase === "unsupported") return "Not available on this computer."
  if (phase === "installing" || phase === "updating" || phase === "repairing")
    return `Blame Runtime: ${runtimeProgressText(progress).toLowerCase()}`
  return undefined
}

function runtimeOption(profile: StoryRunMode): RuntimeOption {
  return (
    runtimeOptions.find((option) => option.profile === profile) ??
    runtimeOptions[1]
  )
}
