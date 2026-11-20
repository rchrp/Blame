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

// Stories this one builds on ("Builds on US-042", from Use Context) are read
// first; others it merely names are left to the agent's judgement.
// Stories this one builds on (attached with Use Context, or named as
// "Builds on US-042" by stories written before) are read first; others it
// merely names are left to the agent's judgement.
export function earlierStoriesHint(text: string, contextStories: string[]) {
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
