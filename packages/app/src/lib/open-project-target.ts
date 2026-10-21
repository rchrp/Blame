import { readUiMemory, writeUiMemory } from "@/lib/ui-memory"

// Where a project opens while another one is already open: ask each time,
// or the answer the user chose to remember.
export type OpenProjectTarget = "ask" | "new-window" | "this-window"

export const openProjectTargetKey = "open-project-target"

export function isOpenProjectTarget(value: unknown): value is OpenProjectTarget {
  return value === "ask" || value === "new-window" || value === "this-window"
}

export function readOpenProjectTarget() {
  return readUiMemory(openProjectTargetKey, isOpenProjectTarget) ?? "ask"
}

export function rememberOpenProjectTarget(target: OpenProjectTarget) {
  writeUiMemory(openProjectTargetKey, target)
}
