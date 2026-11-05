import * as React from "react"
import { ArrowUpRightIcon, SparklesIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { releasePageUrl } from "@/components/updates/release-notes"
import { WhatsNewDialog } from "@/components/updates/whats-new-dialog"
import { type DesktopUpdateStatus, usePlatform } from "@/context/platform"
import type { ReleaseNotes } from "@/context/platform-whats-new"
import { SettingsRow } from "./settings-layout"

// Reads again the notes What's new showed after the last update.
export function WhatsNewSettingsRow({
  status,
}: {
  status: DesktopUpdateStatus
}) {
  const platform = usePlatform()
  const { whatsNew } = platform
  const [notes, setNotes] = React.useState<ReleaseNotes | null>(null)
  const [dialog, setDialog] = React.useState({
    open: false,
    showImages: false,
  })

  // Update checks bring the notes, so read them again after each one.
  React.useEffect(() => {
    if (!whatsNew) return undefined
    let active = true
    whatsNew.current().then(
      (next) => {
        if (active) setNotes(next)
      },
      () => {
        /* Without saved notes, the row links to the release on GitHub. */
      }
    )
    return () => {
      active = false
    }
  }, [whatsNew, status.phase])

  // Builds that cannot update have no release of their own to link to.
  if (!whatsNew || (!notes && status.phase === "unsupported")) return null

  async function showNotes() {
    const preferences = await platform.privacy?.get().catch(() => undefined)
    setDialog({ open: true, showImages: preferences?.updateChecks ?? false })
  }

  function openReleasePage() {
    const url = releasePageUrl(status.currentVersion)
    if (platform.openExternalLink) platform.openExternalLink(url)
    else window.open(url, "_blank", "noopener,noreferrer")
  }

  return (
    <>
      <SettingsRow
        title="What's new"
        description={
          notes
            ? `See what changed in Blame ${notes.version}.`
            : `Read the release notes of Blame ${status.currentVersion} on GitHub.`
        }
      >
        {notes ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void showNotes()}
          >
            <SparklesIcon />
            Release notes
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={openReleasePage}>
            View on GitHub
            <ArrowUpRightIcon />
          </Button>
        )}
      </SettingsRow>
      {notes ? (
        <WhatsNewDialog
          notes={notes}
          open={dialog.open}
          showImages={dialog.showImages}
          onOpenChange={(open) =>
            setDialog((current) => ({ ...current, open }))
          }
        />
      ) : null}
    </>
  )
}
