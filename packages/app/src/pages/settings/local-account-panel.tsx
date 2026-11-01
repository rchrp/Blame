import { LogInIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DialogClose } from "@/components/ui/dialog"
import { useCloudAuth } from "@/context/cloud-auth"
import { SettingsGroup, SettingsPanel, SettingsRow } from "./settings-layout"

/** Account settings of a workspace kept on this computer. */
export function LocalAccountPanel() {
  const auth = useCloudAuth()
  return (
    <SettingsPanel>
      <SettingsGroup
        title="Workspace"
        description="Projects, stories, conversations and provider connections are stored on this computer. Agents use your own AI providers."
      >
        <SettingsRow
          title="No account"
          description="Sign in to sync this workspace across computers and to use hosted services: Cloud Previews, cloud voice transcription and hosted uploads. Your workspace moves into the account."
        >
          {/* Settings close so the sign-in screen is in front. */}
          <DialogClose asChild>
            <Button variant="outline" onClick={auth.openSignIn}>
              <LogInIcon />
              Sign in
            </Button>
          </DialogClose>
        </SettingsRow>
      </SettingsGroup>
    </SettingsPanel>
  )
}
