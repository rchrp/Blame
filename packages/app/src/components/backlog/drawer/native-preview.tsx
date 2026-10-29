import { cn } from "@/lib/utils"
import * as React from "react"

import {
  AlertTriangleIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"

import { type PreviewBrowserClient } from "@/context/platform"

export type PreviewState = "loading" | "loaded" | "error"

type PreviewAmbilightColor = {
  blue: number
  green: number
  red: number
}

export type NativePreviewState = {
  error?: string
  key: string
  loading: boolean
  url?: string
}

export type NativePreviewStateInput = {
  error?: string
  loading: boolean
  url?: string
}

type NativePreviewPanelProps = {
  client: PreviewBrowserClient
  devtoolsScope?: string
  onCaptureReady: (capture?: PreviewCaptureHandler) => void
  onState: (state: NativePreviewStateInput) => void
  previewKey: string
  previewState: PreviewState
  previewSessionId?: string
  previewWorktree?: string
  reloadKey: number
  sessionKey: string
  source: string
  storageKey: string
  visible: boolean
  /** Fills its container without the page margins, inside a device frame. */
  bare?: boolean
}

export type PreviewCaptureHandler = () => Promise<File | undefined>

type NativePreviewFrameProps = {
  bare?: boolean
  ambilightColor?: PreviewAmbilightColor
  browserId?: string
  client: PreviewBrowserClient
  previewState: PreviewState
  surfaceRef: React.RefObject<HTMLDivElement | null>
}

type NativePreviewBoundsStability = {
  boundsKey: string
  stableFrames: number
}

type NativePreviewSession = {
  browserId?: string
  client: PreviewBrowserClient
  loading?: Promise<string>
  references: number
  releaseAt: number
  source?: string
  state?: NativePreviewStateInput
  storageKey: string
  previewSessionId?: string
  previewWorktree?: string
  timeout?: number
}

export const nativePreviewRetainedSessionLimit = 3

const nativePreviewRetentionMs = 30 * 60_000

const nativePreviewStableFrames = 3

const nativePreviewSessions = new Map<string, NativePreviewSession>()

export function NativePreviewWarmup({
  client,
  devtoolsScope,
  onState,
  previewWorktree,
  sessionKey,
  source,
  storageKey,
}: {
  client: PreviewBrowserClient
  devtoolsScope?: string
  onState?: (state: NativePreviewStateInput) => void
  previewWorktree?: string
  sessionKey: string
  source: string
  storageKey: string
}) {
  const handleState = React.useCallback(
    (state: NativePreviewStateInput) => {
      updateNativePreviewSessionState(sessionKey, state)
      onState?.(state)
    },
    [onState, sessionKey]
  )
  const browserId = useNativePreviewId(
    client,
    sessionKey,
    storageKey,
    handleState,
    undefined,
    previewWorktree
  )

  useNativePreviewState(client, browserId, handleState)
  useNativePreviewLoad(client, browserId, sessionKey, source, handleState)
  useNativePreviewDevtoolsScope(client, browserId, devtoolsScope)

  return null
}

export function NativePreviewPanel({
  client,
  devtoolsScope,
  onCaptureReady,
  onState,
  previewKey,
  previewState,
  previewSessionId,
  previewWorktree,
  reloadKey,
  sessionKey,
  source,
  storageKey,
  visible,
  bare,
}: NativePreviewPanelProps) {
  const surfaceRef = React.useRef<HTMLDivElement>(null)
  const handleState = React.useCallback(
    (state: NativePreviewStateInput) => {
      updateNativePreviewSessionState(sessionKey, state)
      onState(state)
    },
    [onState, sessionKey]
  )
  const browserId = useNativePreviewId(
    client,
    sessionKey,
    storageKey,
    handleState,
    previewSessionId,
    previewWorktree
  )
  const ambilightColor = useNativePreviewAmbilightColor(
    client,
    browserId,
    previewKey,
    visible && previewState === "loaded"
  )

  useNativePreviewState(client, browserId, handleState)
  useNativePreviewLoad(client, browserId, sessionKey, source, handleState)
  useNativePreviewDevtoolsScope(client, browserId, devtoolsScope)
  useNativePreviewReload(client, browserId, reloadKey, source, handleState)
  useNativePreviewCapture(client, browserId, source, onCaptureReady)
  useNativePreviewBounds(
    client,
    browserId,
    surfaceRef,
    visible && previewState === "loaded"
  )

  return (
    <NativePreviewFrame
      bare={bare}
      ambilightColor={ambilightColor}
      browserId={browserId}
      client={client}
      previewState={previewState}
      surfaceRef={surfaceRef}
    />
  )
}

function useNativePreviewCapture(
  client: PreviewBrowserClient,
  browserId: string | undefined,
  source: string,
  onCaptureReady: (capture?: PreviewCaptureHandler) => void
) {
  React.useEffect(() => {
    if (!browserId) {
      onCaptureReady(undefined)
      return
    }
    onCaptureReady(() => captureNativePreview(client, browserId, source))
    return () => onCaptureReady(undefined)
  }, [browserId, client, onCaptureReady, source])
}

function NativePreviewFrame({
  bare,
  ambilightColor,
  browserId,
  client,
  previewState,
  surfaceRef,
}: NativePreviewFrameProps) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden",
        !bare && "bg-muted/20 px-4 pt-[72px] pb-4"
      )}
    >
      <div
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden bg-background transition-shadow duration-700",
          !bare && "rounded-lg border"
        )}
        style={{ boxShadow: previewAmbilightShadow(ambilightColor) }}
      >
        <div ref={surfaceRef} className="h-full w-full" />
        {previewState === "loading" && <PreviewLoadingState />}
        {previewState === "error" && (
          <PreviewErrorState
            onReload={() => reloadNativePreview(client, browserId)}
          />
        )}
      </div>
    </div>
  )
}

async function acquireNativePreviewSession(
  client: PreviewBrowserClient,
  key: string,
  storageKey: string,
  previewSessionId?: string,
  previewWorktree?: string
) {
  const session = nativePreviewSession(
    client,
    key,
    storageKey,
    previewSessionId,
    previewWorktree
  )
  session.references += 1
  clearNativePreviewRetention(session)
  if (!session.browserId) {
    session.loading ??= createNativePreviewSession(session)
    await session.loading
  }
  return session
}

function nativePreviewSession(
  client: PreviewBrowserClient,
  key: string,
  storageKey: string,
  previewSessionId?: string,
  previewWorktree?: string
): NativePreviewSession {
  const current = nativePreviewSessions.get(key)
  if (current) return current
  const session: NativePreviewSession = {
    client,
    references: 0,
    releaseAt: 0,
    storageKey,
    previewSessionId,
    previewWorktree,
  }
  nativePreviewSessions.set(key, session)
  return session
}

async function createNativePreviewSession(session: NativePreviewSession) {
  try {
    const key = Array.from(nativePreviewSessions.entries()).find(
      ([, candidate]) => candidate === session
    )?.[0]
    if (!key) throw new Error("Preview session key is unavailable")
    const { id } = await session.client.create({
      storageKey: session.storageKey,
      previewSessionId: session.previewSessionId,
      previewWorktree: session.previewWorktree,
    })
    if (nativePreviewSessions.get(key) !== session) {
      await session.client.destroy({ id }).catch(() => false)
      throw new Error("Preview session was released during creation")
    }
    session.browserId = id
    return id
  } finally {
    session.loading = undefined
  }
}

function releaseNativePreviewSession(key: string) {
  const session = nativePreviewSessions.get(key)
  if (!session) return
  session.references = Math.max(0, session.references - 1)
  if (session.references > 0) return
  session.releaseAt = Date.now()
  hideNativePreviewSession(session)
  clearNativePreviewRetention(session)
  session.timeout = window.setTimeout(
    () => destroyNativePreviewSession(key),
    nativePreviewRetentionMs
  )
  trimNativePreviewSessions()
}

function updateNativePreviewSessionState(
  key: string,
  state: NativePreviewStateInput
) {
  const session = nativePreviewSessions.get(key)
  if (session) session.state = state
}

function clearNativePreviewRetention(session: NativePreviewSession) {
  if (!session.timeout) return
  window.clearTimeout(session.timeout)
  session.timeout = undefined
}

function hideNativePreviewSession(session: NativePreviewSession) {
  if (!session.browserId) return
  void session.client
    .setBounds({
      bounds: hiddenPreviewBrowserBounds(),
      id: session.browserId,
      visible: false,
    })
    .catch(() => undefined)
}

function destroyNativePreviewSession(key: string) {
  const session = nativePreviewSessions.get(key)
  if (!session || session.references > 0) return
  nativePreviewSessions.delete(key)
  clearNativePreviewRetention(session)
  if (session.browserId) {
    void session.client.destroy({ id: session.browserId }).catch(() => false)
  }
}

function trimNativePreviewSessions() {
  const retained = Array.from(nativePreviewSessions.entries())
    .filter(([, session]) => session.references === 0)
    .sort((left, right) => left[1].releaseAt - right[1].releaseAt)
  while (retained.length > nativePreviewRetainedSessionLimit) {
    const next = retained.shift()
    if (next) destroyNativePreviewSession(next[0])
  }
}

export function destroyReleasedNativePreviewSessions() {
  Array.from(nativePreviewSessions.entries()).forEach(([key, session]) => {
    if (session.references === 0) destroyNativePreviewSession(key)
  })
}

function useNativePreviewId(
  client: PreviewBrowserClient,
  sessionKey: string,
  storageKey: string,
  onState: (state: NativePreviewStateInput) => void,
  previewSessionId?: string,
  previewWorktree?: string
) {
  const [browserId, setBrowserId] = React.useState<string>()

  React.useEffect(() => {
    let cancelled = false
    void acquireNativePreviewSession(
      client,
      sessionKey,
      storageKey,
      previewSessionId,
      previewWorktree
    )
      .then((session) => {
        if (cancelled) {
          return
        }
        if (session.state) onState(session.state)
        setBrowserId(session.browserId)
      })
      .catch((error) => {
        releaseNativePreviewSession(sessionKey)
        if (!cancelled) {
          onState(
            nativePreviewErrorState(error, "Unable to create preview", "")
          )
        }
      })
    return () => {
      if (cancelled) {
        return
      }
      cancelled = true
      setBrowserId(undefined)
      releaseNativePreviewSession(sessionKey)
    }
  }, [
    client,
    onState,
    previewSessionId,
    previewWorktree,
    sessionKey,
    storageKey,
  ])

  return browserId
}

function reloadNativePreview(
  client: PreviewBrowserClient,
  browserId: string | undefined
) {
  if (browserId) void client.reload({ id: browserId }).catch(() => false)
}

function useNativePreviewState(
  client: PreviewBrowserClient,
  browserId: string | undefined,
  onState: (state: NativePreviewStateInput) => void
) {
  React.useEffect(() => {
    if (!browserId) return
    return client.onState({ id: browserId }, onState)
  }, [browserId, client, onState])
}

function useNativePreviewLoad(
  client: PreviewBrowserClient,
  browserId: string | undefined,
  sessionKey: string,
  source: string,
  onState: (state: NativePreviewStateInput) => void
) {
  const sourceRef = React.useRef(source)

  React.useEffect(() => {
    if (!browserId) return
    const session = nativePreviewSessions.get(sessionKey)
    const sourceChanged = sourceRef.current !== source
    sourceRef.current = source
    if (session?.source && !sourceChanged && !session.state?.error) {
      if (session.state) onState(session.state)
      return
    }
    if (session) session.source = source
    onState({ loading: true, url: source })
    void client
      .load({ id: browserId, url: source })
      .then((loaded) => {
        if (!loaded) throw new Error("Preview browser is unavailable")
      })
      .catch((error) => {
        onState(
          nativePreviewErrorState(error, "Unable to load preview", source)
        )
      })
  }, [browserId, client, onState, sessionKey, source])
}

function useNativePreviewDevtoolsScope(
  client: PreviewBrowserClient,
  browserId: string | undefined,
  devtoolsScope: string | undefined
) {
  React.useEffect(() => {
    if (!browserId || !devtoolsScope) return
    void client
      .setDevtoolsScope({
        id: browserId,
        scope: devtoolsScope,
      })
      .catch(() => false)
  }, [browserId, client, devtoolsScope])
}

function useNativePreviewReload(
  client: PreviewBrowserClient,
  browserId: string | undefined,
  reloadKey: number,
  source: string,
  onState: (state: NativePreviewStateInput) => void
) {
  const reloadKeyRef = React.useRef(reloadKey)

  React.useEffect(() => {
    if (!browserId || reloadKeyRef.current === reloadKey) return
    reloadKeyRef.current = reloadKey
    onState({ loading: true, url: source })
    void client
      .reload({ id: browserId })
      .then((reloaded) => {
        if (!reloaded) throw new Error("Preview browser is unavailable")
      })
      .catch((error) => {
        onState(
          nativePreviewErrorState(error, "Unable to reload preview", source)
        )
      })
  }, [browserId, client, onState, reloadKey, source])
}

function useNativePreviewBounds(
  client: PreviewBrowserClient,
  browserId: string | undefined,
  surfaceRef: React.RefObject<HTMLDivElement | null>,
  visible: boolean
) {
  const lastBoundsRef = React.useRef<string>("")
  const stabilityRef = React.useRef<NativePreviewBoundsStability>({
    boundsKey: "",
    stableFrames: 0,
  })

  React.useEffect(() => {
    if (!browserId) return
    const updateBounds = () =>
      syncNativePreviewBounds(
        client,
        browserId,
        surfaceRef,
        visible,
        lastBoundsRef,
        stabilityRef
      )
    updateBounds()
    const stopFrameSync = syncNativePreviewBoundsDuringLayout(
      updateBounds,
      visible
    )
    const observer = new ResizeObserver(updateBounds)
    if (surfaceRef.current) observer.observe(surfaceRef.current)
    window.addEventListener("resize", updateBounds)
    const updateBoundsOnScroll = animationFrameThrottle(updateBounds)
    window.addEventListener("scroll", updateBoundsOnScroll, true)
    return () => {
      stopFrameSync()
      observer.disconnect()
      window.removeEventListener("resize", updateBounds)
      window.removeEventListener("scroll", updateBoundsOnScroll, true)
      updateBoundsOnScroll.cancel()
      void client.setBounds({
        bounds: hiddenPreviewBrowserBounds(),
        id: browserId,
        visible: false,
      })
      stabilityRef.current = { boundsKey: "", stableFrames: 0 }
    }
  }, [browserId, client, surfaceRef, visible])
}

function syncNativePreviewBoundsDuringLayout(
  updateBounds: () => void,
  enabled: boolean
) {
  if (!enabled) return () => undefined
  let frame = 0
  let remainingFrames = 45
  const updateFrame = () => {
    updateBounds()
    remainingFrames -= 1
    if (remainingFrames > 0) frame = window.requestAnimationFrame(updateFrame)
  }
  frame = window.requestAnimationFrame(updateFrame)
  return () => window.cancelAnimationFrame(frame)
}

function animationFrameThrottle(callback: () => void) {
  let frame = 0
  const throttled = () => {
    if (frame) return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      callback()
    })
  }
  throttled.cancel = () => {
    if (frame) window.cancelAnimationFrame(frame)
    frame = 0
  }
  return throttled
}

function syncNativePreviewBounds(
  client: PreviewBrowserClient,
  browserId: string,
  surfaceRef: React.RefObject<HTMLDivElement | null>,
  visible: boolean,
  lastBoundsRef: React.MutableRefObject<string>,
  stabilityRef: React.MutableRefObject<NativePreviewBoundsStability>
) {
  const bounds = nativePreviewSurfaceBounds(surfaceRef.current)
  const boundsKey = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`
  if (!visible) stabilityRef.current = { boundsKey: "", stableFrames: 0 }
  const shouldShow =
    visible &&
    bounds.height > 0 &&
    bounds.width > 0 &&
    stableNativePreviewBounds(boundsKey, stabilityRef)
  const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${shouldShow}`
  if (lastBoundsRef.current === key) return
  lastBoundsRef.current = key
  void client
    .setBounds({ bounds, id: browserId, visible: shouldShow })
    .then((applied) => {
      if (!applied && lastBoundsRef.current === key) {
        lastBoundsRef.current = ""
      }
    })
    .catch(() => {
      if (lastBoundsRef.current === key) lastBoundsRef.current = ""
    })
}

function stableNativePreviewBounds(
  boundsKey: string,
  stabilityRef: React.MutableRefObject<NativePreviewBoundsStability>
) {
  const current = stabilityRef.current
  if (current.boundsKey !== boundsKey) {
    stabilityRef.current = { boundsKey, stableFrames: 0 }
    return false
  }
  const stableFrames = current.stableFrames + 1
  stabilityRef.current = { boundsKey, stableFrames }
  return stableFrames >= nativePreviewStableFrames
}

function useNativePreviewAmbilightColor(
  client: PreviewBrowserClient,
  browserId: string | undefined,
  previewKey: string,
  visible: boolean
) {
  const [sample, setSample] = React.useState<{
    color?: PreviewAmbilightColor
    key: string
  }>()

  React.useEffect(() => {
    if (!browserId || !visible) return
    let cancelled = false
    const sampleFrame = async () => {
      const color = await captureNativePreviewAmbilight(client, browserId)
      if (cancelled) return
      setSample((current) =>
        current?.key === previewKey && sameAmbilightColor(current.color, color)
          ? current
          : { color, key: previewKey }
      )
    }
    const timeout = window.setTimeout(sampleFrame, 350)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [browserId, client, previewKey, visible])

  return sample?.key === previewKey ? sample.color : undefined
}

async function captureNativePreviewAmbilight(
  client: PreviewBrowserClient,
  browserId: string
) {
  try {
    const image = await client.capture({ id: browserId, size: "thumbnail" })
    return image ? await readImageAmbilightColor(image) : undefined
  } catch {
    return undefined
  }
}

async function captureNativePreview(
  client: PreviewBrowserClient,
  browserId: string,
  source: string
) {
  const image = await client.capture({ id: browserId, size: "full" })
  if (!image) return undefined
  return dataUrlFile(image, previewCaptureFilename(source))
}

export function nativePreviewStatus(state: NativePreviewState | undefined) {
  if (!state || state.loading) return "loading"
  if (state.error) return "error"
  return "loaded"
}

function nativePreviewErrorState(
  error: unknown,
  fallback: string,
  url: string
): NativePreviewStateInput {
  return {
    error: error instanceof Error ? error.message : fallback,
    loading: false,
    url,
  }
}

export function PreviewLoadingState() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background">
      <LoaderCircleIcon className="size-10 animate-spin text-muted-foreground" />
    </div>
  )
}

export function PreviewErrorState({ onReload }: { onReload: () => void }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background/95 p-8">
      <div className="flex max-w-sm flex-col items-center gap-4 rounded-lg border bg-background px-8 py-7 text-center shadow-sm">
        <div className="rounded-full bg-destructive/10 p-3 text-destructive">
          <AlertTriangleIcon className="size-6" />
        </div>
        <div className="space-y-1">
          <h3 className="font-heading text-lg font-semibold">
            Preview indisponible
          </h3>
          <p className="text-sm text-muted-foreground">
            Le serveur ne répond pas pour le moment.
          </p>
        </div>
        <Button size="sm" type="button" variant="outline" onClick={onReload}>
          <RefreshCwIcon />
          Réessayer
        </Button>
      </div>
    </div>
  )
}

function averageAmbilightColor(colors: PreviewAmbilightColor[]) {
  if (!colors.length) return undefined
  const total = colors.reduce<{
    blue: number
    green: number
    red: number
    weight: number
  }>(
    (result, color) => {
      const weight = ambilightColorWeight(color)
      return {
        blue: result.blue + color.blue * weight,
        green: result.green + color.green * weight,
        red: result.red + color.red * weight,
        weight: result.weight + weight,
      }
    },
    { blue: 0, green: 0, red: 0, weight: 0 }
  )
  if (!total.weight) return undefined
  return {
    blue: Math.round(total.blue / total.weight),
    green: Math.round(total.green / total.weight),
    red: Math.round(total.red / total.weight),
  }
}

function isUsefulAmbilightColor(color: PreviewAmbilightColor) {
  const luminance =
    (0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue) / 255
  return (
    luminance > 0.05 && luminance < 0.96 && ambilightSaturation(color) > 0.04
  )
}

function ambilightColorWeight(color: PreviewAmbilightColor) {
  return 0.4 + ambilightSaturation(color) * 2
}

function ambilightSaturation(color: PreviewAmbilightColor) {
  const red = color.red / 255
  const green = color.green / 255
  const blue = color.blue / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  if (!max) return 0
  return (max - min) / max
}

function clampColorValue(value: number) {
  if (Number.isNaN(value)) return 0
  return Math.max(0, Math.min(255, Math.round(value)))
}

function readImageAmbilightColor(dataUrl: string) {
  return new Promise<PreviewAmbilightColor | undefined>((resolve) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement("canvas")
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext("2d")
      if (!context) {
        resolve(undefined)
        return
      }
      context.drawImage(image, 0, 0)
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data
      resolve(averageAmbilightColor(readImageAmbilightPixels(data)))
    }
    image.onerror = () => resolve(undefined)
    image.src = dataUrl
  })
}

function readImageAmbilightPixels(data: Uint8ClampedArray) {
  const colors: PreviewAmbilightColor[] = []
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 60) continue
    const color = {
      blue: clampColorValue(data[index + 2]),
      green: clampColorValue(data[index + 1]),
      red: clampColorValue(data[index]),
    }
    if (isUsefulAmbilightColor(color)) colors.push(color)
  }
  return colors
}

function dataUrlFile(dataUrl: string, filename: string) {
  const [header, data] = dataUrl.split(",")
  const type = header?.match(/^data:([^;]+)/)?.[1] ?? "image/png"
  const bytes = Uint8Array.from(atob(data ?? ""), (character) =>
    character.charCodeAt(0)
  )
  return new File([bytes], filename, { type })
}

function previewCaptureFilename(source: string) {
  return `preview-${previewCaptureHost(source)}-${previewCaptureTimestamp()}.png`
}

function previewCaptureHost(source: string) {
  try {
    return new URL(source).host.replaceAll(/[^a-z0-9.-]/gi, "-")
  } catch {
    return "capture"
  }
}

function previewCaptureTimestamp() {
  return new Date().toISOString().replaceAll(/[:.]/g, "-")
}

function previewBrowserBounds(rect: DOMRect) {
  return {
    height: rect.height,
    width: rect.width,
    x: rect.x,
    y: rect.y,
  }
}

function hiddenPreviewBrowserBounds() {
  return { height: 0, width: 0, x: 0, y: 0 }
}

function nativePreviewSurfaceBounds(element: HTMLDivElement | null) {
  return element
    ? previewBrowserBounds(element.getBoundingClientRect())
    : { height: 0, width: 0, x: 0, y: 0 }
}

function sameAmbilightColor(
  current: PreviewAmbilightColor | undefined,
  next: PreviewAmbilightColor | undefined
) {
  if (!current || !next) return current === next
  return (
    current.red === next.red &&
    current.green === next.green &&
    current.blue === next.blue
  )
}

export function previewAmbilightShadow(
  color: PreviewAmbilightColor | undefined
) {
  if (!color) return "0 24px 80px rgb(0 0 0 / 0.34)"
  return [
    `0 32px 120px rgb(${color.red} ${color.green} ${color.blue} / 0.58)`,
    `0 0 70px rgb(${color.red} ${color.green} ${color.blue} / 0.42)`,
    `0 0 28px rgb(${color.red} ${color.green} ${color.blue} / 0.5)`,
    "0 16px 44px rgb(0 0 0 / 0.28)",
  ].join(", ")
}
