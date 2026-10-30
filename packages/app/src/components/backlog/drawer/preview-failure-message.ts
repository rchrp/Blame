import { terminalText } from "../../../lib/terminal-text.ts"

/**
 * Drops the wrapper Electron adds around errors coming from the desktop, and
 * the colors of command output quoted in them.
 */
export function readableFailure(message: string) {
  return terminalText(message)
    .replace(/^Error invoking remote method '[^']+': /, "")
    .replace(/^(?:[A-Za-z]+Error|Error): /, "")
    .trim()
}
