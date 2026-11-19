// Desktop: the full output of each run log the app shows, kept on disk.
// The app keeps the last lines and reads the others back when someone
// scrolls up to them. Every line sent ends with a newline.
export type RunLogsClient = {
  append(id: string, lines: string): void
  // Lines from..to (excluded), counted from the first line sent.
  read(id: string, from: number, to: number): Promise<string[]>
  // Puts before, every line sent, then after on the clipboard. Ending a
  // selection, the lines leave out their last newline, as browsers do.
  copy(
    id: string,
    before: string,
    after: string,
    endsSelection: boolean
  ): Promise<void>
  close(id: string): void
}
