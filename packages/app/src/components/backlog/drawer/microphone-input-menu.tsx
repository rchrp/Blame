import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import {
  systemMicrophone,
  usePreferredMicrophone,
} from "@/lib/microphone-preference"
import { useMicrophoneInputs } from "@/lib/use-microphone-inputs"

export function MicrophoneInputMenu() {
  return (
    <ContextMenuContent
      aria-label="Microphone input"
      className="w-max max-w-[min(19rem,calc(100vw-1rem))] min-w-48"
    >
      <MicrophoneInputOptions />
    </ContextMenuContent>
  )
}

function MicrophoneInputOptions() {
  const [selected, select] = usePreferredMicrophone()
  const {
    inputs,
    status,
    error,
    requesting,
    requestAccess,
    openMicrophoneSettings,
  } = useMicrophoneInputs()
  const selectedMissing =
    status === "ready" &&
    selected !== systemMicrophone.id &&
    !inputs.some(({ id }) => id === selected)

  return (
    <>
      <ContextMenuLabel className="px-1.5 py-1 text-xs font-medium text-muted-foreground">
        Microphone input
      </ContextMenuLabel>
      <ContextMenuRadioGroup
        aria-label="Microphone"
        value={selected}
        onValueChange={select}
        className="max-h-64 overflow-y-auto"
      >
        {[systemMicrophone, ...inputs].map(({ id, label }) => (
          <ContextMenuRadioItem key={id} value={id} textValue={label}>
            <span className="truncate" title={label}>
              {label}
            </span>
          </ContextMenuRadioItem>
        ))}
      </ContextMenuRadioGroup>
      {selectedMissing && (
        <p className="px-1.5 py-1 text-xs text-muted-foreground">
          Selected microphone unavailable
        </p>
      )}
      {status === "loading" && (
        <p role="status" className="px-1.5 py-1 text-xs text-muted-foreground">
          Loading microphones…
        </p>
      )}
      {status === "ready" && inputs.length === 0 && !selectedMissing && (
        <p className="px-1.5 py-1 text-xs text-muted-foreground">
          No microphones detected
        </p>
      )}
      {status === "unavailable" && (
        <p className="px-1.5 py-1 text-xs text-muted-foreground">
          Microphone list unavailable
        </p>
      )}
      {status === "hidden" && (
        <>
          <ContextMenuSeparator />
          {error && (
            <p
              role="status"
              className="px-1.5 py-1 text-xs text-muted-foreground"
            >
              {error === "denied"
                ? "Microphone access is blocked"
                : "Could not open the microphone"}
            </p>
          )}
          {error === "denied" && openMicrophoneSettings ? (
            <ContextMenuItem onSelect={() => void openMicrophoneSettings()}>
              Open system settings
            </ContextMenuItem>
          ) : (
            <ContextMenuItem
              disabled={requesting}
              onSelect={(event) => {
                event.preventDefault()
                void requestAccess()
              }}
            >
              {requesting
                ? "Waiting for permission…"
                : "Allow microphone access"}
            </ContextMenuItem>
          )}
        </>
      )}
    </>
  )
}
