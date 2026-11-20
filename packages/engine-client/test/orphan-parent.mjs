// Starts the fake engine through the client, prints the engine's pid, then
// either waits to be killed or, when told, exits without shutting it down.
import { EngineClient } from "../dist/index.js"
import { fakeEnginePath } from "../dist/test-support.js"

await EngineClient.start(
  {
    command: process.execPath,
    args: [fakeEnginePath],
    env: { ...process.env },
  },
  {
    clientName: "orphan-parent",
    clientVersion: "0",
    onLog: ({ text }) => {
      console.log(text)
    },
  },
)
// Stay alive until the test kills us, or until it closes our stdin.
process.stdin.resume()
process.stdin.on("end", () => process.exit(0))
