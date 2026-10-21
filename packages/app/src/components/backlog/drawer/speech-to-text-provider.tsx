import * as React from "react"
import { createPortal } from "react-dom"
import { MicIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SpeechRecordingControl } from "./speech-to-text-control"
import {
  createSpeechSessionStore,
  type SpeechTarget,
} from "./speech-session-store"
import { appendComposerDraftText } from "./composer-draft-storage"
import { useLatestCallback } from "@/lib/use-latest-callback"
import { useCloudAuth } from "@/context/cloud-auth"
import { navigate } from "@/components/navigation/navigation"
import { toast } from "sonner"

const SpeechContext = React.createContext<ReturnType<
  typeof useSpeechSession
> | null>(null)

function useSpeechSession() {
  const [store] = React.useState(() =>
    createSpeechSessionStore({
      appendToDraft(draftKey, text) {
        try {
          appendComposerDraftText(localStorage, draftKey, text)
        } catch {
          return
        }
      },
    })
  )
  const [activeKey, setActiveKey] = React.useState<string>()
  const [container] = React.useState(() => document.createElement("div"))
  return { store, activeKey, setActiveKey, container }
}

export function SpeechToTextProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const session = useSpeechSession()
  return (
    <SpeechContext.Provider value={session}>
      {children}
      <SpeechRecordingHost />
    </SpeechContext.Provider>
  )
}

function useSpeechContainer() {
  const session = React.useContext(SpeechContext)!
  const { store, activeKey, container } = session
  const fallback = React.useRef<HTMLDivElement>(null)
  const version = React.useSyncExternalStore(store.subscribe, store.snapshot)
  const slot = activeKey ? store.slot(activeKey) : undefined
  React.useLayoutEffect(() => {
    const target = slot?.visible ? slot.element : fallback.current
    target?.appendChild(container)
    return () => {
      container.remove()
    }
  }, [container, slot, version])
  return {
    ...session,
    fallback,
    floating: Boolean(activeKey && !slot?.visible),
  }
}

// Away from its editor, the recording follows the user in a corner card
// that says where the text goes, and can be finished from there.
function SpeechRecordingHost() {
  const { store, activeKey, container, setActiveKey, fallback, floating } =
    useSpeechContainer()
  const target = activeKey ? store.target(activeKey) : undefined
  const deliver = useLatestCallback((key: string, text: string) => {
    const target = store.target(key)
    const reachedEditor = store.deliver(key, text)
    if (reachedEditor && !floating) return
    toast.success(target ? `Added to ${target.label}` : "Voice note saved", {
      description:
        reachedEditor || target?.draftKey
          ? "It is in the draft, ready when you go back."
          : "It will be inserted when you open it again.",
      position: "bottom-right",
    })
  })
  return (
    <>
      <div
        role="region"
        aria-label="Voice input"
        className={
          floating
            ? "pointer-events-auto fixed right-4 bottom-4 z-[100] w-max max-w-[calc(100vw-2rem)] animate-in rounded-2xl border bg-popover p-3 text-popover-foreground shadow-xl duration-200 fade-in-0 slide-in-from-bottom-2"
            : "hidden"
        }
      >
        {floating ? (
          <div className="mb-2 flex min-w-0 items-center gap-1.5 text-xs">
            <MicIcon className="size-3.5 shrink-0 text-destructive" />
            <span className="shrink-0 font-medium">Voice note</span>
            {target?.label ? (
              <span className="truncate text-muted-foreground">
                → {target.label}
              </span>
            ) : null}
          </div>
        ) : null}
        <div ref={fallback} />
      </div>
      {activeKey
        ? createPortal(
            <SpeechRecordingControl
              key={activeKey}
              onFinished={() => setActiveKey(undefined)}
              onTranscription={(text) => deliver(activeKey, text)}
            />,
            container
          )
        : null}
    </>
  )
}

type SpeechControlProps = {
  // The editor's text, so a dictation saved into its draft is not doubled.
  currentText?: () => string
  disabled?: boolean
  onStartRecording?: () => void
  onTranscription: (text: string) => void
  sessionKey?: string
  target?: SpeechTarget
}

export function SpeechToTextControl(properties: SpeechControlProps) {
  const auth = useCloudAuth()
  const session = React.useContext(SpeechContext)!
  const fallbackKey = React.useId()
  const key = properties.sessionKey ?? fallbackKey
  const slot = useSpeechSlot(key, properties)
  const startRecording = () => {
    if (!auth.license?.licensed) {
      toast.info("Cloud voice transcription requires Blame Premium.", {
        action: { label: "View Premium", onClick: () => navigate("/premium") },
      })
      return
    }
    properties.onStartRecording?.()
    session.setActiveKey(key)
  }
  return (
    <div ref={slot} className="flex min-h-8 min-w-8 items-center">
      {session.activeKey !== key ? (
        <SpeechStartButton
          disabled={properties.disabled || Boolean(session.activeKey)}
          onClick={startRecording}
        />
      ) : null}
    </div>
  )
}

function SpeechStartButton({
  disabled,
  onClick,
}: {
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Button
      aria-label="Start voice input"
      title="Start voice input"
      type="button"
      className="rounded-xl text-muted-foreground hover:text-foreground"
      size="icon-sm"
      variant="ghost"
      disabled={disabled}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <MicIcon className="size-3.5" />
    </Button>
  )
}

function useSpeechSlot(key: string, properties: SpeechControlProps) {
  const { store } = React.useContext(SpeechContext)!
  const ref = React.useRef<HTMLDivElement>(null)
  const deliver = useLatestCallback(properties.onTranscription)
  const currentText = useLatestCallback(() => properties.currentText?.() ?? "")
  const draftKey = properties.target?.draftKey
  const label = properties.target?.label
  React.useEffect(() => {
    const element = ref.current
    if (!element) return
    const unregister = store.register(key, {
      currentText,
      element,
      onTranscription: deliver,
      target: label ? { draftKey, label } : undefined,
      visible: true,
    })
    const timer = window.setTimeout(() => store.flush(key), 0)
    const observer = new IntersectionObserver(([entry]) =>
      store.visibility(key, entry.isIntersecting)
    )
    observer.observe(element)
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
      unregister()
    }
  }, [currentText, deliver, draftKey, key, label, store])
  return ref
}
