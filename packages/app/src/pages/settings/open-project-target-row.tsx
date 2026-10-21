import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { usePlatform } from "@/context/platform"
import {
  isOpenProjectTarget,
  openProjectTargetKey,
} from "@/lib/open-project-target"
import { useUiMemory } from "@/lib/ui-memory"
import { SettingsRow } from "./settings-layout"

// Undoes "Don't ask again" from the Open Project dialog (desktop only).
export function OpenProjectTargetRow() {
  const platform = usePlatform()
  const [target, setTarget] = useUiMemory(
    openProjectTargetKey,
    "ask",
    isOpenProjectTarget
  )
  if (!platform.projectWindows) return null
  return (
    <SettingsRow
      title="Open projects"
      description="Where a project opens while another one is already open."
    >
      <Select
        value={target}
        onValueChange={(value) => {
          if (isOpenProjectTarget(value)) setTarget(value)
        }}
      >
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ask">Ask each time</SelectItem>
          <SelectItem value="new-window">In a new window</SelectItem>
          <SelectItem value="this-window">In this window</SelectItem>
        </SelectContent>
      </Select>
    </SettingsRow>
  )
}
