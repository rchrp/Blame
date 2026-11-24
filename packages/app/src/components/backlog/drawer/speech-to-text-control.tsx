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
import { cn } from "@/lib/utils"
import {
  openPreferredMicrophone,
  preferredMicrophone,
  requestMicrophonePermission,
} from "@/lib/microphone-preference"
import {
  maxRecordingDurationMs,
  recordingToSpeechInput,
} from "./speech-recording-audio"

type RecordingStatus = "idle" | "starting" | "recording" | "transcribing"

export function SpeechRecordingControl({
  floating,
  onFinished,
  onTranscription,
}: {
  floating: boolean
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
  const finishingRef = React.useRef(false)
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

  const finishRecording = useLatestCallback(
    async (action: "transcribe" | "cancel") => {
      if (status !== "recording" || finishingRef.current) return
      finishingRef.current = true
      if (action === "transcribe") setStatus("transcribing")
      try {
        const audio = await stopRecording()
        if (action === "cancel") return
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
    }
  )

  React.useEffect(() => {
    if (status !== "recording") return
    const startedAt = Date.now()
    const ticker = window.setInterval(() => {
      setElapsedMs(Math.min(Date.now() - startedAt, maxRecordingDurationMs))
    }, 250)
    const deadline = window.setTimeout(() => {
      void finishRecording("transcribe")
    }, maxRecordingDurationMs)
    return () => {
      window.clearInterval(ticker)
      window.clearTimeout(deadline)
    }
  }, [status, finishRecording])

  React.useEffect(
    () => () => {
      const recorder = mediaRecorderRef.current
      if (recorder && recorder.state !== "inactive") recorder.stop()
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
        const error = new Error("The voice recording could not be completed.")
        const pending = stopPromiseRef.current
        stopPromiseRef.current = undefined
        releaseCapture()
        if (pending) {
          pending.reject(error)
          return
        }
        setStatus("idle")
        onFinished()
        toast.error(error.message)
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

  function connectAnalyser(stream: MediaStream) {
    const AudioContextConstructor =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!AudioContextConstructor) return
    const context = new AudioContextConstructor()
    const source = context.createMediaStreamSource(stream)
    const nextAnalyser = context.createAnalyser()
    nextAnalyser.fftSize = 1024
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
      floating={floating}
      analyser={analyser}
      elapsedMs={elapsedMs}
      onCancel={() => void finishRecording("cancel")}
      onConfirm={() => void finishRecording("transcribe")}
    />
  )
}

export function SpeechCapturePill({
  status,
  floating = false,
  analyser = null,
  elapsedMs = 0,
  onCancel,
  onConfirm,
}: {
  status: Exclude<RecordingStatus, "idle">
  floating?: boolean
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
      className={cn(
        "flex h-(--control-height) shrink-0 items-center overflow-hidden rounded-lg border px-1 text-muted-foreground focus-within:ring-1 focus-within:ring-ring",
        floating
          ? "border-border bg-popover shadow-lg"
          : "border-foreground/8 bg-foreground/4"
      )}
    >
      <span className="sr-only" role="status">
        {status === "starting"
          ? "Starting voice input"
          : status === "recording"
            ? "Recording voice input"
            : "Transcribing voice input"}
      </span>
      <span
        className="relative grid size-5 shrink-0 place-items-center"
        aria-hidden="true"
      >
        {status === "transcribing" ? (
          <LoaderCircleIcon className="size-3.5 motion-safe:animate-spin" />
        ) : (
          <MicIcon className="size-3.5" />
        )}
        {status === "recording" && (
          <span className="absolute top-0.5 right-0 size-1.5 rounded-full bg-destructive" />
        )}
      </span>
      {status === "recording" && (
        <>
          <VoiceTrace analyser={analyser} />
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
            className="ml-auto"
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
            className="bg-foreground text-background hover:bg-foreground/80 hover:text-background dark:hover:bg-foreground/80"
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

function VoiceTrace({ analyser }: { analyser: AnalyserNode | null }) {
  const traceRef = React.useRef<SVGPathElement>(null)
  const gradientId = React.useId()
  const reducedMotion = useReducedMotion()
  React.useEffect(() => {
    const trace = traceRef.current
    if (!trace || !analyser || reducedMotion) return
    const samples = new Float32Array(analyser.fftSize)
    const levels = new Float32Array(18)
    let lastSampleAt = -Infinity
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw)
      if (now - lastSampleAt < 29) return
      lastSampleAt = now

      analyser.getFloatTimeDomainData(samples)
      let energy = 0
      for (const sample of samples) energy += sample * sample
      const rms = Math.sqrt(energy / samples.length)
      // Keep mic noise off the trace, and give quiet speech room to show up.
      levels.copyWithin(0, 1)
      levels[levels.length - 1] = Math.min(
        1,
        Math.sqrt(Math.max(0, rms - 0.012) * 7)
      )

      let marks = ""
      for (const [index, level] of levels.entries()) {
        if (level === 0) continue
        const halfHeight = Math.round(level * 80) / 10
        const x = 2.5 + index * 3
        marks += `M${x} ${9 - halfHeight}v${halfHeight * 2}`
      }
      trace.setAttribute("d", marks)
    }
    let frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      trace.removeAttribute("d")
    }
  }, [analyser, reducedMotion])
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 56 18"
      className="mx-1 h-[18px] w-14 shrink-0 text-destructive"
      fill="none"
      strokeLinecap="round"
    >
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="0"
          x2="56"
          y1="0"
          y2="0"
        >
          <stop stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="1" stopColor="currentColor" />
        </linearGradient>
      </defs>
      <path d="M2.5 9h51" className="stroke-foreground/20" />
      <path ref={traceRef} stroke={`url(#${gradientId})`} strokeWidth="1.75" />
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
