// How a failure reads where a task or conversation shows it: a model's used-
// up plan or credit gets its own message (lib/model-limit.ts) and a button
// to the setting that picks another model; any other failure keeps its words.

import { toast, type ExternalToast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  failureMessage,
  modelLimit,
  modelLimitTitle,
  type ModelLimitSetting,
} from "@/lib/model-limit"
import { openSettings } from "@/pages/settings/settings-section"

export const chooseModelLabel = "Choose another model"

/** Opens Settings at Models & Providers, where the default models are. */
export function openModelSettings() {
  openSettings("models")
}

/** A failure toast; a model limit gets its title, message and the setting's button. */
export function failureToast(
  title: string,
  message: string,
  options: ExternalToast & { setting?: ModelLimitSetting } = {}
) {
  const { setting = "alternative", ...rest } = options
  const limit = modelLimit(message)
  if (!limit) return toast.error(title, { ...rest, description: message })
  return toast.error(`${title}: ${modelLimitTitle(limit).toLowerCase()}`, {
    ...rest,
    description: failureMessage(message, setting),
    duration: 30_000,
    action: { label: chooseModelLabel, onClick: openModelSettings },
  })
}

/** The button under an inline failure, when the failure is a model limit. */
export function ModelLimitAction({ message }: { message: string | null | undefined }) {
  if (!modelLimit(message)) return null
  return (
    <Button className="mt-2" onClick={openModelSettings} size="sm" variant="outline">
      {chooseModelLabel}
    </Button>
  )
}

/**
 * For a task whose failure is otherwise quiet (a title keeps its draft):
 * a model limit is still said once, since the next task with that model
 * fails the same way. True when it was one.
 */
export function reportModelLimit(
  title: string,
  error: unknown,
  setting: ModelLimitSetting = "alternative"
) {
  const message = error instanceof Error ? error.message : String(error)
  if (!modelLimit(message)) return false
  failureToast(title, message, { id: `model-limit-${setting}`, position: "bottom-right", setting })
  return true
}
