import * as React from "react"

import { usePlatform } from "@/context/platform"
import type { GitIdentity } from "@/context/platform-git-identity"

// Git signs every commit with a name and an email, and refuses to commit
// without them. This asks for them once, in a dialog, instead of letting a
// raw Git error reach a toast: before a story starts, and whenever such an
// error still comes up.

export type GitIdentityPrompt = {
  identity?: GitIdentity
  // Runs once the identity is saved, to try again what needed it.
  onSaved?: () => void
  storyTitle?: string
}

type GitIdentityContextValue = {
  close(): void
  // True when Git can commit (or cannot run at all: other checks say so).
  // Otherwise opens the dialog and returns false.
  ensure(
    input: { root?: string } & Omit<GitIdentityPrompt, "identity">
  ): Promise<boolean>
  // Opens the dialog when the error is Git asking who you are.
  handleError(error: unknown, onSaved?: () => void): boolean
  prompt?: GitIdentityPrompt
  save(input: { email: string; name: string }): Promise<void>
}

const GitIdentityContext = React.createContext<GitIdentityContextValue | null>(
  null
)

export function GitIdentityProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const client = usePlatform().gitIdentity
  const [prompt, setPrompt] = React.useState<GitIdentityPrompt>()

  const open = React.useCallback(
    (next: GitIdentityPrompt) => {
      setPrompt(next)
      if (next.identity || !client) return
      // Fills in what is already set, such as a name without an email.
      void client
        .read()
        .then((identity) =>
          setPrompt((current) =>
            current && !current.identity ? { ...current, identity } : current
          )
        )
        .catch(() => undefined)
    },
    [client]
  )

  const ensure = React.useCallback<GitIdentityContextValue["ensure"]>(
    async ({ root, ...next }) => {
      if (!client) return true
      const identity = await client.read({ root }).catch(() => undefined)
      if (!identity?.available || identity.configured) return true
      open({ ...next, identity })
      return false
    },
    [client, open]
  )

  const handleError = React.useCallback(
    (error: unknown, onSaved?: () => void) => {
      if (!client || !isGitIdentityError(error)) return false
      open({ onSaved })
      return true
    },
    [client, open]
  )

  const save = React.useCallback(
    async (input: { email: string; name: string }) => {
      if (!client) return
      await client.save(input)
      const saved = prompt
      setPrompt(undefined)
      saved?.onSaved?.()
    },
    [client, prompt]
  )

  const close = React.useCallback(() => setPrompt(undefined), [])

  const value = React.useMemo(
    () => ({ close, ensure, handleError, prompt, save }),
    [close, ensure, handleError, prompt, save]
  )
  return (
    <GitIdentityContext.Provider value={value}>
      {children}
    </GitIdentityContext.Provider>
  )
}

// Screens rendered outside the provider (tests, the status window) get none.
export function useGitIdentity() {
  return React.useContext(GitIdentityContext)
}

const identityErrors =
  /Author identity unknown|Committer identity unknown|Please tell me who you are|unable to auto-detect email address|empty ident name/i

export function isGitIdentityError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : ""
  return identityErrors.test(message)
}
