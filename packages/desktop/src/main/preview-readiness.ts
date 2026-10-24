import { createHash } from "node:crypto";

export function previewComposeProjectName(worktree: string) {
  return `blame_${createHash("sha1").update(worktree).digest("hex").slice(0, 12)}`;
}

const previewLogNoise = [
  /^Preparing \S+ for immediate activation/,
  /^> \S+@\S+ \S+/,
  /^> /,
  /^(?:\S+\s+)?ELIFECYCLE\b/,
  /^npm (?:ERR!|error) (?:code|path|command|errno|signal|A complete log)/,
  /^error Command failed with exit code/,
  /^info Visit https:\/\/yarnpkg\.com/,
  /^time="[^"]*" level=/,
];

// Keeps the last lines a failed preview printed, without Compose prefixes or
// package manager boilerplate, so the error says why the container stopped.
export function previewFailureLogExcerpt(logs: string, maxLines = 3) {
  const lines = logs
    .split(/\r?\n/)
    .map((line) => line.replace(/^\S+-\d+\s*\|\s?/, "").trim())
    .filter(Boolean)
    .filter((line) => !previewLogNoise.some((pattern) => pattern.test(line)));
  const excerpt = lines.slice(-maxLines).join(" ");
  return excerpt.length > 400 ? `${excerpt.slice(0, 399)}…` : excerpt;
}
