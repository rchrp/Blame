import type { AgentTool } from "./cline-initialization.js";
import {
  advancedOptionLabels,
  backendOptions,
  databaseOptions,
  defaultNewProjectConfiguration,
  frontendOptions,
  newProjectConfigurationChoices,
  ormOptions,
  packageManagerOptions,
  parseNewProjectConfiguration,
  requiresTailwind,
  uiLibraryOptions,
} from "./new-project-options.js";

// The new-project assistant is a regular agent conversation. It proposes a
// stack from Blame's catalog with this tool; the app shows the proposal as
// the same summary as the manual wizard.

export const projectStackProposalToolName = "propose_project_stack";

export function projectStackProposalTool(): AgentTool {
  return {
    name: projectStackProposalToolName,
    description:
      "Propose the complete stack for the new project, using only the catalog in your instructions. The person reviews it in the wizard summary before the project is created. Call it again with the full configuration to revise it. An invalid choice returns an error that names it.",
    inputSchema: projectStackSchema(),
    execute(value: unknown) {
      const configuration = parseNewProjectConfiguration(
        recordValue(value).configuration,
      );
      return { accepted: true, configuration };
    },
  };
}

/** The catalog the assistant must choose from, for its system prompt. */
export function newProjectStackCatalogPrompt(projectName?: string) {
  return [
    projectName?.trim()
      ? `<project_name>${projectName.trim()}</project_name>`
      : "",
    `<available_stack>\n${JSON.stringify(configurationCatalog())}\n</available_stack>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const values = (options: { value: string; disabled?: boolean }[]) =>
  options
    .filter(
      (option) =>
        !option.disabled || (options.length === 1 && option.value === "none"),
    )
    .map((option) => option.value);

function configurationCatalog() {
  const defaults = newProjectConfigurationChoices(
    defaultNewProjectConfiguration,
  );
  return {
    platform: values(defaults.platform),
    frontend: frontendOptions.map(({ value, label, description }) => ({
      value,
      label,
      description,
      uiLibrary: values(uiLibraryOptions(value)),
      backend: values(backendOptions(value)),
    })),
    styling: values(defaults.styling),
    tailwindRequiredFor: [
      ...new Set(
        frontendOptions.flatMap(({ value }) => values(uiLibraryOptions(value))),
      ),
    ].filter((value) =>
      requiresTailwind(value as Parameters<typeof requiresTailwind>[0]),
    ),
    database: values(databaseOptions),
    backend: [
      ...new Set(
        frontendOptions.flatMap(({ value }) => values(backendOptions(value))),
      ),
    ].map((backend) => ({
      value: backend,
      packageManager: values(
        packageManagerOptions(
          backend as Parameters<typeof packageManagerOptions>[0],
        ),
      ),
      ormByDatabase: Object.fromEntries(
        databaseOptions.map(({ value }) => [
          value,
          values(
            ormOptions(backend as Parameters<typeof ormOptions>[0], value),
          ),
        ]),
      ),
    })),
    codeQuality: values(defaults.codeQuality),
    advancedOptions: advancedOptionLabels,
  };
}

function projectStackSchema() {
  const defaults = newProjectConfigurationChoices(
    defaultNewProjectConfiguration,
  );
  const all = frontendOptions.flatMap(({ value: frontend }) =>
    backendOptions(frontend).flatMap(({ value: backend }) =>
      databaseOptions.map(({ value: database }) =>
        newProjectConfigurationChoices({
          ...defaultNewProjectConfiguration,
          frontend,
          backend,
          database,
        }),
      ),
    ),
  );
  const properties = Object.fromEntries(
    Object.keys(defaults).map((key) => [
      key,
      {
        type: "string",
        enum: [
          ...new Set(
            all.flatMap((choices) =>
              values(choices[key as keyof typeof defaults]),
            ),
          ),
        ],
      },
    ]),
  );
  return {
    type: "object",
    properties: {
      configuration: {
        type: "object",
        properties: {
          ...properties,
          advancedOptions: {
            type: "array",
            items: {
              type: "string",
              enum: Object.keys(advancedOptionLabels),
            },
          },
        },
        required: [...Object.keys(properties), "advancedOptions"],
        additionalProperties: false,
      },
    },
    required: ["configuration"],
    additionalProperties: false,
  };
}
