import assert from "node:assert/strict"
import test from "node:test"

import { gitActionFailure, gitErrorReason } from "./git-error.ts"

test("a failed commit shows Git's reason, not the IPC wrapper or the command", () => {
  const message = [
    "Error invoking remote method 'workspace:git-commit': Error: Command failed: git commit --no-gpg-sign -m chore: adjust scaffold-tmp file mode",
    "On branch main",
    "Changes not staged for commit:",
    '  (use "git add <file>..." to update what will be committed)',
    "\tmodified:   scaffold-tmp (modified content)",
    "",
    'no changes added to commit (use "git add" and/or "git commit -a")',
  ].join("\n")
  assert.equal(
    gitErrorReason(message),
    [
      "On branch main",
      "Changes not staged for commit:",
      "modified:   scaffold-tmp (modified content)",
      'no changes added to commit (use "git add" and/or "git commit -a")',
    ].join("\n")
  )
  assert.equal(gitActionFailure("Committing"), "Couldn't commit")
})

test("a failure without Git output keeps its message", () => {
  assert.equal(
    gitErrorReason(
      "Error invoking remote method 'workspace:git-commit': Error: Commit message is required"
    ),
    "Commit message is required"
  )
  assert.equal(
    gitErrorReason("Command failed: git push"),
    "Command failed: git push"
  )
})
