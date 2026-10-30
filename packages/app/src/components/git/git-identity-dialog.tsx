import * as React from "react"
import { GitCommitHorizontalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useCloudAuth } from "@/context/cloud-auth"
import { useGitIdentity } from "@/context/git-identity"

// Asks for the name and email Git signs commits with, and saves them in the
// global Git settings, as `git config --global` would.
export function GitIdentityDialog() {
  const gitIdentity = useGitIdentity()
  const prompt = gitIdentity?.prompt
  return (
    <Dialog
      open={Boolean(prompt)}
      onOpenChange={(open) => !open && gitIdentity?.close()}
    >
      <DialogContent className="sm:max-w-md">
        {prompt ? (
          // Remounts per prompt, so the fields start from what Git has.
          <GitIdentityForm
            key={`${prompt.identity?.name}\0${prompt.identity?.email}`}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function GitIdentityForm() {
  const gitIdentity = useGitIdentity()
  const user = useCloudAuth().user
  const prompt = gitIdentity?.prompt
  const [name, setName] = React.useState(
    () => prompt?.identity?.name || user?.fullName || ""
  )
  const [email, setEmail] = React.useState(
    () => prompt?.identity?.email || user?.email || ""
  )
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")
  const ready = Boolean(name.trim() && email.trim())

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!gitIdentity || !ready) return
    setSaving(true)
    setError("")
    try {
      await gitIdentity.save({ email, name })
    } catch (failure) {
      setError(readableError(failure))
      setSaving(false)
    }
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => void save(event)}>
      <DialogHeader>
        <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary dark:bg-primary/30 dark:text-blue-300">
          <GitCommitHorizontalIcon className="size-5" />
        </div>
        <DialogTitle>Set your Git name and email</DialogTitle>
        <DialogDescription className="text-pretty">
          Git signs every commit with them and won't commit without them. Blame
          saves them in your global Git settings, for all your projects.
        </DialogDescription>
      </DialogHeader>
      {prompt?.storyTitle ? (
        <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
          <span className="text-muted-foreground">Waiting for it: </span>
          {prompt.storyTitle}
        </p>
      ) : null}
      <Field>
        <FieldLabel htmlFor="git-identity-name">Name</FieldLabel>
        <Input
          id="git-identity-name"
          autoComplete="name"
          autoFocus
          placeholder="Ada Lovelace"
          spellCheck={false}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="git-identity-email">Email</FieldLabel>
        <Input
          id="git-identity-email"
          autoComplete="email"
          placeholder="ada@example.com"
          spellCheck={false}
          type="email"
          value={email}
          aria-describedby="git-identity-email-hint"
          onChange={(event) => setEmail(event.currentTarget.value)}
        />
        <FieldDescription id="git-identity-email-hint">
          If you push to GitHub, use the email of your account there so your
          commits link to you.
        </FieldDescription>
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter className="gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => gitIdentity?.close()}
        >
          Not now
        </Button>
        <Button type="submit" disabled={!ready || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  )
}

function readableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/^Error invoking remote method '[^']+': /, "")
    .replace(/^(?:[A-Za-z]+Error|Error): /, "")
}
