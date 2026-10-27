import type { TerminalClient } from "@/context/platform"

export async function writeProjectCommand(
  terminal: Pick<TerminalClient, "write">,
  sessionId: string,
  command: string
) {
  // A terminal receives keystrokes: Enter is CR (also used by xterm), not LF.
  // In particular, ConPTY/cmd.exe can echo an LF-terminated command without
  // executing it. The runtime's pipe transport already converts CR back to LF.
  const written = await terminal.write({
    id: sessionId,
    data: `${command.replace(/\r?\n/g, "\r")}\r`,
  })
  if (!written) throw new Error("Unable to write the launch command")
}
