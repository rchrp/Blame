// A Git page failure as a toast says: what failed in its title, and Git's
// own reason in its description, without the IPC wrapper or the command
// line Node puts first ("Command failed: git commit …"), which read as an
// interface error (2026-11-26).

export function gitErrorReason(message: string) {
  const text = message
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "")
    .trim()
  const reason = text
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line, index) =>
        line &&
        !(index === 0 && line.startsWith("Command failed: ")) &&
        // Git's hints: "(use "git add" …)".
        !line.startsWith("(")
    )
    .join("\n")
  return reason || text
}

export function gitActionFailure(label: string) {
  if (label === "Committing") return "Couldn't commit"
  if (label === "Committing and pushing") return "Couldn't commit and push"
  if (label === "Pushing") return "Couldn't push"
  if (label === "Deleting file") return "Couldn't delete the file"
  if (label === "Git add") return "Couldn't add the file to Git"
  if (label === "Rolling back file") return "Couldn't roll back the file"
  return "Git action failed"
}
