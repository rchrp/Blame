import { BellIcon, BellOffIcon, SlidersVerticalIcon } from "lucide-react"

import { PersonalizationSlider } from "@/components/personalization/personalization-slider"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { usePlatform } from "@/context/platform"
import {
  ambitionOverride,
  effectiveAmbition,
  notchAt,
  notchIndex,
  parseNotch,
  personalizationOrder,
  type Ambition,
} from "@/lib/personalization"
import { useSystemNotificationsEnabled } from "@/lib/system-notifications"
import { usePersonalization } from "@/lib/use-personalization"
import { useConversationAmbition } from "@/lib/use-conversation-ambition"

export type AmbitionScope = {
  // The ambition of this story or conversation; null follows the account's.
  value: Ambition | null
  onChange: (ambition: Ambition | null) => void
}

// The floating menu of the composer: the four settings, with the ambition
// of this story or conversation, and the notifications bell on the desktop.
export function PersonalizationMenu({ ambition }: { ambition: AmbitionScope }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label="Personalize the agent"
          title="Personalize the agent"
          type="button"
          className="rounded-xl text-muted-foreground hover:text-foreground"
          size="icon-sm"
          variant="ghost"
        >
          <SlidersVerticalIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={10}
        collisionPadding={16}
        className="max-h-(--radix-popover-content-available-height) w-[min(22rem,calc(100vw-2rem))] gap-3 overflow-y-auto p-4"
      >
        <PersonalizationMenuBody ambition={ambition} />
      </PopoverContent>
    </Popover>
  )
}
// The menu of a chat or a planning conversation, whose ambition holds for
// the whole conversation.
export function ConversationPersonalizationMenu({
  ambitionKey,
}: {
  ambitionKey: string
}) {
  const [ambition, setAmbition] = useConversationAmbition(ambitionKey)
  return (
    <PersonalizationMenu ambition={{ value: ambition, onChange: setAmbition }} />
  )
}


function PersonalizationMenuBody({ ambition }: { ambition: AmbitionScope }) {
  const { change, personalization, ready } = usePersonalization()

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Personalize</h2>
        <NotificationsBell />
      </div>
      {personalizationOrder.map((setting) =>
        setting === "ambition" ? (
          <PersonalizationSlider
            key={setting}
            disabled={!ready}
            setting={setting}
            value={effectiveAmbition(personalization.ambition, ambition.value)}
            onChange={(value) => {
              const chosen = parseNotch("ambition", value)
              if (chosen)
                ambition.onChange(ambitionOverride(personalization.ambition, chosen))
            }}
            footer={
              <AmbitionDifference
                accountAmbition={personalization.ambition}
                ambition={ambition}
              />
            }
          />
        ) : (
          <PersonalizationSlider
            key={setting}
            disabled={!ready}
            setting={setting}
            value={personalization[setting]}
            onChange={(value) => void change(setting, value)}
          />
        )
      )}
    </>
  )
}

// Says when this story or conversation does not follow the default.
function AmbitionDifference({
  accountAmbition,
  ambition,
}: {
  accountAmbition: Ambition
  ambition: AmbitionScope
}) {
  if (ambition.value === null || ambition.value === accountAmbition) return null
  const defaultLabel = notchAt("ambition", notchIndex("ambition", accountAmbition)).label
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs">
      <span className="text-muted-foreground">
        Differs from your default ({defaultLabel})
      </span>
      <Button
        className="h-6 px-2 text-xs"
        size="sm"
        type="button"
        variant="ghost"
        onClick={() => ambition.onChange(null)}
      >
        Use default
      </Button>
    </div>
  )
}

// The same setting as the one in Settings, shown where the desktop has it.
function NotificationsBell() {
  const platform = usePlatform()
  const [enabled, setEnabled] = useSystemNotificationsEnabled()
  if (!platform.systemNotifications) return null
  const label = enabled
    ? "System notifications on. Turn off"
    : "System notifications off. Turn on"
  return (
    <Button
      aria-label={label}
      aria-pressed={enabled}
      title={label}
      type="button"
      className="rounded-xl text-muted-foreground hover:text-foreground"
      size="icon-sm"
      variant="ghost"
      onClick={() => setEnabled(!enabled)}
    >
      {enabled ? (
        <BellIcon className="size-3.5" />
      ) : (
        <BellOffIcon className="size-3.5" />
      )}
    </Button>
  )
}
