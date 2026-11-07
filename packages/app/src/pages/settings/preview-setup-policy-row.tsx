import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { isPreviewSetupPolicy } from "@/lib/preview-setup-decision"
import { previewSetupPolicyKey } from "@/lib/preview-setup-policy"
import { useUiMemory } from "@/lib/ui-memory"
import { SettingsRow } from "./settings-layout"

// Changes what "Remember my choice" saved in the first-setup dialog.
export function PreviewSetupPolicyRow() {
  const [policy, setPolicy] = useUiMemory(
    previewSetupPolicyKey,
    "ask",
    isPreviewSetupPolicy
  )
  return (
    <SettingsRow
      title="When a project has no preview setup"
      description="Whether Blame analyzes a project the first time you open it. You can always run the analysis from the Preview Environment page."
    >
      <Select
        value={policy}
        onValueChange={(value) => {
          if (isPreviewSetupPolicy(value)) setPolicy(value)
        }}
      >
        <SelectTrigger className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ask">Ask</SelectItem>
          <SelectItem value="automatic">Set up automatically</SelectItem>
          <SelectItem value="never">Don't set up</SelectItem>
        </SelectContent>
      </Select>
    </SettingsRow>
  )
}
