import assert from "node:assert/strict"
import test from "node:test"
import { terminalText } from "./terminal-text.ts"

test("terminal text drops escape sequences and overwritten text", () => {
  assert.equal(
    terminalText(
      "\u001b]2;user@host:~/app\u0007\u001b[1m\u001b[33mBuild\u001b[0m ok\r\n" +
        "50%\r100%\r\n\u001b[?2004hdone"
    ),
    "Build ok\n100%\ndone"
  )
})

test("a move back to the first column overwrites the line", () => {
  assert.equal(
    terminalText(
      "\u28d9\u001b[1G\u001b[0K\u28b9\u001b[1G\u001b[0Kadded 12 packages\n"
    ),
    "added 12 packages\n"
  )
})
