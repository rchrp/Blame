import * as React from "react"
import { readUiMemory, writeUiMemory } from "./ui-memory"

const storageKey = "microphone-input"
const changeEvent = "blame:microphone-input"

export const systemMicrophone = { id: "default", label: "System default" }

export function preferredMicrophone() {
  return (
    readUiMemory(
      storageKey,
      (value): value is string => typeof value === "string" && value.length > 0
    ) ?? systemMicrophone.id
  )
}

function subscribe(onChange: () => void) {
  window.addEventListener(changeEvent, onChange)
  window.addEventListener("storage", onChange)
  return () => {
    window.removeEventListener(changeEvent, onChange)
    window.removeEventListener("storage", onChange)
  }
}

export function usePreferredMicrophone() {
  const input = React.useSyncExternalStore(subscribe, preferredMicrophone)
  return [input, selectMicrophone] as const
}

function selectMicrophone(id: string) {
  writeUiMemory(storageKey, id)
  window.dispatchEvent(new Event(changeEvent))
}

export async function requestMicrophonePermission(
  requestAccess?: () => Promise<boolean>
) {
  if (requestAccess && !(await requestAccess())) {
    throw new DOMException("Microphone permission denied", "NotAllowedError")
  }
}

export async function openPreferredMicrophone(
  mediaDevices: Pick<MediaDevices, "getUserMedia">,
  deviceId: string
) {
  if (deviceId !== systemMicrophone.id) {
    try {
      const stream = await mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
      })
      return { stream, usedSystemFallback: false }
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("name" in error) ||
        (error.name !== "NotFoundError" &&
          error.name !== "OverconstrainedError")
      ) {
        throw error
      }
    }
  }

  const stream = await mediaDevices.getUserMedia({ audio: true })
  return { stream, usedSystemFallback: deviceId !== systemMicrophone.id }
}
