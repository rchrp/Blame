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
  return terminalText(cloudFailureMessage(text) ?? text).trim()
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
