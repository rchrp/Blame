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
