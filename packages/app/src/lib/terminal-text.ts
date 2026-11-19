// Turns raw terminal output into readable text: drops escape sequences
// (colors, cursor moves, window titles) and keeps what a carriage return
// left visible on each line. A move back to the first column (npm's
// spinner) counts as a carriage return.
export function terminalText(raw: string) {
  const text = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[01]?G/g, "\r")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r\n/g, "\n")
  return text
    .split("\n")
    .map((line) => {
      const parts = line.split("\r")
      return parts[parts.length - 1] ?? ""
    })
    .join("\n")
}

const escape = "\u001b"
const bell = "\u0007"

// terminalText for output that arrives in chunks, each read once: the
// lines it gives followed by its tail are terminalText of all the output so
// far, wherever the chunks were cut.
//
// A line is final once a newline ends it, unless a window title opened
// before it is still open (it may hold newlines, and its end would remove
// them). Of the line being written, only what follows its second-to-last
// carriage return is kept: what came before is overwritten for good.
export class TerminalTextStream {
  // The output not final yet: the line being written.
  private pending = ""
  // Whether it holds a newline, inside a window title left open.
  private holdsNewline = false
  // Where its carriage returns have been looked for, and the ends of the
  // last two found.
  private searched = 0
  private returns: number[] = []
  private formattedTail?: string

  // The lines this chunk completed.
  push(chunk: string) {
    const start = this.pending.length
    this.pending += chunk
    this.formattedTail = undefined
    const lines = this.takeLines(chunk, start)
    // Until the title ends, the line keeps all its output.
    if (!this.holdsNewline) this.dropOverwritten()
    return lines
  }

  // The line being written, as terminalText shows it.
  get tail() {
    this.formattedTail ??= terminalText(this.pending)
    return this.formattedTail
  }

  private takeLines(chunk: string, start: number) {
    for (let index = chunk.lastIndexOf("\n"); index >= 0;) {
      const end = start + index
      if (!titleOpen(this.pending, end)) {
        const text = terminalText(this.pending.slice(0, end + 1))
        this.pending = this.pending.slice(end + 1)
        this.holdsNewline = this.pending.includes("\n")
        this.searched = 0
        this.returns = []
        return text.split("\n").slice(0, -1)
      }
      this.holdsNewline = true
      index = index === 0 ? -1 : chunk.lastIndexOf("\n", index - 1)
    }
    return []
  }

  private dropOverwritten() {
    const text = this.pending
    // A move to the first column may have been cut between two chunks.
    for (let at = Math.max(0, this.searched - 3); at < text.length; at += 1) {
      const end =
        text[at] === "\r"
          ? at + 1
          : text[at] === escape
            ? firstColumnEnd(text, at)
            : undefined
      if (end === undefined || end <= (this.returns.at(-1) ?? 0)) continue
      if (!titleOpen(text, end - 1))
        this.returns = [this.returns.at(-1) ?? 0, end]
      at = end - 1
    }
    this.searched = text.length
    const cut = this.returns.length === 2 ? this.returns[0]! : 0
    if (!cut) return
    this.pending = text.slice(cut)
    this.searched -= cut
    this.returns = [this.returns[1]! - cut]
  }
}

// Whether a window title (ESC ] … BEL or ESC \) started before end is still
// open at end, as terminalText reads it: after its moves to the first
// column became carriage returns.
function titleOpen(text: string, end: number) {
  let at = text.lastIndexOf(escape, end)
  while (at >= 0 && firstColumnEnd(text, at) !== undefined)
    at = at === 0 ? -1 : text.lastIndexOf(escape, at - 1)
  if (at < 0 || text[at + 1] !== "]") return false
  const closed = text.indexOf(bell, at)
  return closed === -1 || closed > end
}

// Where a move to the first column (ESC [ G, ESC [ 0 G, ESC [ 1 G) that
// starts at `at` ends.
function firstColumnEnd(text: string, at: number) {
  if (text[at + 1] !== "[") return undefined
  if (text[at + 2] === "G") return at + 3
  if ((text[at + 2] === "0" || text[at + 2] === "1") && text[at + 3] === "G")
    return at + 4
  return undefined
}
