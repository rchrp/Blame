/** Drops the wrapper Electron adds around errors coming from the desktop. */
export function readableFailure(message: string) {
  return message
    .replace(/^Error invoking remote method '[^']+': /, "")
    .replace(/^(?:[A-Za-z]+Error|Error): /, "")
    .trim()
}
