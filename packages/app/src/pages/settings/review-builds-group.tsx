import * as React from "react"

import { Switch } from "@/components/ui/switch"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"

import { SettingsGroup, SettingsRow } from "./settings-layout"

// What a local story preview serves once no agent works on the story: a
// production build, which needs about a quarter of the memory, or the
// development server. On by default; the development server comes back as
// soon as an agent works on the story.
export function ReviewBuildsGroup() {
  const settings = usePlatform().previewServing
  const project = useProjects().activeProject
  const projectPath = project?.path
  const [enabled, setEnabled] = React.useState(true)
  const [loadedFor, setLoadedFor] = React.useState<string>()
  React.useEffect(() => {
    if (!settings || !projectPath) return
    let active = true
    void settings
      .getReviewBuilds({ projectPath })
      .then((value) => {
        if (!active) return
        setEnabled(value)
        setLoadedFor(projectPath)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [projectPath, settings])
  if (!settings) return null
  const ready = Boolean(projectPath && loadedFor === projectPath)

  return (
    <SettingsGroup
      title="Story previews"
      description="How local previews run while you review a story."
    >
      <SettingsRow
        title="Serve a production build in review"
        description={
          project
            ? `When no agent works on a story of ${project.name}, its preview is built and served like in production, which uses far less memory. It switches back to the development server as soon as an agent works on the story, or if the build fails.`
            : "Open a project to change this setting."
        }
      >
        <Switch
          aria-label="Toggle production builds for stories in review"
          checked={ready && enabled}
          disabled={!ready}
          onCheckedChange={(checked) => {
            if (!projectPath) return
            setEnabled(checked)
            void settings
              .setReviewBuilds({ enabled: checked, projectPath })
              .catch(() => setEnabled(!checked))
          }}
        />
      </SettingsRow>
    </SettingsGroup>
  )
}
