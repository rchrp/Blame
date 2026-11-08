import type { CommitMessageRuntimeInput } from "./cline-runtime-configuration.js";

export function fallbackCommitSubject(title: string, files: string[]) {
  const subject = commitSubjectFromTitle(title);
  return subject ?? fallbackChangedFilesSubject(files);
}

function commitSubjectFromTitle(title: string) {
  const subject = title
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*[.!?]+$/g, "")
    .trim();
  if (!subject) return undefined;
  return subject.charAt(0).toLowerCase() + subject.slice(1);
}

function fallbackChangedFilesSubject(files: string[]) {
  if (
    files.length &&
    files.every((file) => /\.(test|spec)\.[jt]sx?$/.test(file))
  )
    return "cover backlog item";
  if (files.length && files.every((file) => /\.(md|mdx|txt)$/.test(file)))
    return "document backlog item";
  return "complete backlog item";
}

export function commitMessagePaths(input: CommitMessageRuntimeInput) {
  if (!("selectedPaths" in input)) return ["."];
  const paths = input.selectedPaths?.filter(Boolean) ?? [];
  return paths.length ? paths : ["."];
}

// Builds a message from `git status --porcelain` and recent commit subjects.
export function fallbackCommitMessageFromStatus(
  input: CommitMessageRuntimeInput,
  status: string,
  log: string,
) {
  const files = statusFileNames(status);
  const standardConvention = commitMessageConventionEnabled(input);
  const subject = fallbackCommitSubject(
    input.title || "selected changes",
    files,
  );
  const bracketPrefix = dominantBracketPrefix(log);
  if (!standardConvention && bracketPrefix) {
    return limitCommitMessage(`${bracketPrefix} ${subject}`);
  }
  const scope = commitScope(files);
  const type = commitType(files);
  return limitCommitMessage(`${type}${scope ? `(${scope})` : ""}: ${subject}`);
}

function commitMessageConventionEnabled(input: CommitMessageRuntimeInput) {
  return (
    input.codePractices?.find(
      (item) => item.practice === "commit_message_convention",
    )?.enabled ?? false
  );
}

function dominantBracketPrefix(log: string) {
  const prefixes = log
    .split("\n")
    .map((line) => line.match(/^(\[[^\]]+\])/)?.[1])
    .filter(isString);
  const counts = new Map<string, number>();
  prefixes.forEach((prefix) =>
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1),
  );
  return [...counts.entries()].find(([, count]) => count >= 2)?.[0];
}

function statusFileNames(status: string) {
  return status.split("\n").map(statusFileName).filter(isString);
}

function statusFileName(line: string) {
  const file = line.slice(3).trim();
  return file.includes(" -> ") ? file.split(" -> ").at(-1) : file;
}

function commitScope(files: string[]) {
  const firstFile = files.find(Boolean);
  if (!firstFile) return undefined;
  const parts = firstFile.split("/");
  if (parts[0] === "packages" && parts[1]) return parts[1];
  if (parts[0] === "src" && parts[1]) return parts[1];
  return parts[0]?.replace(/\.[^.]+$/g, "");
}

function commitType(files: string[]) {
  if (
    files.length &&
    files.every((file) => /\.(test|spec)\.[jt]sx?$/.test(file))
  )
    return "test";
  if (files.length && files.every((file) => /\.(md|mdx|txt)$/.test(file)))
    return "docs";
  if (files.some((file) => /(^|\/)(package\.json|pnpm-lock\.yaml)$/.test(file)))
    return "build";
  return "fix";
}

function limitCommitMessage(message: string) {
  return message.length <= 74
    ? message
    : message.slice(0, 74).replace(/\s+\S*$/, "");
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
