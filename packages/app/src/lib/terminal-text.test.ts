import assert from "node:assert/strict"
import test from "node:test"
import { runLogEvents, runLogStreams } from "../bench/run-log-streams.ts"
import { TerminalTextStream, terminalText } from "./terminal-text.ts"

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

// Output cut anywhere, even inside an escape sequence, a CRLF or a
// surrogate pair: after each chunk, the stream shows what terminalText
// shows for all the output so far.
function assertStreamMatches(
  raw: string,
  random: () => number,
  maxChunk: number
) {
  const stream = new TerminalTextStream()
  let lines = ""
  let written = 0
  while (written < raw.length) {
    const size = 1 + Math.floor(random() * maxChunk)
    const chunk = raw.slice(written, written + size)
    written += chunk.length
    for (const line of stream.push(chunk)) lines += `${line}\n`
    assert.equal(lines + stream.tail, terminalText(raw.slice(0, written)))
  }
}

test("the stream formats real output as terminalText, wherever it is cut", () => {
  for (const kind of runLogStreams) {
    for (let seed = 1; seed <= 20; seed += 1) {
      const events = runLogEvents(kind, seed)
      let raw = ""
      for (let index = 0; index < 120; index += 1)
        raw += events.next().value as string
      assertStreamMatches(raw, seededRandom(seed), 1 + seed * 20)
    }
  }
})

// Pieces of every sequence terminalText reads, in any order: titles left
// open or closed by BEL or ESC \, moves to the first column, CSI and
// two-character sequences, lone escapes, carriage returns and newlines.
const pieces = [
  "a",
  "line",
  " ",
  "é",
  "🚀",
  "\n",
  "\r",
  "\r\n",
  "\u001b",
  "\u001b[",
  "\u001b[1G",
  "\u001b[0G",
  "\u001b[G",
  "\u001b[2G",
  "\u001b[K",
  "\u001b[2K",
  "\u001b[32m",
  "\u001b[?2004h",
  "\u001b[1A",
  "\u001b]",
  "\u001b]0;title",
  "\u001b]2;a\nb",
  "\u0007",
  "\u001b\\",
  "\u001bM",
  "[",
  "]",
  "0",
  "1",
  "G",
  ";",
  "\\",
]

test("the stream formats any sequence of escapes as terminalText", () => {
  for (let seed = 1; seed <= 3000; seed += 1) {
    const random = seededRandom(seed)
    let raw = ""
    const count = 1 + Math.floor(random() * 60)
    for (let index = 0; index < count; index += 1)
      raw += pieces[Math.floor(random() * pieces.length)]
    assertStreamMatches(raw, random, 1 + Math.floor(random() * 12))
  }
})

test("the stream keeps only the last redraws of a line", () => {
  const stream = new TerminalTextStream()
  const events = runLogEvents("progress", 3)
  let longest = 0
  for (let index = 0; index < 20_000; index += 1) {
    stream.push(events.next().value as string)
    longest = Math.max(longest, stream.tail.length)
  }
  assert.ok(held(stream) < 400, `holds ${held(stream)} characters`)
  assert.ok(longest < 200)
  // Each redraw cut inside its move to the first column.
  const spinner = new TerminalTextStream()
  for (let index = 0; index < 20_000; index += 1) {
    spinner.push("\u001b[1")
    spinner.push(`G\u001b[0K${"⠋⠙⠹⠸"[index % 4]} reify: timing ${index}`)
  }
  assert.ok(held(spinner) < 200, `holds ${held(spinner)} characters`)
})

function held(stream: TerminalTextStream) {
  return (stream as unknown as { pending: string }).pending.length
}

function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
