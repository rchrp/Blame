// A new project scaffolded in its empty folder from the wizard's brief: the
// agent runs the framework's CLI and writes files with the harness, and may
// look things up on the web. It ends with the engine's `submit_new_project`
// (a summary); `finish_task` is left out because it would run the project's
// checks, and dependencies are installed by Blame afterwards.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPrompt } from "../../prompt-loader.js";
import { webResearchGuidance } from "../../web-research-calls.js";
import type { GenerateNewProjectTask } from "../task-protocol.js";
import { submitTool, taskConfig, type TaskSpec } from "../tasks/runner.js";
import { quickChatClientTools } from "./quick-chat.js";
import type { ToolSpec } from "@blame/engine-client";

export const NEW_PROJECT_TOOL = "submit_new_project";

export function newProjectGenerationTask(
  input: GenerateNewProjectTask,
  clientTools: (names: readonly string[]) => ToolSpec[],
): TaskSpec<{ summary: string }> {
  return {
    config: taskConfig({
      purpose: "new-project-generation",
      model: input.model,
      systemPrompt:
        loadPrompt("new-project-generation-system") + webResearchGuidance,
      workspace: input.workspace,
      engineTools: ["harness"],
      clientTools: clientTools(quickChatClientTools),
      toolOptions: {
        harness: {
          taskContract: {
            environment: { isolated: false, managedPreview: false },
            effect_requirement: "none",
          },
        },
      },
      contract: {
        result: submitTool(
          NEW_PROJECT_TOOL,
          "Finish with a concise summary of the scaffolded files, dependency manifests and any caveats.",
          {
            type: "object",
            additionalProperties: false,
            required: ["summary"],
            properties: { summary: { type: "string", minLength: 1 } },
          },
        ),
        allowed: [
          "search_code",
          "read_code",
          "edit_code",
          "run_task",
          ...quickChatClientTools,
        ],
        max_corrections: 2,
      },
      limits: { max_requests_per_turn: 40, max_turn_ms: 30 * 60_000 },
    }),
    instruction: newProjectGenerationPrompt(input),
    result: (value) => ({
      summary: String((value as { summary?: unknown }).summary ?? "").trim(),
    }),
  };
}

export function newProjectGenerationPrompt(input: GenerateNewProjectTask) {
  const authRequested = input.configuration.advancedOptions.includes("auth");
  return [
    `Generate a new Blame project named ${input.projectName}.`,
    "",
    "The current working directory is already the empty target project directory. Initialize the codebase in this directory; do not create a nested project folder unless the selected architecture explicitly needs sub-app folders such as apps/web.",
    "",
    "Scope constraints:",
    "- Initialize the selected framework starter with canonical CLI commands whenever possible.",
    "- Keep the generated app close to the default framework starter.",
    "- Do not create a custom homepage, dashboard, demo feature, CRUD flow, domain model, mock data, or marketing content.",
    "- Do not add authentication, users, sessions, protected routes, or authorization unless auth is requested.",
    authRequested
      ? "- Auth is requested: add only the smallest working auth scaffold appropriate for the selected stack."
      : "- Auth is not requested: do not add auth-related dependencies, screens, routes, schemas, or services.",
    "- Add only files required by selected advanced options.",
    "- Do not downgrade or upgrade framework versions after the CLI creates the starter.",
    "- Keep framework config file extensions compatible with the installed framework version.",
    "- Do not chase build, lint, peer dependency, or framework warnings during project creation.",
    "- Stop after scaffolding and final required file writes. Blame installs dependencies after you finish.",
    "- After all scaffold commands, create or update the root .gitignore without replacing existing entries. It must exclude dependencies, framework build output, Blame runtime artifacts, and runtime .env files while keeping .env templates trackable.",
    "",
    "Wizard brief (normalized JSON):",
    JSON.stringify(
      {
        projectName: input.projectName,
        targetPath: input.workspace.root,
        configuration: input.configuration,
      },
      null,
      2,
    ),
    "",
    "Compatibility and recommendation rules:",
    "- Treat this normalized wizard configuration as the user's source of intent.",
    "- Respect frontend/backend/database/ORM/UI compatibility implied by the selected values.",
    "- If an exact combination has no mature canonical integration, choose the smallest coherent starter and document the trade-off in README.md.",
    "- Advanced options are explicit requirements when present: monorepo, auth, unitTests, e2eTests, githubActions, envExample, readme, typescriptAlias, standardScripts.",
    "- Ignore docker, dockerCompose, and blamePreview during project creation because Blame handles them during initialization.",
    "- Blame will generate setup and Docker Compose preview artifacts after creation through a separate initialization agent.",
    "- Do not create .blame/setup.sh, setup.sh, docker-compose.yml, compose.yml, or Blame preview metadata.",
    "",
    "Blame readiness requirements:",
    "- Make dependency installation non-interactive and reproducible.",
    "- Provide scripts named dev and build; also lint/test when requested or when quality/test options require them.",
    "- Provide .env.example, README.md, tests, GitHub Actions, aliases, and auth only when requested.",
    "- Avoid blocking prompts; pass non-interactive flags or create files manually when CLIs are interactive.",
    "- Do not use sudo and do not require global installs.",
    "",
    "Verification before completion:",
    "- Blame installs dependencies using the selected package manager/runtime after you finish. Use scaffold skip-install flags when available; do not run a separate install or approve-builds command.",
    "- Declare the selected package manager in package.json. For a monorepo, create a root workspace manifest.",
    "- Do not run build, lint, test, dev servers, preview commands, or long-running processes.",
    "- Read and finalize the root .gitignore after commands have completed.",
    "- Fix only errors that prevent the framework starter from being created or dependencies from being installable.",
    `- Finish by calling ${NEW_PROJECT_TOOL} with a concise summary of scaffolded files, dependency manifests, and any caveats.`,
  ].join("\n");
}

/** Why the generated folder is not a project Blame can install, if it is not. */
export async function generatedProjectReadinessError(root: string) {
  for (const path of [
    join(root, "package.json"),
    join(root, "apps", "web", "package.json"),
  ]) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    try {
      const manifest = JSON.parse(text) as {
        scripts?: Record<string, unknown>;
      };
      const missing = ["dev", "build"].filter(
        (name) => typeof manifest.scripts?.[name] !== "string",
      );
      return missing.length
        ? `Generated package.json is missing required scripts: ${missing.join(", ")}.`
        : undefined;
    } catch {
      return "Project generation agent created an invalid package.json.";
    }
  }
  return "Project generation agent completed without creating a package.json.";
}
