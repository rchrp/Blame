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
