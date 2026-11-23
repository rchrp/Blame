import * as React from "react"
import {
  CheckIcon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  MicIcon,
  XIcon,
} from "lucide-react"
import {
  checkOpenRouterKey,
  checkSpeechModel,
  type SpeechOwnKeyChange,
  type SpeechOwnKeyStatus,
} from "@blame/speech-contract"

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useSpeechOwnKey } from "@/lib/use-speech-own-key"
import { requestedSettingsItem } from "./settings-section"

type Notice = { tone: "error" | "success"; text: string }

/**
 * Voice input with the person's own OpenRouter key, so it works without
 * Blame Cloud. Collapsed unless Settings was opened on it. The key goes to
 * the desktop to be stored in the system keychain; this page only ever gets
 * its last four characters back.
 */
export function SpeechOwnKeyGroup({
  openRouterConnected,
}: {
  openRouterConnected: boolean
}) {
  const { client, status, store } = useSpeechOwnKey()
  const [requested] = React.useState(
    () => requestedSettingsItem() === "speech-own-key"
  )
  const [openItem, setOpenItem] = React.useState(
    requested ? "speech-own-key" : ""
  )
  const section = React.useRef<HTMLElement>(null)
  const present = Boolean(client && store)
  // Settings opened on this accordion: bring it into view.
  React.useEffect(() => {
    if (requested && present)
      section.current?.scrollIntoView({ block: "start" })
  }, [requested, present])
  if (!client || !store) return null
  return (
    <section ref={section} className="border-t pt-5">
      <div className="mb-1">
        <h3 className="text-sm font-semibold">Voice input</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Dictate with the microphone button. Use your own OpenRouter key, or
          Blame Cloud.
        </p>
      </div>
      <Accordion
        type="single"
        collapsible
        value={openItem}
        onValueChange={setOpenItem}
      >
        <AccordionItem value="speech-own-key">
          <AccordionTrigger>
            <span className="flex min-w-0 items-center gap-2">
              <MicIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">Your own OpenRouter key</span>
              {status?.configured ? (
                <Badge variant="secondary">Connected</Badge>
              ) : null}
            </span>
          </AccordionTrigger>
          <AccordionContent>
            {status ? (
              <SpeechKeyForm
                openRouterConnected={openRouterConnected}
                status={status}
                onStatus={store.set}
              />
            ) : (
              <p className="text-muted-foreground">Loading…</p>
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  )
}

function SpeechKeyForm({
  onStatus,
  openRouterConnected,
  status,
}: {
  onStatus(status: SpeechOwnKeyStatus): void
  openRouterConnected: boolean
  status: SpeechOwnKeyStatus
}) {
  const platform = usePlatform()
  const { apiConnection } = useCloudAuth()
  const client = platform.speechKey!
  const [replacing, setReplacing] = React.useState(false)
  const [keyInput, setKeyInput] = React.useState("")
  // Undefined follows the saved model; a string is what is being typed.
  const [modelDraft, setModelDraft] = React.useState<string>()
  const [busy, setBusy] = React.useState<string>()
  const [notice, setNotice] = React.useState<Notice>()
  const model = modelDraft ?? status.model ?? ""
  const keyCheck = keyInput ? checkOpenRouterKey(keyInput) : undefined
  const modelCheck = checkSpeechModel(model)
  const askingForKey = !status.configured || replacing

  const apply = async (
    name: string,
    action: () => Promise<SpeechOwnKeyChange>,
    done: () => void
  ) => {
    setBusy(name)
    setNotice(undefined)
    try {
      const result = await action()
      if (result.ok) {
        onStatus(result.status)
        done()
      } else {
        setNotice({ tone: "error", text: result.message })
      }
    } catch {
      setNotice({
        tone: "error",
        text: "Blame could not save this. Try again.",
      })
    } finally {
      setBusy(undefined)
    }
  }

  const saveKey = () => {
    if (!keyCheck?.ok) return
    const key = keyCheck.value
    // The key leaves this page with the call; none is kept here.
    setKeyInput("")
    void apply(
      "key",
      () => client.save({ key }),
      () => {
        setReplacing(false)
        setNotice({ tone: "success", text: "Saved on this computer." })
      }
    )
  }

  const saveModel = () => {
    if (!modelCheck.ok) return
    void apply(
      "model",
      () => client.save({ model: model.trim() }),
      () => {
        setModelDraft(undefined)
        setNotice({ tone: "success", text: "Model saved." })
      }
    )
  }

  const useConnectedKey = () =>
    void apply(
      "provider",
      () => client.useProviderKey(apiConnection),
      () => {
        setReplacing(false)
        setNotice({
          tone: "success",
          text: "Using the OpenRouter key you connected.",
        })
      }
    )

  const test = async () => {
    setBusy("test")
    setNotice(undefined)
    try {
      const result = await client.test()
      setNotice(
        result.ok
          ? {
              tone: "success",
              text: "OpenRouter accepts this key, and the model can transcribe.",
            }
          : { tone: "error", text: result.message }
      )
    } catch {
      setNotice({ tone: "error", text: "The test could not run. Try again." })
    } finally {
      setBusy(undefined)
    }
  }

  const remove = async () => {
    setBusy("remove")
    setNotice(undefined)
    try {
      onStatus(await client.remove())
      setReplacing(false)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="flex flex-col gap-5 pt-1">
      <p className="flex items-start gap-2 text-muted-foreground">
        <LockKeyholeIcon className="mt-0.5 size-4 shrink-0" />
        <span>
          The audio goes straight from this computer to OpenRouter with your own
          key, not through Blame. The key stays on this computer, in your system
          keychain.
        </span>
      </p>

      {!status.storageAvailable ? (
        <p className="text-destructive">
          This computer has no system keychain to protect a key, so Blame does
          not store one. Voice input still works with Blame Cloud.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="speech-key-input">
            OpenRouter API key
          </label>
          {askingForKey ? (
            <>
              <div className="flex gap-2">
                <Input
                  id="speech-key-input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-or-v1-…"
                  value={keyInput}
                  aria-invalid={keyCheck?.ok === false}
                  disabled={busy !== undefined}
                  onChange={(event) => setKeyInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveKey()
                  }}
                />
                <Button
                  type="button"
                  disabled={!keyCheck?.ok || busy !== undefined}
                  onClick={saveKey}
                >
                  {busy === "key" ? (
                    <LoaderCircleIcon className="animate-spin" />
                  ) : null}
                  Save key
                </Button>
                {replacing ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setReplacing(false)
                      setKeyInput("")
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
              {keyCheck?.ok === false ? (
                <p className="text-destructive">{keyCheck.message}</p>
              ) : null}
              {openRouterConnected ? (
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy !== undefined}
                    onClick={useConnectedKey}
                  >
                    {busy === "provider" ? (
                      <LoaderCircleIcon className="animate-spin" />
                    ) : null}
                    Use my connected OpenRouter key
                  </Button>
                  <p className="mt-1.5 text-muted-foreground">
                    You connected OpenRouter in Provider connections: Blame can
                    copy that key here.
                  </p>
                </div>
              ) : null}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded-md bg-muted px-2 py-1 text-sm">
                sk-or-…{status.lastFour}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== undefined}
                onClick={() => void test()}
              >
                {busy === "test" ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : null}
                Test
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== undefined}
                onClick={() => setReplacing(true)}
              >
                Replace
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy !== undefined}
                onClick={() => void remove()}
              >
                <XIcon />
                Remove
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="speech-model-input">
          Model
        </label>
        <div className="flex gap-2">
          <Input
            id="speech-model-input"
            autoComplete="off"
            spellCheck={false}
            placeholder={status.defaultModel}
            value={model}
            aria-invalid={!modelCheck.ok}
            disabled={busy !== undefined}
            onChange={(event) => setModelDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveModel()
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={
              !modelCheck.ok ||
              busy !== undefined ||
              model.trim() === (status.model ?? "")
            }
            onClick={saveModel}
          >
            Save model
          </Button>
        </div>
        {!modelCheck.ok ? (
          <p className="text-destructive">{modelCheck.message}</p>
        ) : (
          <p className="text-muted-foreground">
            An OpenRouter model that transcribes audio, written as author/model.
            Leave it empty for {status.defaultModel}.{" "}
            <ExternalLink href="https://openrouter.ai/models">
              Browse OpenRouter's models
            </ExternalLink>
          </p>
        )}
      </div>

      {notice ? (
        <p
          role="status"
          className={
            notice.tone === "error"
              ? "flex items-start gap-1.5 text-destructive"
              : "flex items-start gap-1.5 text-emerald-600 dark:text-emerald-400"
          }
        >
          {notice.tone === "success" ? (
            <CheckIcon className="mt-0.5 size-4 shrink-0" />
          ) : null}
          {notice.text}
        </p>
      ) : null}
    </div>
  )
}

function ExternalLink({
  children,
  href,
}: {
  children: React.ReactNode
  href: string
}) {
  const platform = usePlatform()
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        if (!platform.openExternalLink) return
        event.preventDefault()
        platform.openExternalLink(href)
      }}
    >
      {children}
    </a>
  )
}
