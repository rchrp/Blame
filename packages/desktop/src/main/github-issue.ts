import { redactSecuritySecrets } from "@blame/agent-runtime/security-secret-redaction";

// Problems are reported as GitHub issues that people review, edit and submit
// themselves: Blame only opens a pre-filled page in their browser.

const newIssueUrl = "https://github.com/rchrp/Blame/issues/new";
// GitHub turns away URLs past about 8 KB.
const maximumUrlLength = 6_000;
const maximumTitleLength = 120;
const maximumErrorLength = 4_000;

export type IssueReport = {
  error: string;
  title: string;
};

export type IssueEnvironment = {
  arch: string;
  home: string;
  os: string;
  version: string;
};

export function parseIssueReport(value: unknown): IssueReport {
  const report = value as Partial<IssueReport> | null;
  if (
    !report ||
    typeof report.title !== "string" ||
    typeof report.error !== "string"
  ) {
    throw new Error("Invalid issue report");
  }
  return { error: report.error, title: report.title };
}

export function githubIssueUrl(
  report: IssueReport,
  environment: IssueEnvironment,
) {
  const title = shareableText(report.title, environment.home).slice(
    0,
    maximumTitleLength,
  );
  const error = shareableText(report.error, environment.home);
  let length = Math.min(error.length, maximumErrorLength);
  for (;;) {
    const shown =
      length < error.length ? `${error.slice(0, length)}\n[truncated]` : error;
    const url = `${newIssueUrl}?${new URLSearchParams({
      body: issueBody(shown, environment),
      title,
    })}`;
    if (url.length <= maximumUrlLength || length === 0) return url;
    length = Math.floor(length * 0.8);
  }
}

// Paths show the home folder as ~ and anything shaped like a secret is masked.
function shareableText(text: string, home: string) {
  return redactSecuritySecrets(withoutHome(text, home)).trim();
}

function withoutHome(text: string, home: string) {
  if (!home) return text;
  return [home, home.replaceAll("\\", "/")].reduce(
    (current, path) =>
      current.replace(
        new RegExp(`${escapeRegExp(path)}(?=$|[\\\\/\\s"'\`:;,)\\]}])`, "gi"),
        "~",
      ),
    text,
  );
}

function issueBody(error: string, environment: IssueEnvironment) {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(error) + 1));
  return [
    "**What were you doing when this happened?**",
    "",
    "",
    "**Error**",
    "",
    fence,
    error,
    fence,
    "",
    "**Environment**",
    "",
    `- Blame ${environment.version}`,
    `- ${environment.os}`,
    `- ${environment.arch}`,
  ].join("\n");
}

function longestBacktickRun(text: string) {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
