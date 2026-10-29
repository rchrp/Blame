import type { ClineCore, CoreSessionConfig } from "@cline/sdk";
import { updateProjectCloudIgnore } from "./project-cloud-ignore.js";

import { asRecord, errorMessage, stringValue } from "./cline-runtime-events.js";

import { appendProductionConfig } from "./production.js";

import { type ProjectCodePracticesScan } from "./project-code-practices-scan.js";

import {
  projectCodePracticesCorrectionPrompt,
  projectCodePracticesPrompt,
  projectCodePracticesResultSchema,
  resolveProjectCodePracticesResult,
} from "./project-code-practices.js";

import {
  parseProjectInitializationRepairPayload,
  parseProjectInitializationRepairResult,
  projectInitializationRepairResultSchema,
} from "./project-initialization-repair.js";

import type { ProjectInitializationScan } from "./project-initialization.js";

import {
  parseProjectInitializationPayload,
  parseProjectInitializationResult,
  type ProjectInitializationParseOptions,
  projectInitializationCorrectionPrompt,
  projectInitializationPrompt,
  projectInitializationResultSchema,
} from "./project-initialization.js";

import { loadPrompt } from "./prompt-loader.js";

import { reasoningConfig } from "./reasoning.js";

import type {
  AnalyzeProjectCodePracticesInput,
  AnalyzeProjectCodePracticesResult,
  InitializeProjectInput,
  InitializeProjectResult,
  RepairProjectInitializationInput,
} from "./types.js";

export type AgentTool = NonNullable<CoreSessionConfig["extraTools"]>[number];

export type RuntimeSessionSummary = {
  sessionId?: string;
};

export type RuntimeClineResult = {
  result?: Record<string, unknown> & { text?: string };
  sessionId: string;
};

export type InitializationCorrection = {
  previousResult: string;
  validationError: string;
};

type StructuredResultSubmitTool = {
  tool: AgentTool;
  input?: unknown;
};

type ProjectInitializationAttempt = {
  result: unknown;
  sessionId: string;
  submittedInput?: unknown;
};

export type ProjectCodePracticesAttempt = {
  input: unknown;
  sessionId: string;
};

export type CodePracticesAttemptOutcome =
  | { complete: true; result: AnalyzeProjectCodePracticesResult }
  | { complete: false; correction: InitializationCorrection };

export type ProjectInitializationRepairAttempt = {
  result: unknown;
  sessionId: string;
};

export function initializationConfig(
  input: InitializeProjectInput,
  credential: { apiKey: string; baseUrl: string | null },
  tools?: AgentTool[],
  sessionId?: string,
) {
  return appendProductionConfig({
    ...(sessionId ? { sessionId } : {}),
    providerId: input.providerId,
    modelId: input.modelId,
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl ?? undefined,
    ...reasoningConfig(input.reasoningEffort),
    systemPrompt: loadPrompt("project-initialization-system"),
    cwd: input.cwd,
    workspaceRoot: input.workspaceRoot,
    enableTools: true,
    enableSpawnAgent: false,
    enableAgentTeams: false,
    extraTools: tools?.length ? tools : undefined,
    // Room to read a few files and fix rejected submissions in one session.
    maxIterations: 40,
  });
}

export function codePracticesConfig(
  input: AnalyzeProjectCodePracticesInput,
  credential: { apiKey: string; baseUrl: string | null },
  submitTool: AgentTool,
) {
  return appendProductionConfig({
    providerId: input.providerId,
    modelId: input.modelId,
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl ?? undefined,
    ...reasoningConfig(input.reasoningEffort),
    systemPrompt: loadPrompt("project-code-practices-system"),
    cwd: input.cwd,
    workspaceRoot: input.workspaceRoot,
    enableTools: true,
    enableSpawnAgent: false,
    enableAgentTeams: false,
    extraTools: [submitTool],
    maxIterations: 4,
  });
}

export function projectCodePracticesSubmitTool(): StructuredResultSubmitTool {
  const submit: StructuredResultSubmitTool = {
    input: undefined,
    tool: {
      name: "submit_project_code_practices",
      description: "Submit the complete project code practice analysis.",
      inputSchema: projectCodePracticesResultSchema,
      lifecycle: { completesRun: true },
      execute(input: unknown) {
        submit.input = input;
        return { accepted: true };
      },
    },
  };
  return submit;
}

export function projectInitializationSubmitTool(): StructuredResultSubmitTool {
  const submit: StructuredResultSubmitTool = {
    input: undefined,
    tool: {
      name: "submit_project_initialization",
      description:
        "Submit the complete Blame project initialization result for validation.",
      inputSchema: projectInitializationResultSchema,
      lifecycle: { completesRun: true },
      execute(input: unknown) {
        submit.input = input;
        return { accepted: true };
      },
    },
  };
  return submit;
}

export function projectInitializationRepairSubmitTool(): StructuredResultSubmitTool {
  const submit: StructuredResultSubmitTool = {
    input: undefined,
    tool: {
      name: "submit_project_initialization_repair",
      description: "Submit the complete project initialization diagnosis.",
      inputSchema: projectInitializationRepairResultSchema,
      lifecycle: { completesRun: true },
      execute(input: unknown) {
        submit.input = input;
        return { accepted: true };
      },
    },
  };
  return submit;
}

export function collectProjectInitializationRepairAttempt(
  session: RuntimeClineResult,
  submitTool: StructuredResultSubmitTool,
): ProjectInitializationRepairAttempt {
  const result =
    submitTool.input ??
    structuredResultInputFromResult(
      session.result,
      "submit_project_initialization_repair",
    ) ??
    session.result?.text;
  if (!result)
    throw new Error(
      "Project initialization repair agent did not return a result",
    );
  return { result, sessionId: session.sessionId };
}

export async function collectProjectInitializationAttempt(
  cline: ClineCore,
  session: RuntimeClineResult,
  submitTool: StructuredResultSubmitTool,
): Promise<ProjectInitializationAttempt> {
  const submittedInput =
    submitTool.input ??
    projectInitializationInputFromResult(session.result) ??
    (await projectInitializationInputFromMessages(cline, session.sessionId));
  const result = submittedInput ?? session.result?.text;
  if (!result)
    throw new Error("Project initialization agent did not return a result");
  return { result, sessionId: session.sessionId, submittedInput };
}

export function parseProjectInitializationAttempt(
  attempt: ProjectInitializationAttempt,
  scan: ProjectInitializationScan,
  input: InitializeProjectInput,
  options: ProjectInitializationParseOptions = {},
) {
  const initialization = attempt.submittedInput
    ? parseProjectInitializationPayload(
        attempt.submittedInput,
        scan,
        input.preferences,
        options,
      )
    : parseProjectInitializationResult(
        String(attempt.result),
        scan,
        input.preferences,
        options,
      );
  return {
    sessionId: attempt.sessionId,
    previewManifest: initialization.previewManifest,
    runConfigurations: initialization.runConfigurations,
    ...(initialization.cloudPreviewIgnore === undefined
      ? {}
      : { cloudPreviewIgnore: initialization.cloudPreviewIgnore }),
  };
}

export async function saveProjectInitialization(
  root: string,
  accepted: ReturnType<typeof parseProjectInitializationAttempt>,
  sessionId: string,
): Promise<InitializeProjectResult> {
  const { cloudPreviewIgnore, ...result } = accepted;
  await updateProjectCloudIgnore(root, cloudPreviewIgnore);
  return { ...result, sessionId };
}

export function parsedCodePracticesAttempt(
  attempt: { input: unknown; sessionId: string },
  scan: ProjectCodePracticesScan,
): AnalyzeProjectCodePracticesResult {
  return {
    sessionId: attempt.sessionId,
    practices: resolveProjectCodePracticesResult(attempt.input, scan.commits),
  };
}

export function parseProjectInitializationRepairAttempt(
  attempt: ProjectInitializationRepairAttempt,
  scan: ProjectInitializationScan,
  input: RepairProjectInitializationInput,
) {
  const repair =
    typeof attempt.result === "string"
      ? parseProjectInitializationRepairResult(
          attempt.result,
          scan,
          input.preferences,
        )
      : parseProjectInitializationRepairPayload(
          attempt.result,
          scan,
          input.preferences,
        );
  return {
    sessionId: attempt.sessionId,
    ...repair,
  };
}

export function initializationCorrection(
  previousResult: unknown,
  error: unknown,
): InitializationCorrection {
  const serializedResult =
    typeof previousResult === "string"
      ? previousResult
      : JSON.stringify(previousResult);
  return {
    previousResult: serializedResult ?? String(previousResult),
    validationError: errorMessage(error),
  };
}

export function combinedTaskBriefing(
  initialTaskBriefing?: string,
  projectMemoryBriefing?: string,
) {
  const briefing = [initialTaskBriefing, projectMemoryBriefing]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return briefing || undefined;
}

async function projectInitializationInputFromMessages(
  cline: ClineCore,
  sessionId: string,
) {
  try {
    return projectInitializationInputFromMessageList(
      await cline.readLiveMessages(sessionId),
    );
  } catch {
    return undefined;
  }
}

function projectInitializationInputFromResult(result: unknown) {
  return structuredResultInputFromResult(
    result,
    "submit_project_initialization",
  );
}

function structuredResultInputFromResult(result: unknown, toolName: string) {
  const payload = asRecord(result);
  const toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];
  for (const call of toolCalls) {
    const record = asRecord(call);
    if (record.name === toolName) {
      return record.input;
    }
  }
  return structuredResultInputFromMessageList(payload.messages, toolName);
}

function projectInitializationInputFromMessageList(value: unknown) {
  return structuredResultInputFromMessageList(
    value,
    "submit_project_initialization",
  );
}

function structuredResultInputFromMessageList(
  value: unknown,
  toolName: string,
) {
  const messages = Array.isArray(value) ? value : asRecord(value).messages;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    const content = asRecord(message).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const input = structuredResultInputFromMessagePart(part, toolName);
      if (input) return input;
    }
  }
  return undefined;
}

function structuredResultInputFromMessagePart(
  value: unknown,
  toolName: string,
) {
  const part = asRecord(value);
  const name =
    stringValue(part.name) ??
    stringValue(part.toolName) ??
    stringValue(asRecord(part.toolCall).name) ??
    stringValue(asRecord(part.toolCall).toolName);
  if (name !== toolName) return undefined;
  return part.input ?? asRecord(part.toolCall).input;
}

export function initializationPrompt(
  scan: ProjectInitializationScan,
  correction?: InitializationCorrection,
  preferences?: InitializeProjectInput["preferences"],
) {
  if (!correction) return projectInitializationPrompt(scan, preferences);
  return projectInitializationCorrectionPrompt(scan, correction, preferences);
}

export function codePracticesPrompt(
  scan: ProjectCodePracticesScan,
  correction?: InitializationCorrection,
) {
  if (!correction) return projectCodePracticesPrompt(scan);
  return projectCodePracticesCorrectionPrompt(scan, correction);
}
