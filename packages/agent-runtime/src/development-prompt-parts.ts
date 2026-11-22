// Pieces of the development system prompts that both agent runtimes use:
// plain text work, no runtime import, so the engine host can load them.

import { loadPrompt } from "./prompt-loader.js";
import type {
  ProjectCodePracticeKey,
  ProjectCodePracticePreference,
} from "./types.js";

export function developmentPracticePrompts(
  practices: ProjectCodePracticePreference[],
) {
  return [
    developmentPracticePrompt(practices, "coding_style"),
    developmentPracticePrompt(practices, "layered_architecture"),
    developmentPracticePrompt(practices, "unit_tests"),
  ].join("\n\n");
}

export function renderPrompt(template: string, values: Record<string, string>) {
  return template.replace(/{{([A-Z_]+)}}/g, (placeholder, key) => {
    return values[key] ?? placeholder;
  });
}

export function developmentPracticePrompt(
  practices: ProjectCodePracticePreference[],
  practice: ProjectCodePracticeKey,
) {
  const enabled = practices.find((item) => item.practice === practice)?.enabled;
  if (practice === "unit_tests" && enabled === undefined) return "";
  if (practice === "coding_style") {
    return loadPrompt(
      `practices/coding-style/${enabled ? "standard" : "match-codebase"}`,
    );
  }
  if (practice === "layered_architecture") {
    return loadPrompt(
      `practices/architecture/${enabled ? "standard" : "match-codebase"}`,
    );
  }
  if (practice === "commit_message_convention") {
    return loadPrompt(
      `practices/commit-message/${enabled ? "standard" : "match-codebase"}`,
    );
  }
  return loadPrompt(
    `practices/unit-tests/${enabled ? "standard" : "disabled"}`,
  );
}

// Story ids (US-012) named in a request, at most eight, in order.
export function referencedStories(text: string) {
  const ids = Array.from(
    text.matchAll(/\bUS-0*(\d{1,6})\b/giu),
    (match) => `US-${match[1]!.padStart(3, "0")}`,
  );
  return Array.from(new Set(ids)).slice(0, 8);
}

// Stories this one builds on (attached with Use Context, or named as
// "Builds on US-042" by stories written before) are read first; others it
// merely names are left to the agent's judgement.
export function earlierStoriesHint(text: string, contextStories: string[]) {
  const dependencies = startsAfterIds(text);
  // The stories it starts after are told in the message already: they are
  // not "mentioned" a second time.
  text = withoutStartsAfter(text);
  const basis = referencedStories(
    [
      ...Array.from(
        text.matchAll(/\bbuilds on\s+(US-\d+)/giu),
        (match) => match[1],
      ),
      ...contextStories,
    ].join(" "),
  );
  const others = referencedStories(text).filter((id) => !basis.includes(id));
  return (
    [
      dependencies.length
        ? dependencies.length === 1
          ? `This story starts after ${dependencies[0]}, which is done: what it delivered is above. read_user_story loads more of it (discussion, activity) when that helps.`
          : `This story starts after ${dependencies.join(", ")}, which are done: what they delivered is above. read_user_story loads more of them (discussion, activity) when that helps.`
        : undefined,
      basis.length
        ? `This story builds on ${basis.join(", ")}: start by reading ${basis.length === 1 ? "it" : "them"} with read_user_story (request, outcome and changed files; ask for discussion or activity only if needed).`
        : undefined,
      others.length
        ? `Earlier stories mentioned: ${others.join(", ")}. read_user_story loads what was done in them when that context helps.`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n") || undefined
  );
}

/** What a story that was done before this one started delivered. */
export type StartsAfterReport = {
  storyNumber: number;
  title: string;
  /** What its agent last reported (the summary it finished with). */
  reply?: string;
  /** The files it changed, one per line (`M\tpath`). */
  files?: string[];
};

const startsAfterOpen = "<starts_after>";
const startsAfterClose = "</starts_after>";
const startsAfterBlock = /<starts_after>[\s\S]*?<\/starts_after>/u;
// The whole block stays under this, whatever the stories delivered.
const startsAfterLimit = 6_000;

/**
 * What the stories a story starts after delivered, for its first message:
 * for each, its number and title, what its agent last reported and the
 * files it changed, shorter the more stories there are. A story with
 * nothing to report adds nothing; undefined when none has.
 */
export function startsAfterBriefing(reports: readonly StartsAfterReport[]) {
  const told = reports.filter(
    (report) => report.reply?.trim() || report.files?.length,
  );
  if (!told.length) return undefined;
  const replyLimit = told.length <= 2 ? 800 : told.length <= 4 ? 500 : 400;
  const fileLimit = Math.min(15, Math.max(4, Math.floor(30 / told.length)));
  const sections = told.map((report) => {
    const reply = clipText(report.reply ?? "", replyLimit);
    const files = (report.files ?? []).map((file) => clipText(file, 140));
    return [
      `${storyReference(report.storyNumber)} · ${clipText(report.title.replace(/\s+/gu, " "), 120)}`,
      ...(reply ? ["Reported:", reply] : []),
      ...(files.length
        ? [
            "Changed files:",
            ...files.slice(0, fileLimit),
            ...(files.length > fileLimit
              ? [`… ${files.length - fileLimit} more`]
              : []),
          ]
        : []),
    ].join("\n");
  });
  const text = [
    `This story starts after ${told.length === 1 ? "a story that is" : "stories that are"} done and merged into its branch. What ${told.length === 1 ? "it" : "they"} delivered:`,
    ...sections,
  ].join("\n\n");
  return [
    startsAfterOpen,
    clipText(text, startsAfterLimit),
    startsAfterClose,
  ].join("\n");
}

function startsAfterIds(text: string) {
  const block = startsAfterBlock.exec(text)?.[0] ?? "";
  return Array.from(
    block.matchAll(/^US-0*(\d{1,6}) · /gmu),
    (match) => `US-${match[1]!.padStart(3, "0")}`,
  );
}

function withoutStartsAfter(text: string) {
  return text.replace(startsAfterBlock, "");
}

function storyReference(storyNumber: number) {
  return `US-${String(storyNumber).padStart(3, "0")}`;
}

function clipText(value: string, limit: number) {
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}
