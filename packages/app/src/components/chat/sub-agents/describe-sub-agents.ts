import { list, record } from "../tool-calls/tool-call-values.ts"
import type {
  ToolCallSource,
  ToolCallView,
} from "../tool-calls/tool-call-view.ts"

// A `run_agents` call as an ordinary step: while its input streams, and when
// the engine refused it (ultra mode off, no such role). Once helpers run, the
// conversation shows their card instead.
export function describeSubAgents(source: ToolCallSource): ToolCallView {
  const count = list(record(source.input).agents).length
  // A refused call answers with the reason, as text.
  const refusal =
    typeof source.output === "string" && !source.running
      ? source.output
      : undefined
  return {
    family: "agent",
    verb: refusal ? "Did not start" : source.running ? "Starting" : "Ran",
    target: {
      text: count
        ? `${count} helper ${count === 1 ? "agent" : "agents"}`
        : "helper agents",
    },
    chips: [],
    bodies: refusal ? [{ type: "text", text: refusal }] : [],
    failed: false,
  }
}
