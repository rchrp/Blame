import * as React from "react"
import { usePlatform } from "@/context/platform"
import { requestMicrophonePermission } from "./microphone-preference"

type MicrophoneInput = { id: string; label: string }
type InputList = {
  inputs: MicrophoneInput[]
  status: "loading" | "ready" | "hidden" | "unavailable"
}

const unavailableInputs: InputList = { inputs: [], status: "unavailable" }

export function useMicrophoneInputs() {
  const platform = usePlatform()
  const mediaDevices = navigator.mediaDevices
  const [list, setList] = React.useState<InputList>({
    inputs: [],
    status: "loading",
  })
  const [requesting, setRequesting] = React.useState(false)
  const [error, setError] = React.useState<"denied" | "unavailable">()
  const enumeration = React.useRef({ revision: 0 })

  const refresh = React.useCallback(() => {
    const state = enumeration.current
    const revision = ++state.revision
    const update = (inputs: InputList) => {
      if (state.revision === revision) setList(inputs)
    }
    return Promise.resolve(mediaDevices?.enumerateDevices?.()).then(
      (devices) =>
        update(devices ? microphoneInputs(devices) : unavailableInputs),
      () => update(unavailableInputs)
    )
  }, [mediaDevices])

  React.useEffect(() => {
    const state = enumeration.current
    void refresh()
    mediaDevices?.addEventListener("devicechange", refresh)
    window.addEventListener("focus", refresh)
    return () => {
      state.revision++
      mediaDevices?.removeEventListener("devicechange", refresh)
      window.removeEventListener("focus", refresh)
    }
  }, [mediaDevices, refresh])

  async function requestAccess() {
    setError(undefined)
    setRequesting(true)
    let stream: MediaStream | undefined
    try {
      await requestMicrophonePermission(platform.requestMicrophoneAccess)
      stream = await mediaDevices.getUserMedia({ audio: true })
      await refresh()
    } catch (error) {
      setError(
        error instanceof DOMException &&
          [
            "NotAllowedError",
            "PermissionDeniedError",
            "SecurityError",
          ].includes(error.name)
          ? "denied"
          : "unavailable"
      )
    } finally {
      stream?.getTracks().forEach((track) => track.stop())
      setRequesting(false)
    }
  }

  return {
    ...list,
    error,
    requesting,
    requestAccess,
    openMicrophoneSettings: platform.openMicrophoneSettings,
  }
}

function microphoneInputs(devices: MediaDeviceInfo[]): InputList {
  const microphones = devices.filter((device) => device.kind === "audioinput")
  const inputs = microphones
    .filter(
      ({ deviceId }) =>
        deviceId && deviceId !== "default" && deviceId !== "communications"
    )
    .map(({ deviceId, label }, index) => ({
      id: deviceId,
      label: label || `Microphone ${index + 1}`,
    }))
  return {
    inputs,
    status:
      microphones.length > 0 &&
      microphones.every(({ deviceId, label }) => !deviceId || !label)
        ? "hidden"
        : "ready",
  }
}
