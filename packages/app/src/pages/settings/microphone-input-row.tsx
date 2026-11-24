import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  systemMicrophone,
  usePreferredMicrophone,
} from "@/lib/microphone-preference"
import { useMicrophoneInputs } from "@/lib/use-microphone-inputs"
import { SettingsRow } from "./settings-layout"

export function MicrophoneInputRow() {
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
    selected !== systemMicrophone.id &&
    !inputs.some(({ id }) => id === selected)

  return (
    <SettingsRow
      title="Microphone"
      description="Choose the input used for voice dictation."
    >
      <div className="flex w-60 max-w-full flex-col items-start gap-2 sm:items-end">
        <Select value={selected} onValueChange={select}>
          <SelectTrigger aria-label="Microphone input" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            position="popper"
            align="end"
            className="w-(--radix-select-trigger-width)"
          >
            {[systemMicrophone, ...inputs].map(({ id, label }) => (
              <SelectItem key={id} value={id} textValue={label}>
                <span className="truncate" title={label}>
                  {label}
                </span>
              </SelectItem>
            ))}
            {selectedMissing && (
              <SelectItem value={selected} disabled>
                {status === "ready"
                  ? "Unavailable microphone"
                  : "Selected microphone"}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        {status === "hidden" && (
          <>
            {error && (
              <p role="status" className="text-xs text-muted-foreground">
                {error === "denied"
                  ? "Microphone access is blocked."
                  : "Could not open the microphone."}
              </p>
            )}
            {error === "denied" && openMicrophoneSettings ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void openMicrophoneSettings()}
              >
                Open system settings
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={requesting}
                onClick={() => void requestAccess()}
              >
                {requesting
                  ? "Waiting for permission…"
                  : "Allow microphone access"}
              </Button>
            )}
          </>
        )}
        {status === "ready" && selectedMissing && (
          <p role="status" className="text-xs text-muted-foreground">
            Using the system default while disconnected.
          </p>
        )}
        {status === "ready" && inputs.length === 0 && !selectedMissing && (
          <p role="status" className="text-xs text-muted-foreground">
            No microphones detected.
          </p>
        )}
        {status === "unavailable" && (
          <p role="status" className="text-xs text-muted-foreground">
            Microphone list unavailable.
          </p>
        )}
      </div>
    </SettingsRow>
  )
}
