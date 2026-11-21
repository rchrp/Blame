import * as React from "react"
import {
  ArrowRightIcon,
  GitMergeIcon,
  ListChecksIcon,
  SparklesIcon,
  WorkflowIcon,
} from "lucide-react"
import { toast } from "sonner"

import {
  epicTitleFromGoal,
  wholeModelRange,
  type Epic,
  type EpicSettings,
} from "@/components/orchestrator/data/epic-data"
import { useEpicStore } from "@/components/orchestrator/data/epic-store"
import { useEpicModels } from "@/components/orchestrator/data/use-epic-models"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { hasModKey } from "@/lib/keyboard"

const steps = [
  {
    icon: ListChecksIcon,
    title: "Plans the stories",
    text: "Splits your goal into user stories and starts an agent on each, with a model it picks inside the range you allow.",
  },
  {
    icon: SparklesIcon,
    title: "Reviews every result",
    text: "Merges a verified story, asks for changes, or rejects it. A story whose checks failed is never merged.",
  },
  {
    icon: GitMergeIcon,
    title: "Leaves the last word to you",
    text: "Stories merge into the epic's own branch. Your branch only moves when you approve the epic.",
  },
] as const

// The page with no epic chosen: what the orchestrator does, and the one
// thing it needs to start, a goal. The title comes from the goal.
export function NewEpic({
  firstEpic,
  onCreated,
}: {
  firstEpic: boolean
  onCreated: (epic: Epic) => void
}) {
  const epics = useEpicStore()
  const platform = usePlatform()
  const project = useProjects().activeProject
  const models = useEpicModels()
  const [goal, setGoal] = React.useState("")
  const [creating, setCreating] = React.useState(false)
  const title = epicTitleFromGoal(goal)

  async function start() {
    if (!title || creating) return
    setCreating(true)
    try {
      const epic = await epics.create({
        goal: goal.trim(),
        settings: defaultSettings(models),
        targetBranch: await currentBranch(platform, project?.path),
        title,
      })
      setGoal("")
      onCreated(epic)
    } catch (error) {
      toast.error("Unable to start the epic", {
        description: error instanceof Error ? error.message : String(error),
        position: "bottom-right",
      })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-2xl content-start gap-8 py-6 lg:py-10">
      <div className="onboarding-stagger grid gap-2">
        <span className="mb-2 flex size-12 items-center justify-center rounded-2xl border bg-muted text-muted-foreground shadow-sm">
          <WorkflowIcon className="size-5" />
        </span>
        <h2 className="font-heading text-2xl font-semibold tracking-normal">
          {firstEpic ? "Hand a goal to the orchestrator" : "New epic"}
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          An epic is one goal, worked on by several agents at once. The
          orchestrator runs it for you and never writes code itself.
        </p>
      </div>
      <ol className="grid gap-4 sm:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className="grid content-start gap-1.5">
            <span className="flex items-center gap-2 text-sm font-medium">
              <step.icon className="size-4 text-muted-foreground" />
              <span className="sr-only">{index + 1}.</span>
              {step.title}
            </span>
            <span className="text-sm text-muted-foreground">{step.text}</span>
          </li>
        ))}
      </ol>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void start()
        }}
      >
        <label className="grid gap-2">
          <span className="text-sm font-medium">
            What should this epic achieve?
          </span>
          <Textarea
            autoFocus
            className="min-h-28 bg-background"
            disabled={!project}
            placeholder="For example: let people export their projects as a ZIP, from the project menu, with a progress bar."
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && hasModKey(event)) {
                event.preventDefault()
                void start()
              }
            }}
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            It may use any model from Cheaper to Smarter on your connected
            providers, with no budget. Change that in the epic&rsquo;s settings.
          </p>
          <Button disabled={!title || creating || !project} type="submit">
            Start epic
            <ArrowRightIcon />
          </Button>
        </div>
      </form>
    </div>
  )
}

function defaultSettings(
  models: ReturnType<typeof useEpicModels>
): EpicSettings {
  const model = models.currentModel
  return {
    askBeforeLaunch: false,
    hiddenModels: models.hiddenModels(),
    modelRange: { ...wholeModelRange },
    providers: [],
    ...(model
      ? {
          orchestratorModel: {
            providerId: model.provider.id,
            modelId: model.id,
            ...(model.credentialLabel
              ? { credentialLabel: model.credentialLabel }
              : {}),
            ...(models.currentVariant
              ? { reasoning: models.currentVariant }
              : {}),
          },
        }
      : {}),
  }
}

// The epic merges where the project folder is now.
async function currentBranch(
  platform: ReturnType<typeof usePlatform>,
  root: string | undefined
) {
  if (!root || !platform.workspace?.gitBranches) return null
  try {
    return (await platform.workspace.gitBranches({ root })).current
  } catch {
    return null
  }
}
