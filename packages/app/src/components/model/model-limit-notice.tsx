// How a failure reads where a task or conversation shows it: a model's used-
// up plan or credit gets its own message (lib/model-limit.ts) and a button
// to the setting that picks another model; any other failure keeps its words.

import { toast, type ExternalToast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  modelLimit,
  modelLimitSummary,
  modelLimitTitle,
} from "@/lib/model-limit"
import { openSettings } from "@/pages/settings/settings-section"

export const chooseModelLabel = "Change model"

/** Opens Settings at Models & Providers, where the default models are. */
export function openModelSettings() {
  openSettings("models")
}

/**
 * Opens the model menu of the message box under a conversation (the
 * lowest one on screen); Settings when there is none.
 */
export function openConversationModelPicker() {
  const pickers = [
    ...document.querySelectorAll<HTMLButtonElement>("[data-model-picker]"),
  ].filter((picker) => !picker.disabled && picker.offsetParent !== null)
  const picker = pickers.at(-1)
  if (picker) picker.click()
  else openModelSettings()
}

/**
 * A failure toast. A model limit reads as one short notice: the limit as
 * its title, what could not run and until when, and the button to pick
 * another model. Every task that hits the same model's limit replaces that
 * notice instead of stacking another.
 */
export function failureToast(
  title: string,
  message: string,
  options: ExternalToast & { task?: string } = {}
) {
  const { task, ...rest } = options
  const limit = modelLimit(message)
  if (!limit) return toast.error(title, { ...rest, description: message })
  // The task's own toast (its progress) gives way to the one per model.
  if (rest.id !== undefined) toast.dismiss(rest.id)
  return toast.error(modelLimitTitle(limit), {
    ...rest,
    id: `model-limit-${limit.provider}-${limit.model}`,
    description: `${task ?? title} couldn’t run: ${modelLimitSummary(limit)}`,
    duration: 20_000,
    action: { label: chooseModelLabel, onClick: openModelSettings },
  })
}

/** The button under an inline failure, when the failure is a model limit. */
export function ModelLimitAction({
  message,
}: {
  message: string | null | undefined
}) {
  if (!modelLimit(message)) return null
  return (
    <Button
      className="mt-2 w-fit justify-self-start"
      onClick={openModelSettings}
      size="sm"
      variant="outline"
    >
      {chooseModelLabel}
    </Button>
  )
}

/**
 * For a task whose failure is otherwise quiet (a title keeps its draft):
 * a model limit is still said once, since the next task with that model
 * fails the same way. True when it was one.
 */
export function reportModelLimit(title: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (!modelLimit(message)) return false
  failureToast(title, message, { position: "bottom-right", task: title })
  return true
}
