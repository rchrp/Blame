import * as React from "react"
import { CheckIcon, LoaderCircleIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { usePlatform } from "@/context/platform"
import { useCloudAuth } from "@/context/cloud-auth"
import { createCloudApi } from "@/lib/cloud-api"
import { useLatestCallback } from "@/lib/use-latest-callback"

const maxRecordingDurationMs = 120_000

type RecordingStatus = "idle" | "starting" | "recording" | "transcribing"

type RecordedAudio = {
  blob: Blob
  format: string
}

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
  const mimeTypeRef = React.useRef("audio/webm")
  const startedAtRef = React.useRef(0)
  const stopPromiseRef = React.useRef<
    | {
        reject: (error: unknown) => void
        resolve: (audio: RecordedAudio | null) => void
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
    return new Promise<RecordedAudio | null>((resolve, reject) => {
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

  const transcribeRecording = useLatestCallback(async () => {
    if (status !== "recording") return
    setStatus("transcribing")
    try {
      const audio = await stopRecording()
      if (!audio) {
        toast.info("No audio was recorded.")
        return
      }
      const data = await blobToBase64(audio.blob)
      const result = await createCloudApi(apiConnection).transcribeAudio({
        data,
        format: audio.format,
      })
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
      if (
        platform.requestMicrophoneAccess &&
        !(await platform.requestMicrophoneAccess())
      ) {
        throw new DOMException(
          "Microphone permission denied",
          "NotAllowedError"
        )
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      const mimeType = supportedMimeType()
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      mimeTypeRef.current = recorder.mimeType || mimeType || "audio/webm"
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
            ? {
                blob: new Blob(chunksRef.current, {
                  type: mimeTypeRef.current,
                }),
                format: audioFormat(mimeTypeRef.current),
              }
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

  if (status === "idle") return null

  if (status === "starting") {
    return (
      <Button
        aria-label="Starting voice input"
        className="rounded-xl text-muted-foreground"
        disabled
        size="icon-sm"
        title="Starting voice input"
        type="button"
        variant="ghost"
      >
        <LoaderCircleIcon className="size-3.5 animate-spin" />
      </Button>
    )
  }

  if (status === "transcribing") {
    return (
      <div className="flex items-center gap-1">
        <span className="max-w-32 truncate text-xs text-muted-foreground">
          Transcribing…
        </span>
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-3.5 animate-spin text-blue-500"
        />
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span
        aria-live="polite"
        className="flex min-w-0 items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-1 text-xs text-destructive"
      >
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" />
        <AudioSpectrum analyser={analyser} />
        <span className="tabular-nums">{formatDuration(elapsedMs)}</span>
      </span>
      <Button
        aria-label="Cancel voice input"
        className="rounded-xl text-muted-foreground hover:text-foreground"
        size="icon-sm"
        title="Cancel voice input"
        type="button"
        variant="ghost"
        onClick={() => void cancelRecording()}
        onPointerDown={(event) => event.preventDefault()}
      >
        <XIcon className="size-3.5" />
      </Button>
      <Button
        aria-label="Transcribe voice input"
        className="rounded-xl text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
        size="icon-sm"
        title="Transcribe voice input"
        type="button"
        variant="ghost"
        onClick={() => void transcribeRecording()}
        onPointerDown={(event) => event.preventDefault()}
      >
        <CheckIcon className="size-3.5" />
      </Button>
    </div>
  )
}

function AudioSpectrum({ analyser }: { analyser: AnalyserNode | null }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !analyser) return
    const context = canvas.getContext("2d")
    if (!context) return
    const activeAnalyser = analyser
    const canvasElement = canvas
    const drawingContext = context
    const ratio = window.devicePixelRatio || 1
    const width = 88
    const height = 20
    canvas.width = width * ratio
    canvas.height = height * ratio
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    drawingContext.scale(ratio, ratio)
    const data = new Uint8Array(activeAnalyser.frequencyBinCount)
    const barCount = 18
    const barWidth = 3
    const gap = 2
    let frame = 0

    function draw() {
      activeAnalyser.getByteFrequencyData(data)
      drawingContext.clearRect(0, 0, width, height)
      drawingContext.fillStyle = getComputedStyle(canvasElement).color
      for (let index = 0; index < barCount; index += 1) {
        const dataIndex = Math.floor((index / barCount) * data.length)
        const level = data[dataIndex] ?? 0
        const barHeight = Math.max(2, (level / 255) * height)
        drawingContext.fillRect(
          index * (barWidth + gap),
          (height - barHeight) / 2,
          barWidth,
          barHeight
        )
      }
      frame = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(frame)
  }, [analyser])

  return (
    <canvas ref={canvasRef} aria-hidden="true" className="text-destructive" />
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

function audioFormat(mimeType: string) {
  const mime = mimeType.split(";", 1)[0]
  return mime.slice(mime.indexOf("/") + 1) || "webm"
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error("Unable to read the recording."))
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      const separator = value.indexOf(",")
      resolve(separator >= 0 ? value.slice(separator + 1) : value)
    }
    reader.readAsDataURL(blob)
  })
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
