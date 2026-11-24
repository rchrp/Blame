import * as React from "react"
import { CheckIcon, LoaderCircleIcon, MicIcon, XIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { usePlatform } from "@/context/platform"
import { useCloudAuth } from "@/context/cloud-auth"
import { createCloudApi } from "@/lib/cloud-api"
import { speechFailureNeedsSettings } from "@blame/speech-contract"
import { speechOwnKeyStore } from "@/lib/speech-own-key-store"
import { openSpeechKeySettings } from "@/pages/settings/settings-section"
import { useLatestCallback } from "@/lib/use-latest-callback"
import {
  openPreferredMicrophone,
  preferredMicrophone,
  requestMicrophonePermission,
} from "@/lib/microphone-preference"
import { recordingToSpeechInput } from "./speech-recording-audio"

const maxRecordingDurationMs = 120_000

type RecordingStatus = "idle" | "starting" | "recording" | "transcribing"

export function SpeechRecordingControl({
  onFinished,
  onTranscription,
}: {
  onFinished: () => void
  onTranscription: (text: string) => void
}) {
  const { apiConnection } = useCloudAuth()
  const platform = usePlatform()
  const [status, setStatus] = React.useState<RecordingStatus>("idle")
  const [elapsedMs, setElapsedMs] = React.useState(0)
  const [analyser, setAnalyser] = React.useState<AnalyserNode | null>(null)
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null)
  const mediaStreamRef = React.useRef<MediaStream | null>(null)
  const audioContextRef = React.useRef<AudioContext | null>(null)
  const audioSourceRef = React.useRef<MediaStreamAudioSourceNode | null>(null)
  const chunksRef = React.useRef<Blob[]>([])
  const startedAtRef = React.useRef(0)
  const stopPromiseRef = React.useRef<
    | {
        reject: (error: unknown) => void
        resolve: (audio: Blob | null) => void
      }
    | undefined
  >(undefined)

  const start = useLatestCallback(startRecording)
  const startedRef = React.useRef(false)
  React.useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void start()
  }, [start])

  function stopRecording() {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === "inactive") return Promise.resolve(null)
    return new Promise<Blob | null>((resolve, reject) => {
      stopPromiseRef.current = { reject, resolve }
      recorder.stop()
    })
  }

  function releaseCapture() {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaStreamRef.current = null
    mediaRecorderRef.current = null
    audioSourceRef.current?.disconnect()
    audioSourceRef.current = null
    void audioContextRef.current?.close()
    audioContextRef.current = null
    setAnalyser(null)
    chunksRef.current = []
  }

  // The person's own OpenRouter key, when one is saved, takes the call: it
  // goes from the desktop to OpenRouter, not through Blame's API. A failure
  // leads back to the Settings that fix it.
  async function transcribe(input: { data: string; format: string }) {
    const speechKey = platform.speechKey
    if (
      speechKey &&
      (await speechOwnKeyStore(speechKey).current())?.configured
    ) {
      const result = await speechKey.transcribe(input)
      if (result.ok) return { text: result.text }
      if (speechFailureNeedsSettings(result.code)) {
        void speechOwnKeyStore(speechKey).refresh()
        toast.error(result.message, {
          action: { label: "Open settings", onClick: openSpeechKeySettings },
          duration: 10_000,
        })
      } else {
        toast.error(result.message)
      }
      return undefined
    }
    return createCloudApi(apiConnection).transcribeAudio(input)
  }

  const transcribeRecording = useLatestCallback(async () => {
    if (status !== "recording") return
    setStatus("transcribing")
    try {
      const audio = await stopRecording()
      if (!audio) {
        toast.info("No audio was recorded.")
        return
      }
      const result = await transcribe(await recordingToSpeechInput(audio))
      if (!result) return
      if (!result.text) {
        toast.info("No speech was detected.")
        return
      }
      onTranscription(result.text)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to transcribe the recording."
      )
    } finally {
      setElapsedMs(0)
      setStatus("idle")
      onFinished()
    }
  })

  React.useEffect(() => {
    if (status !== "recording") return
    startedAtRef.current = Date.now()
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current)
    }, 250)
    return () => window.clearInterval(timer)
  }, [status])

  React.useEffect(() => {
    if (status !== "recording" || elapsedMs < maxRecordingDurationMs) return
    void transcribeRecording()
  }, [elapsedMs, status, transcribeRecording])

  React.useEffect(
    () => () => {
      mediaRecorderRef.current?.stop()
      releaseCapture()
    },
    []
  )

  async function startRecording() {
    if (status !== "idle") return
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      toast.error("Voice input is not supported in this environment.")
      onFinished()
      return
    }

    setStatus("starting")
    try {
      await requestMicrophonePermission(platform.requestMicrophoneAccess)
      const { stream, usedSystemFallback } = await openPreferredMicrophone(
        navigator.mediaDevices,
        preferredMicrophone()
      )
      if (usedSystemFallback) {
        toast.info("Selected microphone is unavailable. Using system default.")
      }
      mediaStreamRef.current = stream
      const mimeType = supportedMimeType()
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      const recordingMimeType = recorder.mimeType || mimeType || "audio/webm"
      mediaStreamRef.current = stream
      mediaRecorderRef.current = recorder
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onerror = () => {
        stopPromiseRef.current?.reject(
          new Error("The voice recording could not be completed.")
        )
        stopPromiseRef.current = undefined
        releaseCapture()
        setStatus("idle")
        onFinished()
        toast.error("The voice recording could not be completed.")
      }
      recorder.onstop = () => {
        const audio =
          chunksRef.current.length > 0
            ? new Blob(chunksRef.current, { type: recordingMimeType })
            : null
        const pending = stopPromiseRef.current
        stopPromiseRef.current = undefined
        releaseCapture()
        pending?.resolve(audio)
      }
      connectAnalyser(stream)
      recorder.start(250)
      setElapsedMs(0)
      setStatus("recording")
    } catch (error) {
      releaseCapture()
      setStatus("idle")
      onFinished()
      if (isPermissionError(error)) {
        const openSettings = platform.openMicrophoneSettings
        toast.error("Blame cannot use your microphone", {
          action: openSettings
            ? { label: "Open Settings", onClick: () => void openSettings() }
            : undefined,
          description: openSettings
            ? "Allow Blame in the Microphone privacy settings, then try again."
            : "Allow microphone access in your browser settings, then try again.",
          duration: 10_000,
        })
      } else {
        toast.error("Unable to start voice input.")
      }
    }
  }

  async function cancelRecording() {
    if (status !== "recording") return
    await stopRecording()
    setElapsedMs(0)
    setStatus("idle")
    onFinished()
  }

  function connectAnalyser(stream: MediaStream) {
    const AudioContextConstructor =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!AudioContextConstructor) return
    const context = new AudioContextConstructor()
    const source = context.createMediaStreamSource(stream)
    const nextAnalyser = context.createAnalyser()
    nextAnalyser.fftSize = 64
    nextAnalyser.smoothingTimeConstant = 0.75
    source.connect(nextAnalyser)
    const silentOutput = context.createGain()
    silentOutput.gain.value = 0
    nextAnalyser.connect(silentOutput)
    silentOutput.connect(context.destination)
    void context.resume()
    audioContextRef.current = context
    audioSourceRef.current = source
    setAnalyser(nextAnalyser)
  }

  return (
    <SpeechCapturePill
      status={status === "idle" ? "starting" : status}
      analyser={analyser}
      elapsedMs={elapsedMs}
      onCancel={() => void cancelRecording()}
      onConfirm={() => void transcribeRecording()}
    />
  )
}

export function SpeechCapturePill({
  status,
  analyser = null,
  elapsedMs = 0,
  onCancel,
  onConfirm,
}: {
  status: Exclude<RecordingStatus, "idle">
  analyser?: AnalyserNode | null
  elapsedMs?: number
  onCancel: () => void
  onConfirm: () => void
}) {
  const reducedMotion = useReducedMotion()
  return (
    <motion.div
      initial={{ width: 32 }}
      animate={{
        width: status === "starting" ? 32 : status === "recording" ? 168 : 136,
      }}
      transition={{ duration: reducedMotion ? 0 : 0.24, ease: "easeOut" }}
      className="flex h-8 shrink-0 items-center overflow-hidden rounded-full border border-foreground/8 bg-foreground/4 px-1 text-muted-foreground focus-within:ring-1 focus-within:ring-ring"
    >
      <span className="sr-only" role="status">
        {status === "starting"
          ? "Starting voice input"
          : status === "recording"
            ? "Recording voice input"
            : "Transcribing voice input"}
      </span>
      <span className="grid size-5 shrink-0 place-items-center">
        {status === "transcribing" ? (
          <LoaderCircleIcon className="size-3.5 motion-safe:animate-spin" />
        ) : (
          <MicIcon className="size-3.5" />
        )}
      </span>
      {status === "recording" && (
        <>
          <VoiceWave analyser={analyser} />
          <span
            className="shrink-0 text-[11px] tabular-nums"
            aria-hidden="true"
          >
            {formatDuration(elapsedMs)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ml-auto rounded-full"
            aria-label="Cancel voice input"
            title="Cancel voice input"
            onClick={onCancel}
            onPointerDown={(event) => event.preventDefault()}
          >
            <XIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="rounded-full bg-foreground text-background hover:bg-foreground/80 hover:text-background dark:hover:bg-foreground/80"
            aria-label="Transcribe voice input"
            title="Transcribe voice input"
            onClick={onConfirm}
            onPointerDown={(event) => event.preventDefault()}
          >
            <CheckIcon />
          </Button>
        </>
      )}
      {status === "transcribing" && (
        <span className="ml-1 text-xs whitespace-nowrap">Transcribing…</span>
      )}
    </motion.div>
  )
}

function VoiceWave({ analyser }: { analyser: AnalyserNode | null }) {
  const waveRef = React.useRef<SVGGElement>(null)
  const reducedMotion = useReducedMotion()
  React.useEffect(() => {
    const wave = waveRef.current
    if (!wave || !analyser || reducedMotion) return
    const activeAnalyser = analyser
    const data = new Uint8Array(activeAnalyser.frequencyBinCount)
    let frame: number
    function draw() {
      activeAnalyser.getByteFrequencyData(data)
      const average = data.reduce((sum, value) => sum + value, 0) / data.length
      wave?.setAttribute(
        "transform",
        `translate(0 8) scale(1 ${0.55 + average / 120}) translate(0 -8)`
      )
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [analyser, reducedMotion])
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 48 16"
      className="mx-1 h-4 w-12 shrink-0 text-foreground/65"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <g ref={waveRef}>
        <motion.path
          d="M-24 8q4 0 6-3t6 3t6 3t6-3t6-3t6 3t6 3t6-3t6-3t6 3t6 3t6-3"
          animate={reducedMotion ? undefined : { x: [0, 24] }}
          transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }}
        />
      </g>
    </svg>
  )
}

function supportedMimeType() {
  if (typeof MediaRecorder.isTypeSupported !== "function") return ""
  return [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ].find((type) => MediaRecorder.isTypeSupported(type))
}

function formatDuration(durationMs: number) {
  const seconds = Math.floor(durationMs / 1_000)
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60
  ).padStart(2, "0")}`
}

function isPermissionError(error: unknown) {
  return (
    error instanceof DOMException &&
    ["NotAllowedError", "PermissionDeniedError"].includes(error.name)
  )
}
