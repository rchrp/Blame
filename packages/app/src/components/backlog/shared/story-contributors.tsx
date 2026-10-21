import * as React from "react"
import { motion } from "motion/react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import {
  getVariantLabel,
  useModelDisplayNames,
} from "@/components/model/model-selection"
import { ProviderIcon } from "@/components/model/model-selector"
import { CurrentUserAvatar } from "@/components/shared/user-avatar"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { CloudAuthContext } from "@/context/cloud-auth"
import { easeOutExpo } from "@/lib/motion"
import { cn } from "@/lib/utils"

type ModelWork = {
  modelId: string
  reasoningEffort?: string | null
  turns: number
}

type ProviderWork = { models: ModelWork[]; providerId: string }

const stackSpring = { type: "spring", stiffness: 420, damping: 30 } as const
// Matches the card background so stacked avatars read as cut out.
const avatarRing = "ring-2 ring-white dark:ring-neutral-900"

// Who worked on a story: the person first, then every AI provider whose
// models ran its turns. Hovering spreads the stack and lists the models.
export function StoryContributors({ story }: { story: UserStory }) {
  const providers = React.useMemo(() => storyProviders(story), [story])
  const [open, setOpen] = React.useState(false)
  const closeTimer = React.useRef<number | undefined>(undefined)
  const show = () => {
    window.clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const hide = () => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), 120)
  }
  React.useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <motion.span
          aria-label="Who worked on this story"
          className="flex shrink-0 items-center"
          onBlur={hide}
          onFocus={show}
          onMouseEnter={show}
          onMouseLeave={hide}
          role="group"
          tabIndex={0}
        >
          <motion.span
            animate={{ scale: open ? 1.08 : 1 }}
            className={cn("relative rounded-full", avatarRing)}
            transition={stackSpring}
          >
            <CurrentUserAvatar
              className="size-5 after:hidden"
              fallbackName={story.owner}
            />
          </motion.span>
          {providers.map((provider, index) => (
            <motion.span
              key={provider.providerId}
              animate={{ marginLeft: open ? 3 : -7, scale: open ? 1.08 : 1 }}
              className={cn(
                "relative flex size-5 items-center justify-center rounded-full bg-muted text-foreground",
                avatarRing
              )}
              initial={false}
              // Each provider stacks over the one before it, and the person.
              style={{ zIndex: index + 1 }}
              transition={{ ...stackSpring, delay: open ? index * 0.03 : 0 }}
            >
              <ProviderIcon
                className="size-3"
                providerId={provider.providerId}
              />
            </motion.span>
          ))}
        </motion.span>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-64 gap-0 p-1.5"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onMouseEnter={show}
        onMouseLeave={hide}
        onOpenAutoFocus={(event) => event.preventDefault()}
        side="bottom"
      >
        <ContributorDetails providers={providers} story={story} />
      </PopoverContent>
    </Popover>
  )
}

function ContributorDetails({
  providers,
  story,
}: {
  providers: ProviderWork[]
  story: UserStory
}) {
  const auth = React.useContext(CloudAuthContext)
  const user = auth?.status === "authenticated" ? auth.user : undefined
  const names = useModelDisplayNames()
  const rows = [
    <ContributorRow
      key="user"
      avatar={
        <CurrentUserAvatar
          className="size-6 after:hidden"
          fallbackName={story.owner}
        />
      }
      detail="Wrote the story"
      name={user?.fullName || user?.email || story.owner || "You"}
    />,
    ...providers.map((provider) => (
      <ContributorRow
        key={provider.providerId}
        avatar={
          <span className="flex size-6 items-center justify-center rounded-full bg-muted">
            <ProviderIcon providerId={provider.providerId} />
          </span>
        }
        detail={provider.models
          .map((model) =>
            [
              names.model(provider.providerId, model.modelId),
              model.reasoningEffort
                ? getVariantLabel(model.reasoningEffort)
                : "",
              model.turns
                ? `${model.turns} ${model.turns === 1 ? "turn" : "turns"}`
                : "",
            ]
              .filter(Boolean)
              .join(" · ")
          )
          .join("\n")}
        name={names.provider(provider.providerId)}
      />
    )),
  ]
  return (
    <div className="grid">
      <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
        Worked on by
      </p>
      {rows.map((row, index) => (
        <motion.div
          key={row.key}
          animate={{ opacity: 1, y: 0 }}
          initial={{ opacity: 0, y: 4 }}
          transition={{ delay: index * 0.04, duration: 0.3, ease: easeOutExpo }}
        >
          {row}
        </motion.div>
      ))}
    </div>
  )
}

function ContributorRow({
  avatar,
  detail,
  name,
}: {
  avatar: React.ReactNode
  detail: string
  name: string
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-md px-2 py-1.5">
      <span className="mt-0.5 shrink-0">{avatar}</span>
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate text-sm font-medium">{name}</span>
        <span className="text-xs whitespace-pre-line text-muted-foreground">
          {detail}
        </span>
      </span>
    </div>
  )
}

// Providers in the order they first worked on the story, each with the
// models it ran, their latest reasoning level and how many turns.
export function storyProviders(
  story: Pick<UserStory, "agentModelId" | "agentProviderId" | "agentRuns">
): ProviderWork[] {
  const providers = new Map<string, Map<string, ModelWork>>()
  const runs = [...(story.agentRuns ?? [])].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  )
  for (const run of runs) {
    if (!run.providerId || !run.modelId) continue
    const models = providers.get(run.providerId) ?? new Map<string, ModelWork>()
    const current = models.get(run.modelId)
    models.set(run.modelId, {
      modelId: run.modelId,
      reasoningEffort: run.reasoningEffort ?? current?.reasoningEffort,
      turns: (current?.turns ?? 0) + 1,
    })
    providers.set(run.providerId, models)
  }
  if (story.agentProviderId && story.agentModelId) {
    const models =
      providers.get(story.agentProviderId) ?? new Map<string, ModelWork>()
    if (!models.has(story.agentModelId))
      models.set(story.agentModelId, { modelId: story.agentModelId, turns: 0 })
    providers.set(story.agentProviderId, models)
  }
  return [...providers].map(([providerId, models]) => ({
    models: [...models.values()],
    providerId,
  }))
}
