// A title for a quick chat or a user story, and for a story the run
// configuration that best exercises it. No tools: the engine's
// `submit_title` is the only call the model may make, and its answer is the
// task's result.

import { loadPrompt } from "../../prompt-loader.js";
import type { GenerateTitleTask } from "../task-protocol.js";
import {
  resultObject,
  submitTool,
  taskConfig,
  type TaskSpec,
} from "../tasks/runner.js";

export const TITLE_TOOL = "submit_title";
const MAX_WORDS = 6;
const MAX_LENGTH = 80;

export type GeneratedTitle = {
  title: string;
  runConfigurationId?: string | null;
};

export function titleTask(input: GenerateTitleTask): TaskSpec<GeneratedTitle> {
  if (!input.prompt.trim()) throw new Error("Title generation needs a prompt.");
  const configurations = runConfigurations(input);
  const picksConfiguration =
    input.context === "user-story" && input.runConfigurations !== undefined;
  return {
    config: taskConfig({
      purpose: "title",
      model: input.model,
      systemPrompt: loadPrompt("title-generator-system"),
      workspace: input.workspace,
      contract: {
        result: submitTool(
          TITLE_TOOL,
          "Give the title (at most 6 words)" +
            (picksConfiguration
              ? " and the id of the run configuration that best exercises the story, or null when none fits."
              : "."),
          titleSchema(
            picksConfiguration ? configurations.map(({ id }) => id) : undefined,
          ),
        ),
        allowed: [],
        max_corrections: 2,
      },
      limits: { max_requests_per_turn: 4, max_turn_ms: 120_000 },
      maxOutputTokens: 2_000,
    }),
    instruction: titleInstruction(input, configurations),
    result: (value) => titleResult(value, picksConfiguration),
  };
}

function titleSchema(configurationIds: string[] | undefined) {
  return {
    type: "object",
    additionalProperties: false,
    required: configurationIds ? ["title", "runConfigurationId"] : ["title"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: MAX_LENGTH },
      ...(configurationIds
        ? {
            runConfigurationId: {
              anyOf: [{ enum: configurationIds }, { type: "null" }],
            },
          }
        : {}),
    },
  };
}

function titleInstruction(
  input: GenerateTitleTask,
  configurations: ReturnType<typeof runConfigurations>,
) {
  const label =
    input.context === "quick-chat"
      ? "Quick chat request"
      : "User story content";
  return [
    `${label}:`,
    input.prompt.trim(),
    ...(configurations.length
      ? ["Available run configurations:", JSON.stringify(configurations)]
      : []),
  ].join("\n");
}

function runConfigurations(input: GenerateTitleTask) {
  if (input.context !== "user-story") return [];
  return (input.runConfigurations ?? []).map((configuration) => ({
    id: configuration.id,
    name: configuration.name,
    category: configuration.category,
    cwd: configuration.cwd,
    services: configuration.services,
    scopes: configuration.scopes,
    previewService: configuration.previewService,
  }));
}

/**
 * The title as the app shows it: one line, no Markdown, at most six words.
 * A title that is scaffolding (tags, JSON, a transcript line: the model
 * wrote a tool call as text) is refused.
 */
export function titleResult(
  value: unknown,
  picksConfiguration: boolean,
): GeneratedTitle {
  const result = resultObject(value);
  const title = cleanTitle(String(result.title ?? ""));
  if (!title) throw new Error("The title generator did not return a title.");
  if (!picksConfiguration) return { title };
  const id = result.runConfigurationId;
  return { title, runConfigurationId: typeof id === "string" ? id : null };
}

function cleanTitle(value: string) {
  const line = value
    .split("\n")
    .map((part) =>
      part
        .trim()
        .replace(/^#+\s*/, "")
        .replace(/^[-*]\s*/, "")
        .replace(/^["'`]+|["'`]+$/g, "")
        .replace(/[.!?:;]+$/g, "")
        .trim(),
    )
    .find(Boolean);
  if (!line || /<[/!?]?[a-z_]|[{}]|^\[|[─-╿]/iu.test(line)) return "";
  return line.split(/\s+/).slice(0, MAX_WORDS).join(" ");
}
