// Turns the output of a failed command into the lines that explain it:
// terminal colors, boxes, code frames, stack frames, progress and Compose's
// own container chatter go; what a tool printed as its error stays.

const noiseLines = [
  // Only box drawing, rules or blanks.
  /^[\s│┃║╭╮╰╯─━═┌┐└┘|]*$/u,
  // A code frame: "17 ┃    PORT: Env.schema.number(),".
  /^\s*[❯>]?\s*\d+\s*[┃│|]/u,
  // Stack frames, plain or decorated.
  /^\s*(?:[⁃>-]\s*)?at\s+\S/u,
  // Compose and image pulls.
  /^\s*(?:Container|Network|Volume)\s+\S+\s+(?:Creating|Created|Starting|Started|Stopping|Stopped|Waiting|Healthy|Removing|Removed|Recreate|Recreated|Running)\s*$/u,
  /^\s*(?:Image\s+\S+\s+(?:Pulling|Pulled)|[0-9a-f]{12}\s+(?:Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists))\b/u,
  // Package manager progress and Corepack's activation notice.
  /^\s*Progress: resolved\b/u,
  /^\s*Preparing \S+ for immediate activation/u,
  /^\s*[+-]{8,}\s*$/u,
  // A bare "undefined" some CLIs print next to their error.
  /^\s*undefined\s*$/u,
];

export function readableCommandOutput(raw: string) {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of stripTerminalCodes(raw).split("\n")) {
    if (noiseLines.some((pattern) => pattern.test(line))) continue;
    const text = line
      .replace(/[╭╮╰╯─━═┌┐└┘│┃║]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
  }
  return lines.join("\n");
}

// The last lines that report an error, or the last lines at all. Compose
// prints a container's stdout and stderr apart, so errors are not always last.
export function errorExcerpt(raw: string, maxLines = 4) {
  const lines = readableCommandOutput(
    raw.replace(/^\S+-\d+\s*\|\s?/gmu, ""),
  ).split("\n");
  const errors = lines.filter((line) =>
    /\b(?:error|failed|fatal|cannot|exception|uninstall)\b|\bERR_|^×/iu.test(
      line,
    ),
  );
  return (errors.length ? errors : lines)
    .slice(-maxLines)
    .join(" ")
    .slice(0, 500);
}

export function stripTerminalCodes(raw: string) {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b[@-_]/g, "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      // What a carriage return left visible on each line.
      .map((line) => line.split("\r").at(-1) ?? "")
      .join("\n")
  );
}
