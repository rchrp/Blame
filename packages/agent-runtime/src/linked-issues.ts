import { githubRepository } from "./pull-request.js";

// A commit whose message says `Closes #N` shows in issue N's timeline, and
// GitHub closes the issue once that commit reaches the default branch.
//
// A story closes an issue the way GitHub reads one: a closing word, then the
// issue, as in "Fixes #12" or "Traite la GitHub issue [59](url)". An issue the
// story only mentions, such as one it leaves out of scope, stays open.

export type LinkedIssueStory = { title?: string; summary?: string };

const issueUrl = String.raw`https?:\/\/(?:www\.)?github\.com\/([\w-]+)\/([\w.-]+)\/issues\/(\d+)(?!\d)`;
// A Markdown link to an issue, a bare issue URL, or #N / owner/repo#N.
const issueReference = new RegExp(
  [
    String.raw`\[[^\]\n]*\]\(\s*<?${issueUrl}[^)\n]*\)`,
    issueUrl,
    String.raw`(?<![\w/&#])(?:([\w-]+)\/([\w.-]+))?#(\d+)(?!\d)`,
  ].join("|"),
  "giu",
);
const closingKeyword = String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;
// GitHub's keywords, and the French words the backlog's stories use.
const closingWord = new RegExp(
  String.raw`^(?:${closingKeyword}|traite|corrige|r[ée]sout|ferme):?$`,
  "iu",
);
const negation = /^(?:ne|pas|jamais|not|never|.+n['’]t)$/iu;
// Room for "la GitHub issue" or "the GitHub issue", not another sentence.
const maxFillerWords = 4;
const closingLine = new RegExp(
  String.raw`^${closingKeyword}:?\s+\S*#\d+$`,
  "iu",
);

// Issues of the origin repository the story closes, in number order.
// None when origin is missing or not on github.com.
export function linkedIssueNumbers(
  story: LinkedIssueStory,
  originUrl: string | undefined,
) {
  const repository = originRepository(originUrl);
  return repository ? storyIssues(story, repository) : [];
}

// The message with a `Closes #N` line for each linked issue it doesn't
// already close, after a blank line or appended to its own closing lines.
export function withLinkedIssueTrailers(
  message: string,
  story: LinkedIssueStory,
  originUrl: string | undefined,
) {
  const repository = originRepository(originUrl);
  if (!repository) return message;
  const missing = storyIssues(story, repository).filter(
    (issue) => !closesIssue(message, repository, issue),
  );
  if (!missing.length) return message;
  const body = message.trimEnd();
  const separator = endsWithClosingLines(body) ? "\n" : "\n\n";
  const trailers = missing.map((issue) => `Closes #${issue}`);
  return `${body}${separator}${trailers.join("\n")}`;
}

function originRepository(originUrl: string | undefined) {
  return originUrl ? githubRepository(originUrl)?.toLowerCase() : undefined;
}

function storyIssues(story: LinkedIssueStory, repository: string) {
  const numbers = new Set<number>();
  for (const text of [story.title ?? "", story.summary ?? ""]) {
    let leadStart = 0;
    for (const match of text.matchAll(issueReference)) {
      // Each reference needs its own closing word, as on GitHub.
      const lead = text.slice(leadStart, match.index);
      leadStart = match.index + match[0].length;
      const issue = referencedIssue(match, repository);
      if (issue && followsClosingWord(lead)) numbers.add(issue);
    }
  }
  return [...numbers].sort((left, right) => left - right);
}

// The issue of the origin repository a reference names, if it names one.
function referencedIssue(match: RegExpMatchArray, repository: string) {
  const [owner, name, number] = match[1]
    ? match.slice(1, 4)
    : match[4]
      ? match.slice(4, 7)
      : match.slice(7, 10);
  const own =
    owner === undefined || `${owner}/${name}`.toLowerCase() === repository;
  return own && Number(number) ? Number(number) : undefined;
}

// Whether the text before a reference ends with a closing word, then at most
// a few filler words, in the same sentence and not negated.
function followsClosingWord(lead: string) {
  const words = lead
    .slice(lead.lastIndexOf("\n") + 1)
    .split(/\s+/u)
    .map(bareWord)
    .filter(Boolean);
  let fillers = 0;
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index] ?? "";
    if (closingWord.test(word)) return !negation.test(words[index - 1] ?? "");
    if (
      /[.;:!?]/u.test(word) ||
      negation.test(word) ||
      ++fillers > maxFillerWords
    )
      return false;
  }
  return false;
}

// A word without the brackets, quotes or dashes around it. A sentence break
// stays: "issue." still ends a sentence.
function bareWord(word: string) {
  return word.replace(/^[^\p{L}\p{N}.;:!?]+|[^\p{L}\p{N}.;:!?]+$/gu, "");
}

// `Closes #N` or `Fixes owner/repo#N`, with any of GitHub's closing keywords.
function closesIssue(message: string, repository: string, issue: number) {
  const ownRepository = repository.replace(/[$()*+.?[\\\]^{|}]/gu, "\\$&");
  return new RegExp(
    String.raw`\b${closingKeyword}:?\s+(?:${ownRepository})?#${issue}(?!\d)`,
    "iu",
  ).test(message);
}

function endsWithClosingLines(message: string) {
  const paragraphs = message.split(/\n\s*\n/u);
  return (
    paragraphs.length > 1 &&
    (paragraphs.at(-1) ?? "")
      .split("\n")
      .every((line) => closingLine.test(line.trim()))
  );
}
