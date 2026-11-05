import type { ClineCore } from "@cline/sdk";

import { loadPrompt } from "./prompt-loader.js";
import { appendProductionConfig } from "./production.js";
import { reasoningConfig } from "./reasoning.js";
import type { GenerateTitleInput, GenerateTitleResult } from "./types.js";

type TitleGenerationCredential = {
  apiKey: string;
  baseUrl: string | null;
};

export async function generateTitle(
  input: GenerateTitleInput,
  cline: ClineCore,
  credential: TitleGenerationCredential,
): Promise<GenerateTitleResult> {
  const session = await cline.start({
    prompt: titleGenerationUserPrompt(input),
    config: titleGenerationConfig(input, credential),
    interactive: false,
    source: `blame-${input.context}-title-generator`,
  });
  const generated = generatedTitle(session.result?.text, input);
  if (!generated)
    throw new Error("Title generator agent did not return a title.");
  return { sessionId: session.sessionId, ...generated };
}

function titleGenerationConfig(
  input: GenerateTitleInput,
  credential: TitleGenerationCredential,
) {
  return appendProductionConfig({
    providerId: input.providerId,
    modelId: input.modelId,
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl ?? undefined,
    ...reasoningConfig(input.reasoningEffort),
    systemPrompt: loadPrompt("title-generator-system"),
    cwd: input.cwd,
    workspaceRoot: input.workspaceRoot,
    enableTools: false,
    enableSpawnAgent: false,
    enableAgentTeams: false,
    maxIterations: 2,
  });
}

function titleGenerationUserPrompt(input: GenerateTitleInput) {
  const contentLabel =
    input.context === "quick-chat"
      ? "Quick chat request"
      : "User story content";
  const configurations = titleRunConfigurations(input);
  return [
    `${contentLabel}:`,
    input.prompt.trim(),
    ...(configurations.length
      ? ["Available run configurations:", JSON.stringify(configurations)]
      : []),
  ].join("\n");
}

function titleRunConfigurations(input: GenerateTitleInput) {
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

export function generatedTitle(
  value: unknown,
  input: Pick<GenerateTitleInput, "runConfigurations"> = {},
) {
  const parsed = generatedTitlePayload(value);
  const candidate = titleCandidate(parsed.title);
  if (!candidate || modelScaffolding(candidate)) return undefined;
  const runConfigurationId = validRunConfigurationId(
    parsed.runConfigurationId,
    input.runConfigurations,
  );
  return {
    title: candidate.split(/\s+/).slice(0, 6).join(" "),
    ...(input.runConfigurations
      ? { runConfigurationId: runConfigurationId ?? null }
      : runConfigurationId
        ? { runConfigurationId }
        : {}),
  };
}

function generatedTitlePayload(value: unknown) {
  const text = stringValue(value)?.trim();
  if (!text) return {};
  const candidate = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { title: text };
    }
    const record = parsed as Record<string, unknown>;
    return {
      title: record.title,
      runConfigurationId: record.runConfigurationId,
    };
  } catch {
    return { title: text };
  }
}

function validRunConfigurationId(
  value: unknown,
  configurations: GenerateTitleInput["runConfigurations"],
) {
  if (typeof value !== "string") return undefined;
  return configurations?.some(({ id }) => id === value) ? value : undefined;
}

function titleCandidate(value: unknown) {
  return stringValue(value)
    ?.trim()
    .replace(/^```(?:text|markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^#+\s*/, "")
        .replace(/^[-*]\s*/, "")
        .replace(/^["'`]+|["'`]+$/g, "")
        .replace(/[.!?:;]+$/g, "")
        .trim(),
    )
    .find(Boolean);
}

/**
 * Tags, JSON or a transcript line instead of a title: the model tried to carry
 * out the request (for example it wrote a tool call as text).
 */
function modelScaffolding(title: string) {
  return /<[/!?]?[a-z_]|[{}]|^\[|[─-╿]/iu.test(title);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
