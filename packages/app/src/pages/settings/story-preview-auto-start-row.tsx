import { Switch } from "@/components/ui/switch"
import {
  rememberStoryPreviewAutoStart,
  useStoryPreviewAutoStart,
} from "@/lib/story-preview-auto-start"
import { SettingsRow } from "./settings-layout"

// Applies at once; a preview that already runs keeps running when it is off.
export function StoryPreviewAutoStartRow() {
  const enabled = useStoryPreviewAutoStart()
  return (
    <SettingsRow
      title="Start story previews automatically"
      description="Start a story's preview on its own when the story starts or reaches review. Off, you start it with the run controls."
    >
      <Switch
        aria-label="Toggle automatic story previews"
        checked={enabled}
        onCheckedChange={rememberStoryPreviewAutoStart}
      />
    </SettingsRow>
  )
}
