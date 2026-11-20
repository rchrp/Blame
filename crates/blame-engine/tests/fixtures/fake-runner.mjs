// A stand-in for semantic-harness-runner.js --serve: the same JSON-lines
// protocol, with tools whose behaviour the engine's tests choose. Every
// message it gets is appended to the log file given as its first argument.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const log = process.argv[2];
const note = (value) => appendFileSync(log, `${JSON.stringify(value)}\n`);
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
// A 1x1 PNG.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

note({ started: process.pid });
write({ ready: true, protocol: 1 });
const slow = new Map();
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  note(message);
  const { id } = message;
  if (message.cancel) {
    if (slow.has(id)) {
      slow.delete(id);
      write({ id, error: "Semantic workspace operation cancelled." });
    }
    continue;
  }
  if (message.describe) {
    const session = message.describe.taskContract?.session_id;
    const object = { type: "object", properties: {}, additionalProperties: true };
    write({
      id,
      tools: [
        { name: "read_code", description: `Reads code for ${session}.`, inputSchema: object, effect: "read_only", endsTurn: false },
        { name: "edit_code", description: "Edits code.", inputSchema: object, effect: "workspace_write", endsTurn: false },
        { name: "crash", description: "Kills the harness.", inputSchema: object, effect: "command", endsTurn: false },
        { name: "slow", description: "Never ends.", inputSchema: object, effect: "command", endsTurn: false },
        { name: "finish_task", description: "Finishes.", inputSchema: object, effect: "command", endsTurn: true },
      ],
    });
    continue;
  }
  const call = message.call;
  switch (call?.tool) {
    case "read_code":
      write({ id, presented: { ok: true, content: [
        { type: "text", text: JSON.stringify({ format: "blame_tool_result_v2", result: { status: "ok" } }) },
        { type: "image", data: png, mediaType: "image/png" },
      ] } });
      break;
    case "edit_code":
      writeFileSync(join(call.workspaceRoot, call.input.path), call.input.text);
      write({ id, presented: { ok: true, content: JSON.stringify({ status: "ok" }) } });
      break;
    case "crash":
      process.exit(3);
      break;
    case "slow":
      slow.set(id, true);
      break;
    case "finish_task":
      write({ id, presented: { ok: true, content: `Done: ${call.input.summary}` } });
      break;
    default:
      write({ id, error: `no tool ${call?.tool}` });
  }
}
note({ stopped: process.pid });
