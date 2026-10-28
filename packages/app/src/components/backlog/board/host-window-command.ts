/** A foreground native command closes its runner shell when the app exits. */
export function foregroundHostWindowCommand(command: string, platform?: string) {
  if (platform === "win32") return `${command} & exit /b`
  return `sh -c '${command.replace(/'/g, "'\"'\"'")}'; exit $?`
}
