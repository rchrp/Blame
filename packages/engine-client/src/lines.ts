/**
 * Cuts a stream of text chunks into lines. A line can arrive in any number of
 * chunks (a base64 blob is megabytes), so partial lines are kept as pieces
 * and joined once, not re-concatenated per chunk.
 */
export class LineSplitter {
  private pieces: string[] = [];

  /** Feeds a chunk and returns the lines it completed. */
  push(chunk: string): string[] {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const end = chunk.indexOf("\n", start);
      if (end === -1) break;
      this.pieces.push(chunk.slice(start, end));
      lines.push(stripCarriageReturn(this.pieces.join("")));
      this.pieces = [];
      start = end + 1;
    }
    if (start < chunk.length) this.pieces.push(chunk.slice(start));
    return lines;
  }

  /** What is left when the stream ends without a final newline. */
  flush(): string | undefined {
    if (this.pieces.length === 0) return undefined;
    const rest = stripCarriageReturn(this.pieces.join(""));
    this.pieces = [];
    return rest;
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
