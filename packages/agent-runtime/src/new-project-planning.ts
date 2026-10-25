import { randomUUID } from "node:crypto";
import type { ClineCore, CoreSessionConfig } from "@cline/sdk";
import {
  legacyDirectWorkspaceTools,
  readTools,
  writeTools,
} from "./cline-tool-policy.js";
import { appendProductionConfig, assertWorkspacePath } from "./production.js";
import { loadPrompt } from "./prompt-loader.js";
import { reasoningConfig } from "./reasoning.js";
import type { PlanningHost } from "./planning-host.js";
import type { PlanNewProjectInput, PlanNewProjectResult } from "./types.js";
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

type Reply = Omit<PlanNewProjectResult, "sessionId">;
type Credential = {
  apiKey: string;
  baseUrl: string | null;
  authMethod?: string;
};
export const newProjectPlanningSubmitToolName = "submit_project_stack";

export async function runNewProjectPlanning(
  input: PlanNewProjectInput,
  host: PlanningHost,
) {
  assertWorkspacePath(input.cwd, input.workspaceRoot, "cwd");
  const credential = await host.credential(input);
  const core = await host.core(input.backend);
  const sessionId = input.sessionId || `project_plan_${randomUUID()}`;
  await host.subscribe(sessionId, input.backend);
  try {
    return await host.telemetry.runOperation(
      input,
      "new_project_planning",
      () => planNewProject(input, core, credential, sessionId),
      credential.authMethod,
    );
  } finally {
    await host.unsubscribe(sessionId).catch(() => undefined);
  }
}

export async function planNewProject(
  input: PlanNewProjectInput,
  core: ClineCore,
  credential: Credential,
  sessionId: string,
): Promise<PlanNewProjectResult> {
  if (
    !input.messages.length ||
    input.messages.at(-1)?.role !== "user" ||
    !input.messages.at(-1)?.text.trim()
  )
    throw new Error(
      "Describe your project before asking the agent to choose a stack.",
    );
  let submitted: Reply | undefined;
  const submit: NonNullable<CoreSessionConfig["extraTools"]>[number] = {
    name: newProjectPlanningSubmitToolName,
    description:
      "Reply to the person. Ask focused questions with configuration null, or propose a complete compatible stack. Call exactly once, last.",
    inputSchema: projectPlanReplySchema(),
    lifecycle: { completesRun: true },
    execute(value: unknown) {
      submitted = projectPlanReply(value);
      return { accepted: true, ready: Boolean(submitted.configuration) };
    },
  };
  const session = (await core.start({
    prompt: newProjectPlanningPrompt(input),
    config: appendProductionConfig({
      sessionId,
      providerId: input.providerId,
      modelId: input.modelId,
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl ?? undefined,
      ...reasoningConfig(input.reasoningEffort),
      systemPrompt: loadPrompt("new-project-planner-system"),
      cwd: input.cwd,
      workspaceRoot: input.workspaceRoot,
      enableTools: true,
      enableSpawnAgent: false,
      enableAgentTeams: false,
      extraTools: [submit],
      maxIterations: 8,
    }),
    interactive: false,
    source: "blame-new-project-planning",
    toolPolicies: newProjectPlanningToolPolicies(),
  })) as { sessionId?: string; result?: { text?: unknown } };
  const fallback =
    typeof session.result?.text === "string" ? session.result.text.trim() : "";
  if (!submitted && !fallback)
    throw new Error(
      "The project planning agent did not reply. Please try again.",
    );
  return {
    sessionId: session.sessionId ?? sessionId,
    ...(submitted ?? { message: fallback }),
  };
}

export function newProjectPlanningToolPolicies() {
  return Object.fromEntries([
    ...[
      ...readTools,
      ...writeTools,
      ...legacyDirectWorkspaceTools,
      "ask_question",
      "skills",
    ].map((name) => [name, { enabled: false, autoApprove: false }]),
    [newProjectPlanningSubmitToolName, { enabled: true, autoApprove: true }],
  ]);
}

export function projectPlanReply(value: unknown): Reply {
  if (!value || typeof value !== "object")
    throw new Error("Invalid project planning reply.");
  const reply = value as Record<string, unknown>;
  if (typeof reply.message !== "string" || !reply.message.trim())
    throw new Error("The project planning agent did not explain its proposal.");
  return {
    message: reply.message.trim(),
    ...(reply.configuration == null
      ? {}
      : { configuration: parseNewProjectConfiguration(reply.configuration) }),
    ...(typeof reply.notes === "string" && reply.notes.trim()
      ? { notes: reply.notes.trim().slice(0, 3000) }
      : {}),
  };
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

export function newProjectPlanningPrompt(input: PlanNewProjectInput) {
  // Retain the original brief and the latest turns. Notes carry resolved requirements.
  const messages = input.messages;
  const recent: typeof messages = [];
  let length = 0;
  for (const message of messages.slice(1).reverse()) {
    const size = JSON.stringify(message).length;
    if (length + size > 24000 && recent.length) break;
    recent.unshift(message);
    length += size;
  }
  return JSON.stringify({
    projectName: input.projectName,
    availableStack: configurationCatalog(),
    notes: input.notes?.slice(0, 3000),
    messages: [messages[0], ...recent],
  });
}

function projectPlanReplySchema() {
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
      message: {
        type: "string",
        description:
          "Questions or a concise explanation of the proposed stack, in the person's language.",
      },
      notes: {
        type: "string",
        description:
          "Compact project brief and resolved requirements for the next turn.",
      },
      configuration: {
        anyOf: [
          { type: "null" },
          {
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
        ],
      },
    },
    required: ["message", "configuration", "notes"],
    additionalProperties: false,
  };
}
