import { terminalText } from "../../../lib/terminal-text.ts"

/**
 * Drops the wrapper Electron adds around errors coming from the desktop, and
 * the colors of command output quoted in them.
 */
export function readableFailure(message: string) {
  const text = terminalText(message)
    .replace(/^Error invoking remote method '[^']+': /, "")
    .replace(/^(?:[A-Za-z]+Error|Error): /, "")
    .trim()
  const failure = terminalText(cloudFailureMessage(text) ?? text).trim()
  return lockfileBehindMessage(failure) ?? failure
}

// An install refuses a lockfile that is behind package.json. In a story this
// means the agent is still adding dependencies, not that the setup is wrong,
// and Blame starts the preview again once the lockfile changes.
const outdatedLockfile =
  /ERR_PNPM_OUTDATED_LOCKFILE|can only install packages when your package\.json and package-lock\.json|Your lockfile needs to be updated|lockfile had changes, but lockfile is frozen/i
const lockfileBehindNote =
  "The preview starts again by itself once the lockfile is updated."

export function lockfileBehindManifest(message: string) {
  return outdatedLockfile.test(message) || message.includes(lockfileBehindNote)
}

function lockfileBehindMessage(failure: string) {
  if (!outdatedLockfile.test(failure)) return undefined
  const manifest =
    /<ROOT>\/(\S+package\.json)/.exec(failure)?.[1] ?? "package.json"
  return `This story's ${manifest} lists dependencies its lockfile does not have yet, usually because the agent is still adding them. ${lockfileBehindNote}`
}

// A cloud request error quotes the API's JSON body: keep its message.
function cloudFailureMessage(text: string) {
  const body = /^Cloud preview request failed \(\d+\): (\{[\s\S]*)$/.exec(
    text
  )?.[1]
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as {
      failure?: { message?: unknown }
      message?: unknown
    }
    const message = parsed.failure?.message ?? parsed.message
    if (typeof message === "string") return message
  } catch {
    // A body cut short: read its message field as far as it goes.
    const partial = /"message":"((?:[^"\\]|\\.)*)/.exec(body)?.[1]
    if (partial) return JSON.parse(`"${partial.replace(/\\$/, "")}"`) as string
  }
  return undefined
}
