import * as React from "react"
import { CameraIcon, ArrowLeftIcon, HomeIcon, RotateCwIcon, HammerIcon, ScrollTextIcon } from "lucide-react"
import { usePlatform } from "@/context/platform"
import type { PreviewDeviceAvailability, PreviewDeviceScope, PreviewDeviceState } from "@/context/platform-preview-devices"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { navigate } from "@/components/navigation/navigation"
import { PreviewFailurePanel } from "../preview-failure-panel"
import { SurfaceUnavailable } from "./surface-unavailable"

const unavailable: Record<string, string> = { not_macos: "iPhone previews need a Mac with Xcode.", cloud_story: "Device previews run on your computer. This story runs in the cloud.", unsupported_arch: "This device is not available for your computer's processor.", experimental_disabled: "Device previews are not enabled on this computer." }
export function DeviceSurfaceView({ scope, active, running }: { scope: PreviewDeviceScope; active: boolean; running: boolean }) {
  const client = usePlatform().previewDevices
  const [availability, setAvailability] = React.useState<PreviewDeviceAvailability>()
  const [state, setState] = React.useState<PreviewDeviceState>({ status: "stopped", message: "Build and run to open the device.", logs: [] })
  const [error, setError] = React.useState<string>()
  const [logs, showLogs] = React.useState(false)
  const [url, setUrl] = React.useState("")
  const [linkOpen, setLinkOpen] = React.useState(false)
  const [reconnect, retry] = React.useReducer((n) => n+1, 0)
  const canvas = React.useRef<HTMLCanvasElement>(null)
  const socket = React.useRef<WebSocket | undefined>(undefined)
  const autoStarted = React.useRef("")
  const identity = `${scope.storyId}:${scope.targetId}`
  const build = React.useCallback(() => { setError(undefined); void client?.start(scope).then(setState).catch((e: Error) => setError(e.message)) }, [client, scope.storyId, scope.projectId, scope.worktree, scope.targetId, scope.workspaceMode])
  React.useEffect(() => {
    if (!active || !client) return
    let cancelled = false, polling = false
    const check = async () => {
      if (polling) return; polling = true
      try {
        const [ready, current] = await Promise.all([client.availability(scope), client.state(scope)])
        if (cancelled) return
        setAvailability(ready); setState(current)
        if (ready.status === "ready" && running && current.status === "stopped" && autoStarted.current !== identity) { autoStarted.current = identity; build() }
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "The device could not be checked. Try again.") }
      finally { polling = false }
    }
    void check(); const timer = window.setInterval(() => void check(), 3000)
    window.addEventListener("focus", check)
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("focus", check) }
  }, [client, active, identity, running, build])
  React.useEffect(() => {
    if (!active || !client || state.status !== "ready") return
    let cancelled = false, decoding = false
    let connection: WebSocket | undefined
    void client.channel(scope).then(({ url }) => {
      if (cancelled) return
      connection = new WebSocket(url); connection.binaryType = "arraybuffer"; socket.current = connection
      connection.onmessage = (event) => {
        if (typeof event.data === "string") { try { const value = JSON.parse(event.data); if (value.type === "state") setError(value.message) } catch { /* Ignore an incomplete state. */ } return }
        if (decoding) return; decoding = true
        void createImageBitmap(new Blob([event.data], { type: "image/jpeg" })).then((frame) => {
          if (!cancelled && canvas.current) { canvas.current.width = frame.width; canvas.current.height = frame.height; canvas.current.getContext("2d")?.drawImage(frame, 0, 0) }
          frame.close()
        }).catch(() => undefined).finally(() => { decoding = false })
      }
      connection.onclose = () => { if (!cancelled) setError("The device screen disconnected. Reconnect to continue.") }
      connection.onerror = () => { if (!cancelled) setError("The device screen could not connect. Try again.") }
    }).catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true; connection?.close(); socket.current = undefined }
  }, [client, active, identity, state.status, reconnect])
  const send = (value: unknown) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(value)) }
  const action = (args: Record<string, unknown>) => { setError(undefined); void client?.action(scope, args).then((result) => { if (result.status !== "ready") setError(result.message) }).catch((e: Error) => setError(e.message)) }
  const screenshot = async () => { const result = await client?.action(scope, { action: "screenshot" }); const image = result?.content?.find((c) => c.type === "image"); if (!image) throw new Error(result?.message ?? "The screenshot could not be captured."); const link = document.createElement("a"); link.href = `data:image/png;base64,${image.data}`; link.download = "device.png"; link.click() }
  const touch = (event: React.PointerEvent<HTMLCanvasElement>, phase: string) => { const bounds = event.currentTarget.getBoundingClientRect(); if (phase === "down") { event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId) } send({ type: "touch", phase, x: Math.max(0,Math.min(1,(event.clientX-bounds.x)/bounds.width)), y: Math.max(0,Math.min(1,(event.clientY-bounds.y)/bounds.height)) }) }
  if (!client) return <SurfaceUnavailable message="Device previews need the desktop app." action="Review setup" onAction={() => navigate("/initialization")} />
  if (availability?.status === "unavailable") return <SurfaceUnavailable message={unavailable[availability.reason] ?? "This device cannot run here."} action="Review setup" onAction={() => navigate("/initialization")} />
  if (availability?.status === "missing-prerequisites") return <div className="h-full overflow-auto p-6"><h3 className="font-heading text-lg font-semibold">Set up device previews</h3>{state.status === "starting" && <p role="status" className="mt-2 text-sm text-muted-foreground">{state.step}</p>}<ol className="mt-4 grid gap-4">{availability.prerequisites.map((check) => <li key={check.id} className="flex items-start justify-between gap-4 border-b pb-3"><div><p className="text-sm font-medium">{check.title}{check.status === "done" ? " · Ready" : ""}</p>{check.detail && <p className="text-sm text-muted-foreground">{check.detail}</p>}{check.action?.type === "open-terminal" && <code className="mt-1 block break-all text-xs">{check.action.command}</code>}</div>{check.status !== "done" && check.action && <Button size="sm" variant="outline" disabled={state.status === "starting"} onClick={() => { void client.prerequisite(scope, check.id).catch((e: Error) => setError(e.message)) }}>{check.action.type === "open-terminal" ? "Open in Terminal" : check.action.type === "open-url" ? "Open" : check.action.label}</Button>}</li>)}</ol>{error && <p role="alert" className="mt-4 text-sm text-muted-foreground">{error}</p>}</div>
  return <div className="relative flex h-full min-h-64 flex-col">
    <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2">
      <span role="status" className="mr-auto text-sm text-muted-foreground">{state.step ?? state.message}{state.handle ? ` · ${state.handle.model} · ${state.handle.os}` : ""}</span>
      {state.handle?.platform === "android" && <Button size="sm" variant="ghost" disabled={state.status !== "ready"} onClick={() => action({ action: "button", button: "back" })}><ArrowLeftIcon />Back</Button>}
      <Button size="sm" variant="ghost" disabled={state.status !== "ready"} onClick={() => action({ action: "button", button: "home" })}><HomeIcon />Home</Button>
      <Button size="sm" variant="ghost" disabled={state.status !== "ready"} onClick={() => action({ action: "restart" })}><RotateCwIcon />Restart app</Button>
      <Button size="sm" variant="ghost" disabled={state.status === "starting"} onClick={build}><HammerIcon />Rebuild</Button>
      <Button size="sm" variant="ghost" disabled={state.status !== "ready"} onClick={() => void screenshot().catch((e: Error) => setError(e.message))}><CameraIcon />Screenshot</Button>
      <select aria-label="Device appearance" className="rounded-md border bg-background p-1 text-sm" onChange={(e) => action({ action: "appearance", value: e.target.value })}><option value="light">Light</option><option value="dark">Dark</option></select>
      <Button size="sm" variant="ghost" onClick={() => setLinkOpen((v) => !v)}>Open URL</Button>
      <Button size="sm" variant="ghost" onClick={() => showLogs((v) => !v)}><ScrollTextIcon />Logs</Button>
    </div>
    {linkOpen && <form className="flex gap-2 border-b p-2" onSubmit={(e) => { e.preventDefault(); action({ action: "open_url", url }); setLinkOpen(false) }}><Input aria-label="App deep link" placeholder="myapp://screen" value={url} onChange={(e) => setUrl(e.target.value)} /><Button size="sm" type="submit">Open</Button></form>}
    {error && <div role="alert" className="flex items-center gap-3 border-b px-3 py-2 text-sm"><span className="mr-auto">{error}</span><Button size="sm" variant="outline" onClick={() => { setError(undefined); retry() }}>Reconnect</Button></div>}
    {state.status === "failed" && !logs ? <PreviewFailurePanel message={state.message} onRestart={build} onOpenLogs={() => showLogs(true)} /> : <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/20 p-3"><canvas ref={canvas} tabIndex={0} role="application" aria-label="Device screen" className="max-h-full max-w-full touch-none rounded-2xl border outline-none focus-visible:ring-2 focus-visible:ring-ring" onPointerDown={(e) => touch(e,"down")} onPointerMove={(e) => { if (e.buttons) touch(e,"move") }} onPointerUp={(e) => touch(e,"up")} onKeyDown={(e) => { e.preventDefault(); if (e.key.length === 1) send({ type: "text", text: e.key }); else send({ type: "key", key: e.key }) }} onWheel={(e) => { const from = e.deltaY > 0 ? 0.75 : 0.25; send({type:"touch",phase:"down",x:0.5,y:from}); send({type:"touch",phase:"up",x:0.5,y:1-from}) }} onPaste={(e) => { e.preventDefault(); send({ type: "text", text: e.clipboardData.getData("text/plain") }) }} /></div>}
    {logs && <pre className="max-h-64 overflow-auto border-t p-3 text-xs whitespace-pre-wrap">{state.build?.errors?.map((e) => `${e.file ?? ""}${e.line ? `:${e.line}` : ""} ${e.message}`).join("\n")}{"\n"}{state.build?.logTail ?? state.logs.join("\n")}</pre>}
  </div>
}
