// The settings of a story's turn (`DevelopmentStorySettings`): its
// workspace, model, preview tools and the project's code practices.

import type { AgentPersonalization } from "../../personalization.js";
import type { PreviewInitialization } from "../../preview-selection.js";
import type {
  ProjectCodePracticePreference,
  ProjectRunConfiguration,
  ReasoningSelection,
} from "../../types.js";
import type { EngineModelChoice, EngineSessionSettings } from "../protocol.js";
import type {
  StoryModel,
  StoryPreferences,
  StoryRequestedModel,
  StoryTurnChoice,
} from "../story-protocol.js";
import type { ProjectInitializationSnapshot } from "./api.js";
import { storyLocation, type HostStory } from "./story.js";

export type StoryTurnInput = {
  story: HostStory;
  projectPath: string;
  snapshot: ProjectInitializationSnapshot;
  model: EngineModelChoice;
  maxContextTokens?: number;
  personalization?: Partial<AgentPersonalization>;
};

export function storySessionSettings(
  input: StoryTurnInput,
): EngineSessionSettings & { purpose: "development-story" } {
  const { story } = input;
  if (!story.worktree) throw new Error("The story has no worktree yet.");
  const workspaceMode = story.workspaceMode ?? "direct";
  const initialization = readyInitialization(input.snapshot);
  const previewDevtoolsScope =
    workspaceMode === "direct"
      ? directStoryPreviewScope(
          initialization?.runConfigurations,
          input.projectPath,
        )
      : `story:${story.id}`;
  return {
    purpose: "development-story",
    settings: {
      workspace: {
        root: story.worktree,
        location: storyLocation(workspaceMode),
      },
      workspaceMode,
      projectId: story.projectId,
      storyId: story.id,
      title: story.title,
      model: input.model,
      ...(input.maxContextTokens
        ? { maxContextTokens: input.maxContextTokens }
        : {}),
      ...(input.personalization
        ? { personalization: input.personalization }
        : {}),
      codePractices: effectiveCodePractices(input.snapshot.practices),
      ...(previewDevtoolsScope ? { previewDevtoolsScope } : {}),
      ...(initialization
        ? {
            projectInitialization: {
              ...initialization,
              ...(story.runConfigurationId
                ? { runConfigurationId: story.runConfigurationId }
                : {}),
            },
          }
        : {}),
    },
  };
}

/** The saved preview environment, when it is one stories can use. */
export function readyInitialization(
  snapshot: ProjectInitializationSnapshot,
): PreviewInitialization | undefined {
  const saved = snapshot.initialization;
  if (saved?.status !== "done" || !saved.previewManifest) return undefined;
  return {
    previewManifest: saved.previewManifest,
    runConfigurations: saved.runConfigurations ?? [],
  };
}

/**
 * The model of a story's turn and its context cap: what the person picked
 * for the turn, else the model the story was created with (first run) or
 * last worked with, else the account's.
 */
export function storyTurnModel(
  story: HostStory,
  preferences: StoryPreferences | undefined,
  choice: StoryTurnChoice | undefined,
  first: boolean,
): { model: EngineModelChoice; maxContextTokens?: number } | undefined {
  const picked: StoryModel | undefined =
    choice?.model ??
    (first && story.requestedModel
      ? requestedChoice(story.requestedModel)
      : undefined) ??
    (first ? undefined : lastModel(story, preferences)) ??
    preferences?.agentModel;
  if (!picked) return undefined;
  const { maxInputTokens, ...model } = picked;
  const maxContextTokens =
    choice?.maxContextTokens ??
    contextCap(preferences?.contextLimits?.[story.id], maxInputTokens);
  return { model, ...(maxContextTokens ? { maxContextTokens } : {}) };
}

/** How the agent talks and works on this story: the account's, with its own ambition. */
export function storyPersonalization(
  story: Pick<HostStory, "ambition">,
  preferences: StoryPreferences | undefined,
  choice?: StoryTurnChoice,
): Partial<AgentPersonalization> | undefined {
  if (choice?.personalization) return choice.personalization;
  const account = preferences?.personalization;
  if (!account && !story.ambition) return undefined;
  return {
    ...account,
    ...(story.ambition ? { ambition: story.ambition } : {}),
  };
}

function requestedChoice(model: StoryRequestedModel): StoryModel {
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(model.credentialLabel
      ? { credentialLabel: model.credentialLabel }
      : {}),
    ...(model.reasoningEffort
      ? { reasoning: model.reasoningEffort as ReasoningSelection }
      : {}),
  };
}

// The story keeps the model of its last turn until the person picks another.
function lastModel(
  story: HostStory,
  preferences: StoryPreferences | undefined,
): StoryModel | undefined {
  const last = story.agentModels?.at(-1);
  if (!last) return undefined;
  const account = preferences?.agentModel;
  const same =
    account?.providerId === last.providerId && account.modelId === last.modelId;
  return {
    providerId: last.providerId,
    modelId: last.modelId,
    ...(same && account.credentialLabel
      ? { credentialLabel: account.credentialLabel }
      : {}),
    ...(last.reasoningEffort
      ? { reasoning: last.reasoningEffort as ReasoningSelection }
      : {}),
    ...(same && account.maxInputTokens
      ? { maxInputTokens: account.maxInputTokens }
      : {}),
  };
}

// The cap sent to the agent: none by default, never above the model's limit.
function contextCap(
  choice: number | undefined,
  modelLimit: number | undefined,
) {
  if (!choice) return undefined;
  return modelLimit ? Math.min(choice, modelLimit) : choice;
}

const defaultCodePractices: ProjectCodePracticePreference[] = [
  { practice: "coding_style", enabled: true },
  { practice: "unit_tests", enabled: false },
  { practice: "layered_architecture", enabled: false },
  { practice: "commit_message_convention", enabled: false },
];

/** The project's code practices, each one its default until the person set it. */
export function effectiveCodePractices(
  practices: readonly ProjectCodePracticePreference[],
) {
  return defaultCodePractices.map(
    (fallback) =>
      practices.find(({ practice }) => practice === fallback.practice) ??
      fallback,
  );
}

// What an agent working in the project folder inspects with its browser
// tools: the project's own app, the page Blame's runner keeps open.
function directStoryPreviewScope(
  configurations: ProjectRunConfiguration[] | undefined,
  projectPath: string,
) {
  const all = configurations ?? [];
  const configuration =
    all.find((item) => item.default && hasPreview(item)) ??
    all.find(hasPreview) ??
    all.find((item) => item.default && hostWindow(item)) ??
    all.find(hostWindow);
  if (!configuration) return undefined;
  return `runner:${projectPath}:${configuration.id ?? "preview"}`;
}

function hasPreview(configuration: ProjectRunConfiguration) {
  return Boolean(
    configuration.previewUrl?.trim() ||
    configuration.previewService ||
    configuration.previewTarget,
  );
}

function hostWindow(configuration: ProjectRunConfiguration) {
  return (
    configuration.category === "desktop" &&
    configuration.services.length === 0 &&
    !configuration.previewService &&
    !configuration.previewTarget
  );
}
